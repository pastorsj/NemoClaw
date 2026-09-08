// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCanonicalCliPairingFixture,
  createCanonicalCliPublicPairingFixture,
} from "../helpers/pair-settlement";

const NONCE = "a".repeat(64);
const SCRIPT = path.join(import.meta.dirname, "../../runtime/session-qualify.py");
const temporaryDirectories: string[] = [];

function runQualification(
  modify?: (document: Record<string, unknown>) => void,
  fixture: "public" | "legacy" = "public",
) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-qualify-"));
  temporaryDirectories.push(temporaryDirectory);
  const stateDirectory = path.join(temporaryDirectory, "state");
  const pairedDevice =
    fixture === "public"
      ? createCanonicalCliPublicPairingFixture(stateDirectory)
      : createCanonicalCliPairingFixture(stateDirectory);
  const document: Record<string, unknown> = { paired: [pairedDevice], pending: [] };
  modify?.(document);
  const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/bin/sh
[ "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT:-}" = "1" ] || exit 41
[ -z "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING+x}" ] || exit 42
[ -z "\${NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING+x}" ] || exit 43
[ -z "\${NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL+x}" ] || exit 44
[ -z "\${OPENCLAW_GATEWAY_URL+x}" ] || exit 44
[ -z "\${OPENCLAW_GATEWAY_PORT+x}" ] || exit 45
[ -z "\${OPENCLAW_GATEWAY_TOKEN+x}" ] || exit 46
[ -z "\${OPENCLAW_GATEWAY_PASSWORD+x}" ] || exit 47
[ "\${HOME:-}" = /sandbox ] || exit 48
[ "\${OPENCLAW_HOME:-}" = /sandbox ] || exit 49
[ "\${OPENCLAW_STATE_DIR:-}" = /sandbox/.openclaw ] || exit 50
[ "\${OPENCLAW_CONFIG_PATH:-}" = /sandbox/.openclaw/openclaw.json ] || exit 51
[ "\${OPENCLAW_OAUTH_DIR:-}" = /sandbox/.openclaw/credentials ] || exit 52
printf '%s\\n' ${JSON.stringify(JSON.stringify(document))}
`,
    { mode: 0o755 },
  );
  return spawnSync("python3", [SCRIPT, NONCE], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: "/root",
      OPENCLAW_BIN: fakeOpenClaw,
      OPENCLAW_HOME: "/untrusted/home",
      OPENCLAW_STATE_DIR: stateDirectory,
      OPENCLAW_CONFIG_PATH: "/untrusted/config.json",
      OPENCLAW_OAUTH_DIR: "/untrusted/oauth",
      OPENCLAW_GATEWAY_URL: "ws://untrusted.invalid",
      OPENCLAW_GATEWAY_PORT: "1",
      OPENCLAW_GATEWAY_TOKEN: "untrusted-token",
      OPENCLAW_GATEWAY_PASSWORD: "untrusted-password",
      NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
      NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
      NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT: "untrusted",
      NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL: "1",
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw package session qualification", () => {
  it.each(["public", "legacy"] as const)(
    "returns one stable credential-free digest for the %s canonical CLI envelope",
    (fixture) => {
      const result = runQualification(undefined, fixture);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(
        new RegExp(`^__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:[a-f0-9]{64}$`, "u"),
      );
      expect(result.stdout).not.toContain("operator.read");
      expect(result.stdout).not.toContain("publicKey");
    },
  );

  it("rejects a pending request for the canonical CLI identity", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      document.pending = [{ requestId: "still-pending", deviceId: paired[0]?.deviceId }];
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects a malformed pending-device observation", () => {
    const result = runQualification((document) => {
      document.pending = ["malformed-request"];
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects an under-scoped public paired credential", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], scopes: ["operator.pairing"] };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects a public credential with duplicate operator tokens", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      const tokens = paired[0]?.tokens as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], tokens: [...tokens, { ...tokens[0] }] };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects contradictory approved scopes in a public envelope", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], approvedScopes: ["operator.pairing"] };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["malformed token", ["not-a-token"]],
    ["under-scoped token", [{ role: "operator", scopes: ["operator.pairing"] }]],
    [
      "wrong-role token",
      [
        {
          role: "viewer",
          scopes: ["operator.pairing", "operator.read", "operator.write"],
        },
      ],
    ],
    [
      "revoked token",
      [
        {
          role: "operator",
          scopes: ["operator.pairing", "operator.read", "operator.write"],
          revokedAtMs: 1,
        },
      ],
    ],
  ] as const)("rejects a public envelope with a %s", (_label, tokens) => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], tokens };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("requires approved scopes in the legacy private envelope", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      const { approvedScopes: _approvedScopes, ...withoutApprovedScopes } = paired[0] ?? {};
      paired[0] = withoutApprovedScopes;
    }, "legacy");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
