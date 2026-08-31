// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAutoPairPythonScript } from "../helpers/pair-bootstrap";
import { readOpenClawAutoPairSource } from "../helpers/startup";

describe("nemoclaw-start auto-pair diagnostics (#9844)", () => {
  const src = readOpenClawAutoPairSource();

  it("reports the request-creation stage while a valid device list stays empty (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-empty-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
printf '%s\\n' '{"pending":[],"paired":[]}'
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=request-creation waiting reason=no-request");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["top-level array", "[]"],
    ["non-array pending", '{"pending":{},"paired":[]}'],
    ["non-array paired", '{"pending":[],"paired":"device"}'],
    ["null pending", '{"pending":null,"paired":[]}'],
    ["null paired", '{"pending":[],"paired":null}'],
    ["missing pending", '{"paired":[]}'],
    ["missing paired", '{"pending":[]}'],
  ])("rejects a valid JSON response with %s (#9844)", (_name, response) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-shape-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\\n' ${JSON.stringify(response)}
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=listing failed reason=invalid-response");
      expect(fs.existsSync(approvalMarker)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps forced CLI pairing until a validated paired CLI record appears (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-bootstrap-state-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const listCount = path.join(tmpDir, "list-count");
    const listEnv = path.join(tmpDir, "list-env");
    const approveEnv = path.join(tmpDir, "approve-env");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  count=0
  if [ -f ${JSON.stringify(listCount)} ]; then count=$(cat ${JSON.stringify(listCount)}); fi
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(listCount)}
  printf '%s:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING:-}" "\${OPENCLAW_GATEWAY_TOKEN:-}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT:-}" >> ${JSON.stringify(listEnv)}
  if [ "$count" -eq 1 ]; then
    printf '%s\n' '{"pending":null,"paired":[]}'
  elif [ "$count" -eq 2 ]; then
    printf '%s\n' '{"pending":[{"requestId":"request-1","clientId":"cli","clientMode":"cli","role":"operator","roles":["operator"],"scopes":["operator.pairing"]}],"paired":[]}'
  elif [ "$count" -eq 3 ]; then
    printf '%s\n' '{"pending":[],"paired":[{"clientId":"not-cli","clientMode":"cli"}]}'
  else
    printf '%s\n' '{"pending":[],"paired":[{"clientId":"cli","clientMode":"cli"}]}'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  printf '%s:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING:-}" "\${OPENCLAW_GATEWAY_TOKEN:-}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT:-}" >> ${JSON.stringify(approveEnv)}
  touch ${JSON.stringify(approvalMarker)}
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=listing failed reason=invalid-response");
      expect(run.stdout).toContain("[auto-pair] approved request=request-1 client=cli mode=cli");
      expect(run.stdout).toContain("[auto-pair] loopback CLI pairing bootstrap completed");
      expect(fs.existsSync(approvalMarker)).toBe(true);
      const environments = fs.readFileSync(listEnv, "utf-8").trim().split("\n");
      expect(environments.slice(0, 4)).toEqual([
        "1:gateway-token:",
        "1:gateway-token:",
        "1:gateway-token:",
        "1:gateway-token:",
      ]);
      expect(environments[4]).toBe("::1");
      expect(fs.readFileSync(approveEnv, "utf-8").trim()).toBe("::");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["object", { value: "object-request-secret" }, "object-request-secret"],
    ["array", ["array-request-secret"], "array-request-secret"],
    ["number", 927461835, "927461835"],
    ["newline", "line\nnewline-request-secret", "newline-request-secret"],
    ["overlong", "x".repeat(129), "x".repeat(40)],
    ["option-like", "--help", "--help"],
  ])(
    "rejects a malformed %s request ID without approval or disclosure (#9844)",
    (_name, requestId, secretMarker) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-request-id-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const approvalMarker = path.join(tmpDir, "approval-called");
      const response = JSON.stringify({
        pending: [
          {
            requestId,
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
          },
        ],
        paired: [],
      });
      fs.writeFileSync(
        fakeOpenclaw,
        `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\n' ${JSON.stringify(response)}
`,
        { mode: 0o755 },
      );

      try {
        const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
          encoding: "utf-8",
          env: {
            ...process.env,
            OPENCLAW_BIN: fakeOpenclaw,
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 10_000,
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain(
          "[auto-pair] stage=validation rejected reason=malformed-request-id",
        );
        expect(run.stdout).toContain(
          "[auto-pair] stage=request-creation waiting reason=no-request",
        );
        expect(`${run.stdout}\n${run.stderr}`).not.toContain(secretMarker);
        expect(fs.existsSync(approvalMarker)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("does not treat an incomplete paired CLI record as the canonical baseline (#10269)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-malformed-pending-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\n' '{"pending":[{"requestId":"--help","clientId":"cli","clientMode":"cli"}],"paired":[{"clientId":"cli","clientMode":"cli"}]}'
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] stage=validation rejected reason=malformed-request-id",
      );
      expect(run.stdout).toContain("[auto-pair] loopback CLI pairing bootstrap completed");
      expect(run.stdout).not.toContain("entering slow-mode");
      expect(run.stdout).toContain('[auto-pair-status] {"schemaVersion":1,"state":"stopped"}');
      expect(run.stdout).not.toContain("--help");
      expect(fs.existsSync(approvalMarker)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forgets request diagnostics after the gateway removes the request (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-request-prune-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const listCount = path.join(tmpDir, "list-count");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f ${JSON.stringify(listCount)} ]; then count=$(cat ${JSON.stringify(listCount)}); fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(listCount)}
if [ "$count" -eq 1 ] || [ "$count" -eq 3 ]; then
  printf '%s\n' '{"pending":[{"requestId":"reused-request","clientId":"unknown","clientMode":"unknown","role":"operator","roles":["operator"],"scopes":["operator.pairing"]},{"requestId":{"secret":"malformed-request-secret"},"clientId":"cli","clientMode":"cli"}],"paired":[]}'
else
  printf '%s\n' '{"pending":[],"paired":[]}'
fi
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", createAutoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(
        run.stdout.match(/stage=request-creation observed request=reused-request/g),
      ).toHaveLength(2);
      expect(
        run.stdout.match(/stage=validation rejected request=reused-request reason=unknown-client/g),
      ).toHaveLength(2);
      expect(
        run.stdout.match(/stage=validation rejected reason=malformed-request-id/g),
      ).toHaveLength(2);
      expect(`${run.stdout}\n${run.stderr}`).not.toContain("malformed-request-secret");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports a fixed watcher-execution stage without raw exception details (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-exception-"));
    const writablePolicy = path.join(tmpDir, "openclaw_device_approval_policy.py");
    fs.writeFileSync(writablePolicy, "def approval_request_decision(_device): return {}\n", {
      mode: 0o600,
    });
    const script = src.replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(writablePolicy)}`,
    );

    try {
      const run = spawnSync("python3", ["-c", script], {
        encoding: "utf-8",
        env: { ...process.env, OPENCLAW_BIN: "/bin/false" },
        timeout: 10_000,
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("[auto-pair] stage=watcher-execution failed error=RuntimeError");
      expect(run.stdout).not.toContain(writablePolicy);
      expect(run.stderr).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
