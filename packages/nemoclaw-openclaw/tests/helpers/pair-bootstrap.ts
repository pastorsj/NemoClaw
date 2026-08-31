// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const approvalPolicy = path.join(import.meta.dirname, "..", "..", "runtime", "device-approval.py");

function copyTrustedApprovalPolicy(temporaryDirectory: string): string {
  const helperPath = path.join(temporaryDirectory, "openclaw_device_approval_policy.py");
  fs.copyFileSync(approvalPolicy, helperPath);
  fs.chmodSync(helperPath, 0o444);
  return helperPath;
}

interface AutoPairScriptOptions {
  readonly realTime?: boolean;
  readonly statusPath?: string;
}

export function createAutoPairPythonScript(
  source: string,
  temporaryDirectory: string,
  options: AutoPairScriptOptions = {},
): string {
  const statusPath = options.statusPath ?? path.join(temporaryDirectory, "auto-pair-status.json");
  fs.writeFileSync(statusPath, "", { mode: 0o600 });
  const script = source
    .replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(copyTrustedApprovalPolicy(temporaryDirectory))}`,
    )
    .replace(
      "STATUS_PATH = '/tmp/nemoclaw-auto-pair-status.json'",
      `STATUS_PATH = ${JSON.stringify(statusPath)}`,
    );
  if (options.realTime) {
    return script;
  }
  return script
    .replaceAll("time.time()", "_nemoclaw_test_time()")
    .replaceAll("time.sleep(", "_nemoclaw_test_sleep(")
    .replace(
      "import time",
      `import time
_nemoclaw_test_clock = [time.time()]
_nemoclaw_test_time = lambda: _nemoclaw_test_clock[0]
def _nemoclaw_test_sleep(seconds): _nemoclaw_test_clock.__setitem__(0, _nemoclaw_test_clock[0] + min(max(float(seconds), 0), 0.25))
`,
    );
}
