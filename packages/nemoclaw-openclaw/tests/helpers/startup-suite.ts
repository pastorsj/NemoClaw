// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { expect } from "vitest";

import { readOpenClawStartupSource } from "./startup";

export { readOpenClawStartupSource };

export const OPENCLAW_PACKAGE = path.resolve(import.meta.dirname, "../..");
const APPROVAL_POLICY_SOURCE = path.join(OPENCLAW_PACKAGE, "runtime", "device-approval.py");
export const MUTABLE_CONFIG_NORMALIZER = path.join(
  OPENCLAW_PACKAGE,
  "runtime",
  "config-permissions.py",
);
export const INSTALLED_APPROVAL_POLICY =
  "/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py";
const PRELOAD_SCRIPTS = path.join(OPENCLAW_PACKAGE, "runtime", "preloads");
export const CHANNEL_RUNTIME_SCRIPTS = path.join(OPENCLAW_PACKAGE, "messaging", "runtime");
export const JSON5_MODULE = path.join(OPENCLAW_PACKAGE, "plugin", "node_modules", "json5");
const OPENCLAW_AUTO_PAIR = path.join(OPENCLAW_PACKAGE, "runtime", "auto-pair.py");

export function runtimeShellEnvBlock(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

export function messagingRuntimeSetupSection(
  source: string,
  options: {
    planPath?: string;
    connectPreloadsPath?: string;
    sourcePrefix?: string;
    targetPrefix?: string;
    secretScanPrefix?: string;
  } = {},
): string {
  const start = source.indexOf("# ── Messaging runtime setup from manifest metadata");
  const end = source.indexOf("_read_gateway_token()", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let section = source.slice(start, end);
  if (options.planPath) {
    section = section.replace(
      '_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"',
      `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(options.planPath)}`,
    );
  }
  if (options.connectPreloadsPath) {
    section = section
      .replace(
        '_MESSAGING_CONNECT_PRELOADS_FILE="/tmp/nemoclaw-messaging-connect-preloads.list"',
        `_MESSAGING_CONNECT_PRELOADS_FILE=${JSON.stringify(options.connectPreloadsPath)}`,
      )
      .replaceAll("/tmp/nemoclaw-messaging-connect-preloads.list", options.connectPreloadsPath);
  }
  if (options.sourcePrefix) {
    section = section.replace(
      'PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/"',
      `PRELOAD_SOURCE_PREFIX = ${JSON.stringify(options.sourcePrefix)}`,
    );
  }
  if (options.targetPrefix) {
    section = section.replace(
      'PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-"',
      `PRELOAD_TARGET_PREFIX = ${JSON.stringify(options.targetPrefix)}`,
    );
  }
  if (options.secretScanPrefix) {
    section = section.replace(
      'if not path.startswith("/sandbox/"):',
      `if not path.startswith(${JSON.stringify(options.secretScanPrefix)}):`,
    );
  }
  return section;
}

export function encodeRuntimeSetupPlan(
  channelId: string,
  value: Record<string, unknown>,
  options: { active?: boolean } = {},
): string {
  const active = options.active ?? true;
  const withChannelId = (entries: unknown) =>
    Array.isArray(entries)
      ? entries.map((entry) => ({ channelId, ...(entry as Record<string, unknown>) }))
      : [];
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [
        {
          channelId,
          displayName: channelId,
          authMode: "token-paste",
          active,
          selected: true,
          configured: true,
          disabled: !active,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: active ? [] : [channelId],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      runtimeSetup: {
        nodePreloads: withChannelId(value.nodePreloads),
        envAliases: withChannelId(value.envAliases),
        secretScans: withChannelId(value.secretScans),
      },
      stateUpdates: [],
      healthChecks: [],
    }),
  ).toString("base64");
}

export function nonRootFallbackBlock(source: string): string {
  const start = source.indexOf("# ── Non-root fallback");
  const end = source.indexOf("# ── Root path", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return `${extractShellFunctionFromSource(source, "_nemoclaw_capture_epoch_realtime")}\n${source.slice(start, end)}`;
}

export function startScriptHeredoc(source: string, marker: string): string {
  const match = source.match(new RegExp(`<<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n${marker}`));
  if (match) return match[1];
  const sourcePathByMarker: Record<string, string> = {
    PYAUTOPAIR: OPENCLAW_AUTO_PAIR,
    CIAO_GUARD_EOF: path.join(PRELOAD_SCRIPTS, "ciao-network-guard.js"),
    SAFETY_NET_EOF: path.join(PRELOAD_SCRIPTS, "sandbox-safety-net.js"),
    SLACK_GUARD_EOF: path.join(
      CHANNEL_RUNTIME_SCRIPTS,
      "slack",
      "runtime",
      "slack-channel-guard.ts",
    ),
    TELEGRAM_DIAGNOSTICS_EOF: path.join(
      CHANNEL_RUNTIME_SCRIPTS,
      "telegram",
      "runtime",
      "telegram-diagnostics.ts",
    ),
  };
  const sourcePath = sourcePathByMarker[marker];
  expect(sourcePath).toBeTruthy();
  const script = fs.readFileSync(sourcePath, "utf-8");
  if (!sourcePath.endsWith(".ts")) return script;
  return ts.transpileModule(script, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

export function trustedApprovalPolicyFile(temporaryDirectory?: string): string {
  temporaryDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-helper-"));
  const helperPath = path.join(temporaryDirectory, "openclaw_device_approval_policy.py");
  fs.copyFileSync(APPROVAL_POLICY_SOURCE, helperPath);
  fs.chmodSync(helperPath, 0o444);
  return helperPath;
}

export function localApprovalPolicyPythonScript(source: string): string {
  return startScriptHeredoc(source, "PYAUTOPAIR").replace(
    "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
    `APPROVAL_POLICY_FILE = ${JSON.stringify(trustedApprovalPolicyFile())}`,
  );
}

export function autoPairPythonScript(source: string): string {
  return localApprovalPolicyPythonScript(source)
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

export function runEmbeddedPreload(
  script: string,
  argv1: string,
  argv2: string,
  title = "node",
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.OPENSHELL_SANDBOX = '1';
process.title = ${JSON.stringify(title)};
process.argv[1] = ${JSON.stringify(argv1)};
process.argv[2] = ${JSON.stringify(argv2)};
${script}`,
    ],
    { encoding: "utf-8" },
  );
}

export function startScriptLine(source: string, needle: string): string {
  const start = source.indexOf(needle);
  if (start === -1) {
    throw new Error(`Expected line containing ${needle} in OpenClaw start.sh`);
  }
  const end = source.indexOf("\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

export function startupConfigPreparationBlock(source: string): string {
  const start = source.indexOf("# OpenClaw config so a prior config write or restart can recover");
  const end = source.indexOf(
    'if [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ]; then',
    start,
  );
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Expected startup config preparation block in OpenClaw start.sh");
  }
  return source.slice(start, end);
}

export function extractShellFunctionFromSource(source: string, name: string): string {
  const header = `${name}() {`;
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`Expected ${name} in shell source`);
  }
  const bodyStart = start + header.length;
  const lines = source.slice(bodyStart).split(/(?<=\n)/);
  let offset = 0;
  let heredocEnd: string | undefined;
  for (const line of lines) {
    const bareLine = line.replace(/\r?\n$/, "");
    if (heredocEnd) {
      offset += line.length;
      if (bareLine === heredocEnd) {
        heredocEnd = undefined;
      }
      continue;
    }
    const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredoc) {
      heredocEnd = heredoc[1];
    }
    if (bareLine === "}") {
      return `${name}() {${source.slice(bodyStart, bodyStart + offset)}\n}`;
    }
    offset += line.length;
  }
  throw new Error(`Expected closing brace for ${name} in shell source`);
}
