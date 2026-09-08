// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  autoPairPythonScript,
  localApprovalPolicyPythonScript,
  readOpenClawStartupSource,
  startScriptHeredoc,
} from "../helpers/startup-suite";
import {
  createCanonicalCliPairingFixture,
  createCanonicalCliPublicPairingFixture,
  createLateCliPairingFixture,
} from "../helpers/pair-settlement";

describe("nemoclaw-start auto-pair client whitelisting (#117)", () => {
  const src = readOpenClawStartupSource();

  it("refuses an approval policy helper writable by the current user", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-policy-mode-"));
    const writablePolicy = path.join(tmpDir, "openclaw_device_approval_policy.py");
    fs.writeFileSync(
      writablePolicy,
      [
        "def approval_request_decision(_device):",
        "    return {'allowed': True, 'reason': 'allowlisted', 'client_id': 'evil', 'client_mode': 'cli', 'scopes': set()}",
        "",
        "def gateway_approval_env(source_env=None):",
        "    return dict(source_env or {})",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const autoPairScript = startScriptHeredoc(src, "PYAUTOPAIR").replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(writablePolicy)}`,
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairScript], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: "/bin/false",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("[auto-pair] stage=watcher-execution failed error=RuntimeError");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("approves only known client identities and does not reprocess handled requests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateFile = path.join(tmpDir, "list-count");
    const approveLog = path.join(tmpDir, "approvals.log");
    const envLog = path.join(tmpDir, "env.log");
    const pendingJson = JSON.stringify({
      pending: [
        "not-a-device",
        { requestId: "ok-browser", clientId: "openclaw-control-ui", clientMode: "unknown" },
        { requestId: "ok-browser", clientId: "openclaw-control-ui", clientMode: "unknown" },
        { requestId: "ok-agent-cli", clientId: "cli", clientMode: "cli" },
        { requestId: "ok-webchat", clientId: "other-client", clientMode: "webchat" },
        { requestId: "reject-me", clientId: "evil-client", clientMode: "unknown" },
      ],
      paired: [],
    });
    const pairedJson = JSON.stringify({
      pending: [],
      paired: [
        { clientId: "openclaw-control-ui", clientMode: "webchat" },
        { clientId: "cli", clientMode: "cli" },
      ],
    });
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf 'list:%s:%s:%s:%s\n' "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}" >> ${JSON.stringify(envLog)}
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" -eq 1 ]; then
    printf '%s\n' ${JSON.stringify(pendingJson)}
  else
    printf '%s\n' ${JSON.stringify(pairedJson)}
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  printf 'approve:%s:%s:%s:%s:%s\n' "$3" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" "\${NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL-unset}" >> ${JSON.stringify(envLog)}
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    const autoPairScript = autoPairPythonScript(src);
    try {
      const run = spawnSync("python3", ["-c", autoPairScript], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
          // Cap the slow-mode keepalive (NemoClaw#4263) so the test
          // terminates without waiting out the default 8h deadline.
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "5",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] approved request=ok-browser client=openclaw-control-ui",
      );
      expect(run.stdout).toContain("[auto-pair] approved request=ok-agent-cli client=cli mode=cli");
      expect(run.stdout).toContain("[auto-pair] rejected unknown client=other-client mode=webchat");
      expect(run.stdout).toContain("[auto-pair] rejected unknown client=evil-client mode=unknown");
      expect(run.stdout).not.toContain("entering slow-mode");
      expect(fs.readFileSync(approveLog, "utf-8").trim().split("\n")).toEqual([
        "ok-browser",
        "ok-agent-cli",
      ]);
      const envLogLines = fs.readFileSync(envLog, "utf-8").trim().split("\n");
      expect(envLogLines[0]).toBe("list:ws://127.0.0.1:18789:18789:test-gateway-token:1");
      expect(
        envLogLines
          .filter((line) => line.startsWith("list:"))
          .every((line) => line === "list:ws://127.0.0.1:18789:18789:test-gateway-token:1"),
      ).toBe(true);
      expect(envLogLines).toContain("approve:ok-browser:unset:unset:unset:1");
      expect(envLogLines).toContain("approve:ok-agent-cli:unset:unset:unset:1");
      expect(envLogLines).not.toContain("approve:ok-webchat:unset:unset:unset:1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("OpenClaw one-shot canonical CLI settlement", () => {
  const src = readOpenClawStartupSource();

  it("observes canonical settlement without creating or approving a request", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-once-"));
    const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
    const stateDirectory = path.join(temporaryDirectory, "state");
    const listCountPath = path.join(temporaryDirectory, "list-count");
    const commandLogPath = path.join(temporaryDirectory, "commands.log");
    const canonicalCli = createCanonicalCliPublicPairingFixture(stateDirectory);
    const operatorToken = (canonicalCli.tokens as Array<Record<string, unknown>>)[0];
    const pairingOnly = {
      ...canonicalCli,
      scopes: ["operator.pairing"],
      tokens: [{ ...operatorToken, scopes: ["operator.pairing"] }],
    };
    const pairingOnlyDocument = JSON.stringify({ pending: [], paired: [pairingOnly] });
    const writePendingDocument = JSON.stringify({
      pending: [
        {
          requestId: "canonical-write-upgrade",
          deviceId: canonicalCli.deviceId,
          publicKey: canonicalCli.publicKey,
          platform: canonicalCli.platform,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          silent: false,
          isRepair: true,
        },
      ],
      paired: [pairingOnly],
    });
    const settledDocument = JSON.stringify({ pending: [], paired: [canonicalCli] });

    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-} \${2:-}" = "devices list" ]; then
  count="$(cat ${JSON.stringify(listCountPath)} 2>/dev/null || printf 0)"
  count=$((count + 1))
  printf '%s\n' "$count" > ${JSON.stringify(listCountPath)}
  printf 'list:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT-unset}" >> ${JSON.stringify(commandLogPath)}
  case "$count" in
    1) printf '%s\n' ${JSON.stringify(pairingOnlyDocument)} ;;
    2) printf '%s\n' ${JSON.stringify(writePendingDocument)} ;;
    *) printf '%s\n' ${JSON.stringify(settledDocument)} ;;
  esac
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "gateway call sessions.create" ]; then
  printf 'write:%s\n' "$*" >> ${JSON.stringify(commandLogPath)}
  exit 98
fi
if [ "\${1:-} \${2:-}" = "devices approve" ]; then
  printf 'approve:%s\n' "$*" >> ${JSON.stringify(commandLogPath)}
  exit 98
fi
printf 'unexpected:%s\n' "$*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src), "--once"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenClaw,
          OPENCLAW_STATE_DIR: stateDirectory,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
          OPENCLAW_GATEWAY_PASSWORD: "test-gateway-password",
          NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "10",
          NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "2",
        },
        timeout: 15_000,
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("canonical CLI baseline settled");
      expect(run.stdout).not.toContain("stage=approval attempting");
      expect(fs.readFileSync(commandLogPath, "utf8").trim().split("\n")).toEqual([
        "list:unset:1",
        "list:unset:1",
        "list:unset:1",
      ]);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it.each(["unrelated CLI identity", "malformed pending state"] as const)(
    "does not request write scope for %s",
    (scenario) => {
      const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-auto-pair-once-reject-"),
      );
      const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
      const stateDirectory = path.join(temporaryDirectory, "state");
      const writeLogPath = path.join(temporaryDirectory, "writes.log");
      const canonicalCli = createCanonicalCliPublicPairingFixture(stateDirectory);
      const document =
        scenario === "unrelated CLI identity"
          ? {
              pending: [],
              paired: [
                {
                  ...canonicalCli,
                  deviceId: "unrelated-device",
                  publicKey: "unrelated-public-key",
                },
              ],
            }
          : { pending: ["malformed-request"], paired: [canonicalCli] };

      fs.writeFileSync(
        fakeOpenClaw,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-} \${2:-}" = "devices list" ]; then
  printf '%s\n' ${JSON.stringify(JSON.stringify(document))}
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "gateway call sessions.create" ]; then
  printf '%s\n' "$*" >> ${JSON.stringify(writeLogPath)}
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const run = spawnSync("python3", ["-c", autoPairPythonScript(src), "--once"], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_BIN: fakeOpenClaw,
            OPENCLAW_STATE_DIR: stateDirectory,
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "1",
          },
          timeout: 5000,
        });

        expect(run.status).toBe(1);
        expect(fs.existsSync(writeLogPath)).toBe(false);
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});

describe("OpenClaw startup watcher canonical write request", () => {
  const src = readOpenClawStartupSource();

  it("is the sole owner of the stable request and its bounded approval", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-owner-"));
    const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
    const stateDirectory = path.join(temporaryDirectory, "state");
    const phasePath = path.join(temporaryDirectory, "phase");
    const commandLogPath = path.join(temporaryDirectory, "commands.log");
    const canonicalCli = createCanonicalCliPublicPairingFixture(stateDirectory);
    const operatorToken = (canonicalCli.tokens as Array<Record<string, unknown>>)[0];
    const pairingOnly = {
      ...canonicalCli,
      scopes: ["operator.pairing"],
      tokens: [{ ...operatorToken, scopes: ["operator.pairing"] }],
    };
    const pendingRequest = {
      requestId: "canonical-write-upgrade",
      deviceId: canonicalCli.deviceId,
      publicKey: canonicalCli.publicKey,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.write"],
      isRepair: true,
    };
    fs.writeFileSync(phasePath, "pairing-only");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env bash
set -euo pipefail
phase="$(cat ${JSON.stringify(phasePath)})"
if [ "\${1:-} \${2:-}" = "devices list" ]; then
  printf 'list:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT-unset}" >> ${JSON.stringify(commandLogPath)}
  case "$phase" in
    pairing-only) printf '%s\n' ${JSON.stringify(JSON.stringify({ pending: [], paired: [pairingOnly] }))} ;;
    pending) printf '%s\n' ${JSON.stringify(JSON.stringify({ pending: [pendingRequest], paired: [pairingOnly] }))} ;;
    *) printf '%s\n' ${JSON.stringify(JSON.stringify({ pending: [], paired: [canonicalCli] }))} ;;
  esac
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "gateway call sessions.create" ]; then
  printf 'write:%s:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT-unset}" "$*" >> ${JSON.stringify(commandLogPath)}
  printf pending > ${JSON.stringify(phasePath)}
  printf 'scope upgrade pending approval\n' >&2
  exit 1
fi
if [ "\${1:-} \${2:-}" = "devices approve" ]; then
  printf 'approve:%s:%s\n' "$3" "\${NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL-unset}" >> ${JSON.stringify(commandLogPath)}
  [ "$3" = canonical-write-upgrade ] || exit 97
  printf settled > ${JSON.stringify(phasePath)}
  printf '{}\n'
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src)], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenClaw,
          OPENCLAW_STATE_DIR: stateDirectory,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "0.1",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.1",
          NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status, run.stderr).toBe(0);
      const commands = fs.readFileSync(commandLogPath, "utf8").trim().split("\n");
      expect(commands.filter((line) => line.startsWith("write:"))).toEqual([
        'write:1:unset:gateway call sessions.create --params {"key":"agent:main:nemoclaw-onboard-warmup","agentId":"main"} --json',
      ]);
      expect(commands.filter((line) => line.startsWith("approve:"))).toEqual([
        "approve:canonical-write-upgrade:1",
      ]);
      expect(run.stdout).toContain("canonical CLI baseline settled");
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("nemoclaw-start auto-pair slow-mode keepalive (#4263)", () => {
  const src = readOpenClawStartupSource();

  function buildAutoPairScript(): string {
    return autoPairPythonScript(src);
  }

  it("stays fast through browser pairing and slows only after the canonical CLI baseline", () => {
    const { temporaryDirectory, fakeOpenClawPath, approvalLogPath, stateDirectory } =
      createLateCliPairingFixture("nemoclaw-auto-pair-slow-");
    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenClawPath,
          OPENCLAW_STATE_DIR: stateDirectory,
          // SLOW_INTERVAL > FAST_REENTRY_INTERVAL exposes any regression.
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "5",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "5",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] approved request=browser-pair client=openclaw-control-ui mode=webchat",
      );
      expect(run.stdout).not.toContain("browser pairing converged");
      // The concurrent late wave is handled before the fast-to-slow transition.
      expect(run.stdout).toContain("[auto-pair] approved request=late-cli client=cli mode=cli");
      expect(run.stdout).toContain("[auto-pair] approved request=late-cli-b client=cli mode=cli");
      expect(run.stdout).toContain("watcher deadline reached approvals=3");
      expect(run.stdout).toContain(
        "[auto-pair] canonical CLI baseline settled; entering slow-mode approvals=3",
      );
      expect(run.stdout).toContain("[auto-pair] fast-reentry bumped polls=3 approved=3 mode=fast");
      const approvedAt = run.stdout.indexOf("approved request=late-cli-b");
      const settledAt = run.stdout.indexOf("canonical CLI baseline settled");
      expect(settledAt).toBeGreaterThan(approvedAt);
      expect(fs.readFileSync(approvalLogPath, "utf-8").trim().split("\n")).toEqual([
        "browser-pair",
        "late-cli",
        "late-cli-b",
      ]);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 40_000);

  it("rejects unknown clients in slow-mode keepalive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-slow-evil-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const stateFile = path.join(tmpDir, "list-count");
    const approveLog = path.join(tmpDir, "approvals.log");
    const canonicalCli = createCanonicalCliPairingFixture(stateDir);
    const initialPaired = JSON.stringify({
      pending: [],
      paired: [canonicalCli],
    });
    const evilLate = JSON.stringify({
      pending: [{ requestId: "evil-late", clientId: "evil-client", clientMode: "unknown" }],
      paired: [canonicalCli],
    });

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" -le 5 ]; then
    printf '%s\n' ${JSON.stringify(initialPaired)}
  else
    printf '%s\n' ${JSON.stringify(evilLate)}
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "5",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] canonical CLI baseline settled; entering slow-mode approvals=0",
      );
      expect(run.stdout).toContain("[auto-pair] rejected unknown client=evil-client mode=unknown");
      // Critical: never approved.
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("rejects malformed CLI scope request payloads", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-malformed-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approveLog = path.join(tmpDir, "approvals.log");
    const malformedPending = JSON.stringify({
      pending: [
        {
          requestId: "malformed-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: "operator.write",
        },
      ],
      paired: [],
    });

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(malformedPending)}
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 20_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] rejected malformed scopes client=openclaw-cli mode=cli",
      );
      expect(run.stdout).toContain("watcher deadline reached approvals=0");
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects disallowed CLI admin scope requests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-admin-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const maliciousPolicyDir = path.join(tmpDir, "malicious-policy");
    const approveLog = path.join(tmpDir, "approvals.log");
    const adminPending = JSON.stringify({
      pending: [
        {
          requestId: "admin-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.admin"],
        },
      ],
      paired: [],
    });

    fs.mkdirSync(maliciousPolicyDir);
    fs.writeFileSync(
      path.join(maliciousPolicyDir, "openclaw_device_approval_policy.py"),
      [
        "def approval_request_decision(_device):",
        "    return {'allowed': True, 'reason': 'allowlisted', 'client_id': 'evil', 'client_mode': 'cli', 'scopes': set()}",
        "",
        "def gateway_approval_env(source_env=None):",
        "    return dict(source_env or {})",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(adminPending)}
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_APPROVAL_POLICY_DIR: maliciousPolicyDir,
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 20_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] rejected disallowed scopes=['operator.admin'] client=openclaw-cli mode=cli",
      );
      expect(run.stdout).toContain("watcher deadline reached approvals=0");
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps fast polling when no canonical CLI baseline appears (#10269)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-slow-fastdl-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approveLog = path.join(tmpDir, "approvals.log");
    const emptyResponse = JSON.stringify({ pending: [], paired: [] });

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(emptyResponse)}
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 20_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("entering slow-mode");
      expect(run.stdout).toContain(
        '[auto-pair-status] {"schemaVersion":1,"state":"request-not-produced"}',
      );
      expect(run.stdout).toContain("watcher deadline reached approvals=0");
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps a rejected sticky request in fast mode without approving it (#10269)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-sticky-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approveLog = path.join(tmpDir, "approvals.log");
    const stickyEvilResponse = JSON.stringify({
      pending: [{ requestId: "evil-stuck", clientId: "evil-client", clientMode: "unknown" }],
      paired: [],
    });

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(stickyEvilResponse)}
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 20_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("entering slow-mode");
      expect(run.stdout).toContain("[auto-pair] rejected unknown client=evil-client mode=unknown");
      expect(run.stdout).toContain("watcher deadline reached approvals=0");
      // Unknown client was never approved.
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("bounds the openclaw CLI invocation so a wedged child cannot pin the watcher", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-runto-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
# Sleep longer than the per-invocation timeout to simulate a wedged CLI.
sleep 2
echo '{"pending":[],"paired":[]}'
exit 0
`,
      { mode: 0o755 },
    );

    try {
      // Do NOT monkey-patch time.sleep here: we want real wall-clock
      // semantics so subprocess.run(..., timeout=...) actually fires.
      const watcherSrc = localApprovalPolicyPythonScript(readOpenClawStartupSource());
      const start = Date.now();
      const run = spawnSync("python3", ["-c", watcherSrc], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          // Watcher must finish well before the test timeout while still
          // exercising a genuine subprocess.run timeout.
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "0.05",
          // Deliberately exceeds the total deadline. The watcher must cap the
          // child to its remaining budget rather than honoring all five seconds.
          NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "5",
        },
        timeout: 20_000,
      });
      const elapsedMs = Date.now() - start;
      expect(run.status).toBe(0);
      // The watcher exited via DEADLINE, not via a wedged subprocess.
      expect(run.stdout).toContain("watcher deadline reached approvals=0");
      // Timeout log was emitted for at least one stuck `devices list`.
      expect(run.stdout).toContain("[auto-pair] timeout calling devices list");
      // Sanity: if the timeout didn't fire, the first `sleep 2` would
      // already exceed this cap before the watcher could reach its deadline.
      expect(elapsedMs).toBeLessThan(1_800);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("retries a transient approve timeout instead of permanently handling the requestId", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-aretry-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateFile = path.join(tmpDir, "approve-count");
    const approveLog = path.join(tmpDir, "approvals.log");
    const pendingResponse = JSON.stringify({
      pending: [{ requestId: "flaky-cli", clientId: "openclaw-cli", clientMode: "cli" }],
      paired: [],
    });
    const allPaired = JSON.stringify({
      pending: [],
      paired: [{ clientId: "openclaw-cli", clientMode: "cli" }],
    });

    // The fake openclaw counts how many `devices approve flaky-cli`
    // calls have been made; the first one hangs past the timeout, the
    // second one succeeds. `devices list` returns the pending request
    // until the approve succeeds, then returns paired.
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approveLog)} ]; then
    printf '%s\n' ${JSON.stringify(allPaired)}
  else
    printf '%s\n' ${JSON.stringify(pendingResponse)}
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" = "1" ]; then
    # First call: hang past the per-call timeout to force rc=124.
    sleep 2
    exit 0
  fi
  # Second call: succeed and record the approval.
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const watcherSrc = localApprovalPolicyPythonScript(readOpenClawStartupSource());
      const run = spawnSync("python3", ["-c", watcherSrc], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "3",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "0.05",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.05",
          NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "0.75",
        },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      // Timeout was logged for the first attempt.
      expect(run.stdout).toContain("[auto-pair] timeout calling devices approve");
      // Retry succeeded on the second attempt.
      expect(run.stdout).toContain(
        "[auto-pair] approved request=flaky-cli client=openclaw-cli mode=cli",
      );
      // The approve log records exactly one successful approval (the
      // retry, not the hung first attempt).
      expect(fs.readFileSync(approveLog, "utf-8").trim().split("\n")).toEqual(["flaky-cli"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("retries a non-zero approve failure without counting it as approved or re-arming fast-reentry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-afail-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateFile = path.join(tmpDir, "approve-count");
    const approveLog = path.join(tmpDir, "approvals.log");
    const pendingResponse = JSON.stringify({
      pending: [{ requestId: "retry-cli", clientId: "openclaw-cli", clientMode: "cli" }],
      paired: [],
    });
    const allPaired = JSON.stringify({
      pending: [],
      paired: [{ clientId: "openclaw-cli", clientMode: "cli" }],
    });

    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approveLog)} ]; then
    printf '%s\n' ${JSON.stringify(allPaired)}
  else
    printf '%s\n' ${JSON.stringify(pendingResponse)}
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" = "1" ]; then
    echo "temporary approve failure" >&2
    exit 7
  fi
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", buildAutoPairScript()], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "600",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "1",
        },
        timeout: 20_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] approve failed request=retry-cli: temporary approve failure",
      );
      expect(run.stdout).toContain(
        "[auto-pair] approved request=retry-cli client=openclaw-cli mode=cli",
      );
      expect(run.stdout).toContain("watcher deadline reached approvals=1");
      expect(fs.readFileSync(stateFile, "utf-8").trim()).toBe("2");
      expect(fs.readFileSync(approveLog, "utf-8").trim().split("\n")).toEqual(["retry-cli"]);
      const markerRe = /fast-reentry bumped polls=3 /g;
      expect(run.stdout.match(markerRe)?.length).toBe(1);
      expect(run.stdout).toContain("[auto-pair] fast-reentry bumped polls=3 approved=0 mode=fast");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// NC-2227-01: Legacy migration behavior
