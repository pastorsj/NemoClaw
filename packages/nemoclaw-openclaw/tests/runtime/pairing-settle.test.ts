// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const NONCE = "a".repeat(64);
const SCRIPT = path.join(import.meta.dirname, "../../runtime/device-pairing-settle.sh");
const temporaryDirectories: string[] = [];

type SettlementOptions = {
  readonly config?: boolean | "malformed" | "missing" | "missing-field";
  readonly flag?: string;
  readonly source?: string;
};

function runSettlement({
  config = true,
  flag = "1",
  source = "managed-onboard",
}: SettlementOptions = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-settle-"));
  temporaryDirectories.push(temporaryDirectory);
  if (config !== "missing") {
    const contents =
      config === "malformed"
        ? "{not-json\n"
        : JSON.stringify({
            gateway: {
              controlUi: config === "missing-field" ? {} : { dangerouslyDisableDeviceAuth: config },
            },
          });
    fs.writeFileSync(path.join(temporaryDirectory, "openclaw.json"), contents);
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    OPENCLAW_STATE_DIR: temporaryDirectory,
  };
  if (flag !== "missing") environment.NEMOCLAW_DISABLE_DEVICE_AUTH = flag;
  if (source !== "missing") environment.NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE = source;
  return spawnSync("/bin/sh", [SCRIPT, NONCE], {
    encoding: "utf8",
    env: environment,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw package device-pairing settlement", () => {
  it.each(["managed-onboard", "operator"])(
    "settles intentional no-auth state declared by %s",
    (source) => {
      const result = runSettlement({ source });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`__NEMOCLAW_DEVICE_PAIRING_SETTLED__=${NONCE}\n`);
    },
  );

  it.each([
    { name: "missing opt-out flag", options: { flag: "missing" } },
    { name: "enabled auth with disabled config", options: { flag: "0" } },
    { name: "unknown opt-out flag", options: { flag: "true" } },
    { name: "missing provenance", options: { source: "missing" } },
    { name: "unknown provenance", options: { source: "untrusted" } },
    { name: "enabled native config", options: { config: false } },
    { name: "missing native config", options: { config: "missing" as const } },
    { name: "malformed native config", options: { config: "malformed" as const } },
    { name: "incomplete native config", options: { config: "missing-field" as const } },
  ])("fails closed for $name", ({ options }) => {
    const result = runSettlement(options);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("__NEMOCLAW_DEVICE_PAIRING_SETTLED__=");
  });

  it("still rejects an invalid core nonce before the no-pairing path", () => {
    const result = spawnSync("/bin/sh", [SCRIPT, "not-a-core-nonce"], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});
