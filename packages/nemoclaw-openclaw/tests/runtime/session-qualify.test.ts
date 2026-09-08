// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCanonicalCliPairingFixture } from "../helpers/pair-settlement";

const NONCE = "a".repeat(64);
const SCRIPT = path.join(import.meta.dirname, "../../runtime/session-qualify.py");
const temporaryDirectories: string[] = [];

function runQualification(modify?: (document: Record<string, unknown>) => void) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-qualify-"));
  temporaryDirectories.push(temporaryDirectory);
  const stateDirectory = path.join(temporaryDirectory, "state");
  const pairedDevice = createCanonicalCliPairingFixture(stateDirectory);
  const document: Record<string, unknown> = { paired: [pairedDevice], pending: [] };
  modify?.(document);
  const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(document))}\n`,
    { mode: 0o755 },
  );
  return spawnSync("python3", [SCRIPT, NONCE], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_DISABLE_DEVICE_AUTH: "0",
      OPENCLAW_BIN: fakeOpenClaw,
      OPENCLAW_STATE_DIR: stateDirectory,
    },
  });
}

type DisabledQualificationOptions = {
  readonly config?: boolean | "malformed" | "missing" | "missing-field";
  readonly flag?: string;
  readonly source?: string;
};

function runDisabledQualification({
  config = true,
  flag = "1",
  source = "managed-onboard",
}: DisabledQualificationOptions = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-no-auth-"));
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
    ...process.env,
    OPENCLAW_BIN: "/does/not/exist",
    OPENCLAW_STATE_DIR: temporaryDirectory,
  };
  if (flag === "missing") delete environment.NEMOCLAW_DISABLE_DEVICE_AUTH;
  else environment.NEMOCLAW_DISABLE_DEVICE_AUTH = flag;
  if (source === "missing") delete environment.NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE;
  else environment.NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE = source;
  return spawnSync("python3", [SCRIPT, NONCE], {
    encoding: "utf8",
    env: environment,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw package session qualification", () => {
  it.each(["managed-onboard", "operator"])(
    "returns a stable no-credential observation declared by %s",
    (source) => {
      const result = runDisabledQualification({ source });
      const expectedDigest = createHash("sha256")
        .update(JSON.stringify({ deviceAuth: "disabled", optOutSource: source }))
        .digest("hex");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:${expectedDigest}\n`);
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
    const result = runDisabledQualification(options);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("__NEMOCLAW_SESSION_QUALIFIED__=");
  });

  it("returns one stable credential-free digest for the canonical CLI session", () => {
    const result = runQualification();

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(
      new RegExp(`^__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:[a-f0-9]{64}$`, "u"),
    );
    expect(result.stdout).not.toContain("operator.read");
    expect(result.stdout).not.toContain("publicKey");
  });

  it("rejects a pending request for the canonical CLI identity", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      document.pending = [{ requestId: "still-pending", deviceId: paired[0]?.deviceId }];
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects an under-scoped paired credential", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], approvedScopes: ["operator.pairing"] };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
