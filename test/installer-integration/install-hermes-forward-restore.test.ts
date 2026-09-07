// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const FUTURE_PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime",
  id: "future-terminal",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});
const OTHER_PACKAGE_IDENTITY = Object.freeze({
  ...FUTURE_PACKAGE_IDENTITY,
  contentDigest: "b".repeat(64),
});
const HERMES_PACKAGE_IDENTITY = Object.freeze({
  ...FUTURE_PACKAGE_IDENTITY,
  id: "hermes",
});
const HERMES_PACKAGE_MIGRATION = Object.freeze({
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: "hermes",
  migratedAt: "2026-09-07T12:00:00.000Z",
});
const RECOVERY_STATE_MAX_BYTES = 16 * 1024 * 1024;
const UNSAFE_SANDBOX_NAME_CASES = ["--help", "a--b", "bad\nname", "a".repeat(20), "../escape"];

function restore(env: Record<string, string | undefined>) {
  return spawnSync(
    "bash",
    ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; restore_onboard_forward_after_post_checks`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { HOME: os.tmpdir(), PATH: TEST_SYSTEM_PATH, ...env },
    },
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-recover-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, ".nemoclaw");
  const cliLog = path.join(root, "cli.log");
  const openshellLog = path.join(root, "openshell.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(
    path.join(state, "onboard-session.json"),
    JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
  );
  fs.writeFileSync(
    path.join(state, "sandboxes.json"),
    JSON.stringify({ sandboxes: { "created-by-onboard": { hermesApiPort: 8647 } } }),
  );
  writeExecutable(
    path.join(bin, "nemoclaw"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CLI_LOG"\nexit "${CLI_STATUS:-0}"\n',
  );
  fs.symlinkSync(path.join(bin, "nemoclaw"), path.join(bin, "nemohermes"));
  writeExecutable(
    path.join(bin, "openshell"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$OPENSHELL_LOG"\nexit 0\n',
  );
  writeExecutable(path.join(bin, "curl"), '#!/usr/bin/env bash\nexit "${CURL_STATUS:-0}"\n');
  const env = {
    HOME: root,
    PATH: `${bin}:${TEST_SYSTEM_PATH}`,
    CLI_LOG: cliLog,
    OPENSHELL_LOG: openshellLog,
  };
  return { bin, cliLog, env, openshellLog, root, state };
}

function seedLegacyWatcher(
  h: ReturnType<typeof fixture>,
  sandboxArgument = "created-by-onboard",
): { pid: number; pidFile: string; watcherScript: string } {
  const runtimeState = path.join(h.state, "state");
  const pidFile = path.join(runtimeState, "hermes-created-by-onboard-8647.forward.pid");
  const watcherScript = `${pidFile}.js`;
  const node = path.join(h.bin, "node");
  const openshell = path.join(h.bin, "openshell");
  fs.mkdirSync(runtimeState, { recursive: true });
  fs.writeFileSync(watcherScript, "setInterval(() => undefined, 1000);\n");
  const started = spawnSync(
    "bash",
    [
      "-c",
      'nohup "$1" "$2" "$3" "$4" "$5" >/dev/null 2>&1 & printf "%s" "$!"',
      "legacy-forward-watcher",
      node,
      watcherScript,
      openshell,
      "8647",
      sandboxArgument,
    ],
    { encoding: "utf8", env: h.env },
  );
  const pid = Number(started.stdout);
  expect(started.status, started.stderr).toBe(0);
  expect(Number.isSafeInteger(pid)).toBe(true);
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  return { pid, pidFile, watcherScript };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number): boolean {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return !processExists(pid);
}

function stopFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already stopped by the migration path.
  }
}

function expectRecovery(h: ReturnType<typeof fixture>): void {
  const result = restore(h.env);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
  expect(fs.existsSync(h.openshellLog)).toBe(false);
}

function writeSession(h: ReturnType<typeof fixture>, value: unknown): void {
  fs.writeFileSync(path.join(h.state, "onboard-session.json"), JSON.stringify(value));
}

function writeRegistry(h: ReturnType<typeof fixture>, value: unknown): void {
  fs.writeFileSync(path.join(h.state, "sandboxes.json"), JSON.stringify(value));
}

function expectAuthorityInspectionFailure(h: ReturnType<typeof fixture>): void {
  const result = restore(h.env);
  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain("Could not inspect package authority");
  expect(fs.existsSync(h.cliLog)).toBe(false);
}

describe("Installer post-onboard forward recovery", () => {
  it("recovers a receipt-backed unknown harness through its declared secondary forward", () => {
    const h = fixture();
    try {
      fs.writeFileSync(
        path.join(h.state, "onboard-session.json"),
        JSON.stringify({
          sandboxName: "created-by-onboard",
          agent: "future-terminal",
          harnessPackage: FUTURE_PACKAGE_IDENTITY,
        }),
      );
      fs.writeFileSync(
        path.join(h.state, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "created-by-onboard": {
              harnessPackage: FUTURE_PACKAGE_IDENTITY,
              secondaryForwardPort: 9341,
            },
          },
        }),
      );

      const result = restore({ ...h.env, CURL_STATUS: "1" });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("does not recover a receipt-backed harness without a secondary forward", () => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": { harnessPackage: FUTURE_PACKAGE_IDENTITY },
        },
      });

      const result = restore(h.env);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed package authority even without a secondary forward", () => {
    const h = fixture();
    try {
      fs.writeFileSync(
        path.join(h.state, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "created-by-onboard": { harnessPackage: { id: "future-terminal" } },
          },
        }),
      );

      const result = restore(h.env);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Could not inspect package authority");
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "an absent registry document",
      (h: ReturnType<typeof fixture>) => fs.rmSync(path.join(h.state, "sandboxes.json")),
    ],
    [
      "an absent registry row",
      (h: ReturnType<typeof fixture>) => writeRegistry(h, { sandboxes: {} }),
    ],
    [
      "a receiptless registry row",
      (h: ReturnType<typeof fixture>) =>
        writeRegistry(h, { sandboxes: { "created-by-onboard": {} } }),
    ],
    [
      "a null registry receipt",
      (h: ReturnType<typeof fixture>) =>
        writeRegistry(h, {
          sandboxes: { "created-by-onboard": { harnessPackage: null } },
        }),
    ],
  ])("rejects a receipt-backed session paired with %s", (_label, prepareRegistry) => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
      });
      prepareRegistry(h);
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "an absent session",
      (h: ReturnType<typeof fixture>) => fs.rmSync(path.join(h.state, "onboard-session.json")),
    ],
    [
      "a receiptless session",
      (h: ReturnType<typeof fixture>) =>
        writeSession(h, { sandboxName: "created-by-onboard", agent: "hermes" }),
    ],
    [
      "a null session receipt",
      (h: ReturnType<typeof fixture>) =>
        writeSession(h, {
          sandboxName: "created-by-onboard",
          agent: "hermes",
          harnessPackage: null,
        }),
    ],
  ])("rejects a receipt-backed registry row paired with %s", (_label, prepareSession) => {
    const h = fixture();
    try {
      prepareSession(h);
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            harnessPackage: FUTURE_PACKAGE_IDENTITY,
            secondaryForwardPort: 9341,
          },
        },
      });
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting session and registry receipts", () => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            harnessPackage: OTHER_PACKAGE_IDENTITY,
            secondaryForwardPort: 9341,
          },
        },
      });
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("accepts matching, fully validated legacy migration authority", () => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "hermes",
        harnessPackage: HERMES_PACKAGE_IDENTITY,
        harnessPackageMigration: HERMES_PACKAGE_MIGRATION,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            agent: "hermes",
            harnessPackage: HERMES_PACKAGE_IDENTITY,
            harnessPackageMigration: HERMES_PACKAGE_MIGRATION,
            secondaryForwardPort: 9341,
          },
        },
      });

      const result = restore(h.env);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched migration provenance", () => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "hermes",
        harnessPackage: HERMES_PACKAGE_IDENTITY,
        harnessPackageMigration: HERMES_PACKAGE_MIGRATION,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            harnessPackage: HERMES_PACKAGE_IDENTITY,
            harnessPackageMigration: {
              ...HERMES_PACKAGE_MIGRATION,
              migratedAt: "2026-09-07T12:00:01.000Z",
            },
            secondaryForwardPort: 9341,
          },
        },
      });
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["session agent", "different-runtime", undefined],
    ["registry agent", "future-terminal", "different-runtime"],
  ])(
    "rejects a receipt that conflicts with the recorded %s",
    (_label, sessionAgent, registryAgent) => {
      const h = fixture();
      try {
        writeSession(h, {
          sandboxName: "created-by-onboard",
          agent: sessionAgent,
          harnessPackage: FUTURE_PACKAGE_IDENTITY,
        });
        writeRegistry(h, {
          sandboxes: {
            "created-by-onboard": {
              ...(registryAgent === undefined ? {} : { agent: registryAgent }),
              harnessPackage: FUTURE_PACKAGE_IDENTITY,
              secondaryForwardPort: 9341,
            },
          },
        });
        expectAuthorityInspectionFailure(h);
      } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["a null session document", null, { sandboxes: { "created-by-onboard": {} } }],
    ["an array session document", [], { sandboxes: { "created-by-onboard": {} } }],
    ["a null registry document", { sandboxName: "created-by-onboard" }, null],
    ["an array registry document", { sandboxName: "created-by-onboard" }, []],
    ["missing registry entries", { sandboxName: "created-by-onboard" }, {}],
    ["null registry entries", { sandboxName: "created-by-onboard" }, { sandboxes: null }],
    ["array registry entries", { sandboxName: "created-by-onboard" }, { sandboxes: [] }],
    [
      "a null registry row",
      { sandboxName: "created-by-onboard" },
      { sandboxes: { "created-by-onboard": null } },
    ],
    [
      "an array registry row",
      { sandboxName: "created-by-onboard" },
      { sandboxes: { "created-by-onboard": [] } },
    ],
  ])("rejects %s instead of treating it as legacy", (_label, session, registry) => {
    const h = fixture();
    try {
      writeSession(h, session);
      writeRegistry(h, registry);
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["sandbox registry", "sandboxes.json"],
    ["onboard session", "onboard-session.json"],
  ])("rejects a symlinked %s state document", (_label, fileName) => {
    const h = fixture();
    try {
      const statePath = path.join(h.state, fileName);
      const sourcePath = path.join(h.root, `${fileName}.source`);
      fs.copyFileSync(statePath, sourcePath);
      fs.rmSync(statePath);
      fs.symlinkSync(sourcePath, statePath);

      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["sandbox registry", "sandboxes.json"],
    ["onboard session", "onboard-session.json"],
  ])("rejects an oversized %s state document", (_label, fileName) => {
    const h = fixture();
    try {
      fs.truncateSync(path.join(h.state, fileName), RECOVERY_STATE_MAX_BYTES + 1);

      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["session", { id: "future-terminal" }, FUTURE_PACKAGE_IDENTITY],
    ["registry", FUTURE_PACKAGE_IDENTITY, { id: "future-terminal" }],
  ])("rejects a malformed %s receipt", (_label, sessionReceipt, registryReceipt) => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: sessionReceipt,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            harnessPackage: registryReceipt,
            secondaryForwardPort: 9341,
          },
        },
      });
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "session migration without a receipt",
      {
        sandboxName: "created-by-onboard",
        agent: "hermes",
        harnessPackageMigration: { schemaVersion: 1 },
      },
      { sandboxes: { "created-by-onboard": {} } },
    ],
    [
      "registry migration without a receipt",
      { sandboxName: "created-by-onboard", agent: "hermes" },
      {
        sandboxes: {
          "created-by-onboard": { harnessPackageMigration: { schemaVersion: 1 } },
        },
      },
    ],
    [
      "session migration beside a receipt",
      {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
        harnessPackageMigration: { schemaVersion: 1 },
      },
      {
        sandboxes: {
          "created-by-onboard": { harnessPackage: FUTURE_PACKAGE_IDENTITY },
        },
      },
    ],
  ])("rejects malformed raw authority from %s", (_label, session, registry) => {
    const h = fixture();
    try {
      writeSession(h, session);
      writeRegistry(h, registry);
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("preserves the legitimate receiptless non-Hermes no-op", () => {
    const h = fixture();
    try {
      writeSession(h, { sandboxName: "created-by-onboard", agent: "openclaw" });
      writeRegistry(h, { sandboxes: { "created-by-onboard": { agent: "openclaw" } } });

      const result = restore(h.env);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(h.cliLog)).toBe(false);
      expect(fs.existsSync(h.openshellLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each([0, 65_536, "9341"])("rejects malformed secondary forward port %j", (port) => {
    const h = fixture();
    try {
      writeSession(h, {
        sandboxName: "created-by-onboard",
        agent: "future-terminal",
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
      });
      writeRegistry(h, {
        sandboxes: {
          "created-by-onboard": {
            harnessPackage: FUTURE_PACKAGE_IDENTITY,
            secondaryForwardPort: port,
          },
        },
      });
      expectAuthorityInspectionFailure(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it.each(
    UNSAFE_SANDBOX_NAME_CASES.flatMap((name) => [
      ["receipt", name] as const,
      ["legacy", name] as const,
    ]),
  )("rejects unsafe %s sandbox name %j before command or file mutation", (authority, name) => {
    const h = fixture();
    try {
      const session =
        authority === "receipt"
          ? {
              sandboxName: name,
              agent: "future-terminal",
              harnessPackage: FUTURE_PACKAGE_IDENTITY,
            }
          : { sandboxName: name, agent: "hermes" };
      const entry =
        authority === "receipt"
          ? { harnessPackage: FUTURE_PACKAGE_IDENTITY, secondaryForwardPort: 9341 }
          : { hermesApiPort: 8647 };
      writeSession(h, session);
      writeRegistry(h, { sandboxes: { [name]: entry } });
      const sessionBefore = fs.readFileSync(path.join(h.state, "onboard-session.json"), "utf8");
      const registryBefore = fs.readFileSync(path.join(h.state, "sandboxes.json"), "utf8");

      expectAuthorityInspectionFailure(h);

      expect(fs.existsSync(path.join(h.state, "state"))).toBe(false);
      expect(fs.readFileSync(path.join(h.state, "onboard-session.json"), "utf8")).toBe(
        sessionBefore,
      );
      expect(fs.readFileSync(path.join(h.state, "sandboxes.json"), "utf8")).toBe(registryBefore);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("always invokes identity-bound recovery before accepting healthy transport", () => {
    const h = fixture();
    try {
      expectRecovery(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retires only an exact legacy watcher before ForwardTcp recovery", () => {
    const h = fixture();
    const watcher = seedLegacyWatcher(h);
    try {
      expectRecovery(h);
      expect(waitForProcessExit(watcher.pid)).toBe(true);
      expect(fs.existsSync(watcher.pidFile)).toBe(false);
      expect(fs.existsSync(watcher.watcherScript)).toBe(false);
    } finally {
      stopFixtureProcess(watcher.pid);
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("leaves an argument-mismatched legacy watcher and its evidence untouched", () => {
    const h = fixture();
    const watcher = seedLegacyWatcher(h, "different-sandbox");
    try {
      const result = restore(h.env);
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("leaving it untouched");
      expect(processExists(watcher.pid)).toBe(true);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(fs.existsSync(watcher.watcherScript)).toBe(true);
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      stopFixtureProcess(watcher.pid);
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("leaves a legacy watcher untouched when its identity changes before the signal", () => {
    const h = fixture();
    const watcher = seedLegacyWatcher(h);
    const psCallCount = path.join(h.root, "ps-call-count");
    const expectedArgs = [
      path.join(h.bin, "node"),
      watcher.watcherScript,
      path.join(h.bin, "openshell"),
      "8647",
      "created-by-onboard",
    ].join(" ");
    writeExecutable(
      path.join(h.bin, "ps"),
      `#!/usr/bin/env bash
count="$(cat "$PS_CALL_COUNT" 2>/dev/null || printf 0)"
count=$((count + 1))
printf '%s\n' "$count" > "$PS_CALL_COUNT"
case "$*" in
  *" uid="*) printf '%s\n' "$PS_EXPECTED_UID" ;;
  *" args="*)
    if [[ "$count" -ge 4 ]]; then
      printf '%s\n' "$PS_REPLACEMENT_ARGS"
    else
      printf '%s\n' "$PS_EXPECTED_ARGS"
    fi
    ;;
esac
`,
    );
    try {
      const result = restore({
        ...h.env,
        PS_CALL_COUNT: psCallCount,
        PS_EXPECTED_ARGS: expectedArgs,
        PS_EXPECTED_UID: String(process.getuid?.() ?? 0),
        PS_REPLACEMENT_ARGS: `${expectedArgs}-replacement`,
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("changed after authentication");
      expect(fs.readFileSync(psCallCount, "utf8").trim()).toBe("4");
      expect(processExists(watcher.pid)).toBe(true);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(fs.existsSync(watcher.watcherScript)).toBe(true);
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      stopFixtureProcess(watcher.pid);
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed before recovery when the registered Hermes port is unavailable", () => {
    const h = fixture();
    try {
      fs.writeFileSync(path.join(h.state, "sandboxes.json"), JSON.stringify({ sandboxes: {} }));
      const result = restore(h.env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("registered API port");
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails when recovery fails or its post-recovery health probe is unhealthy", () => {
    const recoveryFailure = fixture();
    const healthFailure = fixture();
    try {
      expect(restore({ ...recoveryFailure.env, CLI_STATUS: "1" }).status).toBe(1);
      const unhealthy = restore({ ...healthFailure.env, CURL_STATUS: "1" });
      expect(unhealthy.status).toBe(1);
      expect(`${unhealthy.stdout}\n${unhealthy.stderr}`).toContain("created-by-onboard status");
    } finally {
      fs.rmSync(recoveryFailure.root, { recursive: true, force: true });
      fs.rmSync(healthFailure.root, { recursive: true, force: true });
    }
  }, 45_000);
});
