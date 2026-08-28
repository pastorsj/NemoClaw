// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { onTestFinished } from "vitest";

import { writeFailedOnboardSession, writeNodeStub } from "./installer-readiness-stubs";
import { createInstallerCheckout, INSTALLER_HARNESS_CLI_COMMANDS } from "./installer-run-fixture";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH, writeExecutable } from "./installer-sourced-env";

export function runFailedSessionPromptChoice(answer: string) {
  const checkout = createInstallerCheckout("nemoclaw-install-failed-choice-");
  onTestFinished(() => checkout.remove());
  const { root: temporaryHome, binDir: fakeBin } = checkout;
  const onboardLog = path.join(temporaryHome, "onboard.log");
  const promptInput = path.join(temporaryHome, "prompt-input.txt");
  writeFailedOnboardSession(temporaryHome);
  fs.writeFileSync(promptInput, answer);
  writeNodeStub(fakeBin);
  writeExecutable(
    path.join(fakeBin, "nemoclaw"),
    `#!/usr/bin/env bash
${INSTALLER_HARNESS_CLI_COMMANDS}
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$INSTALLER_UNDER_TEST"
show_usage_notice() { :; }
info() { printf 'INFO: %s\\n' "$*" >&2; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
function [ {
  if [[ "$#" -eq 3 && "$1" = "-t" && "$2" = "0" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
run_onboard < "$PROMPT_INPUT_FILE"
`,
    ],
    {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: {
        ...process.env,
        FRESH: "",
        HOME: temporaryHome,
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_FRESH: "",
        NEMOCLAW_NON_INTERACTIVE: "",
        NON_INTERACTIVE: "",
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
        PROMPT_INPUT_FILE: promptInput,
      },
    },
  );

  return { result, onboardLog };
}
