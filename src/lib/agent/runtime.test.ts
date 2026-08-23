// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessPackageContentDigest } from "../harness/package-registry";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import type { AgentDefinition } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import {
  buildRecoveryScript,
  getAgentDisplayName,
  getGatewayCommand,
  getHealthProbeUrl,
  getRegisteredAgent,
  getSessionAgent,
} from "./runtime";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-runtime-"));
  temporaryHomes.push(home);
  return home;
}

function writeInstalledOpenClaw(home: string, manifest: string): void {
  const root = path.join(home, ".nemoclaw", "harnesses", "nemoclaw-openclaw");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@nvidia/nemoclaw-openclaw",
      version: "9.8.7",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), manifest);
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest: harnessPackageContentDigest(root) })}\n`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    packageContentDigest: null,
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    webAuth: { method: "none", env: null },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
      shieldsFiles: [],
    },
    inferenceProviderOptions: [],
    mcpCapability: { support: "disabled", reason: "test fixture" },
    stateDirectories: [],
    stateDirs: [],
    stateDirPrefixes: [],
    backupStateDirs: [],
    backupStateDirPrefixes: [],
    nonBackupStateDirs: [],
    nonBackupStateDirPrefixes: [],
    stateLockPlan: {
      version: 1,
      readOnlyRoots: [],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
    stateLockPlanInImage: false,
    stateFiles: [],
    userManagedFiles: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const minimalAgent = makeAgent();
const hermesAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  binary_path: "/usr/local/bin/hermes",
  gateway_command: "hermes gateway run",
  healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
  forwardPort: 8642,
  configPaths: {
    dir: "/sandbox/.hermes",
    configFile: "/sandbox/.hermes/config.yaml",
    envFile: "/sandbox/.hermes/.env",
    format: "yaml",
    shieldsFiles: [".env"],
  },
});

describe("getRegisteredAgent", () => {
  it("does not invent an agent when the target registry row records no identity", () => {
    expect(getRegisteredAgent(null)).toBeNull();
  });

  it("loads OpenClaw for legacy registry rows that omit or null the agent identity", () => {
    expect(getRegisteredAgent({})?.name).toBe("openclaw");
    expect(getRegisteredAgent({ agent: null })?.name).toBe("openclaw");
  });

  it("loads the OpenClaw agent manifest recorded by the registry row", () => {
    expect(getRegisteredAgent({ agent: "openclaw" })?.name).toBe("openclaw");
  });

  it("loads only the agent named by the supplied registry row", () => {
    expect(getRegisteredAgent({ agent: "hermes" })?.name).toBe("hermes");
  });

  it("fails closed when the registered agent definition is unavailable", () => {
    expect(getRegisteredAgent({ agent: "missing-agent" })).toBeNull();
  });

  it.each(["../openclaw", "/tmp/agent", "hermes/../openclaw", "hermes\\openclaw"])(
    "fails closed for path-like persisted agent name %j",
    (agent) => {
      expect(getRegisteredAgent({ agent })).toBeNull();
    },
  );
});

describe("getSessionAgent", () => {
  it("resolves the selected OpenClaw manifest from the legacy null registry encoding", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: null });

    expect(getSessionAgent("alpha")?.name).toBe("openclaw");
  });

  it("resolves the selected OpenClaw manifest from a legacy row without an agent field", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });

    expect(getSessionAgent("alpha")?.name).toBe("openclaw");
  });

  it("keeps absent registry and session state compatible with legacy OpenClaw state", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);

    expect(getSessionAgent("alpha")).toBeNull();
  });

  it("rejects an unknown identity recorded for a sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "missing-agent",
    });

    expect(() => getSessionAgent("alpha")).toThrow(
      "Cannot resolve the recorded agent identity \"missing-agent\" from sandbox 'alpha'.",
    );
  });

  it("rejects a selected OpenClaw package whose agent manifest is malformed", () => {
    const home = temporaryHome();
    writeInstalledOpenClaw(
      home,
      ["name: openclaw", "runtime:", "  kind: unsupported"].join("\n") + "\n",
    );
    vi.stubEnv("HOME", home);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: null });

    expect(() => getSessionAgent("alpha")).toThrow(
      "Cannot resolve the recorded agent identity \"openclaw\" from sandbox 'alpha'.",
    );
  });

  it("uses the selected installed OpenClaw manifest for runtime behavior", () => {
    const home = temporaryHome();
    writeInstalledOpenClaw(
      home,
      [
        "name: openclaw",
        'display_name: "Installed OpenClaw"',
        "binary_path: /usr/local/bin/installed-openclaw",
        'version_command: "installed-openclaw version"',
        'gateway_command: "installed-openclaw serve"',
        "runtime:",
        "  kind: gateway",
        '  interactive_command: "installed-openclaw tui"',
        "health_probe:",
        '  url: "http://localhost:19123/installed-health"',
        "  port: 19123",
        "  timeout_seconds: 12",
        "dashboard:",
        "  kind: ui",
        '  label: "Installed dashboard"',
        '  path: "/installed"',
        '  health_path: "/installed-health"',
        "  auth: session",
        "forward_ports:",
        "  - 19123",
        "config:",
        "  dir: /sandbox/.installed-openclaw",
        "  config_file: installed.json",
        "  format: json",
      ].join("\n") + "\n",
    );
    vi.stubEnv("HOME", home);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: null });

    const agent = getSessionAgent("alpha");

    expect(agent).not.toBeNull();
    expect(agent).toMatchObject({
      name: "openclaw",
      runtime: { kind: "gateway", interactive_command: "installed-openclaw tui" },
      configPaths: {
        dir: "/sandbox/.installed-openclaw",
        configFile: "installed.json",
        format: "json",
      },
      dashboard: {
        auth: "session",
        healthPath: "/installed-health",
        label: "Installed dashboard",
        path: "/installed",
      },
    });
    expect(getHealthProbeUrl(agent)).toBe("http://localhost:19123/installed-health");
    expect(getGatewayCommand(agent)).toBe("installed-openclaw serve");
    expect(getAgentDisplayName(agent)).toBe("Installed OpenClaw");
  });
});

function extractGatewayProcessPattern(script: string | null): string {
  const match = script?.match(/_GATEWAY_PROC_PATTERN='([^']+)'/);
  expect(match).toBeTruthy();
  return match?.[1] ?? "";
}

function toJsRegex(pattern: string): RegExp {
  return new RegExp(pattern.replaceAll("[[:space:]]", "\\s"));
}

describe("buildRecoveryScript", () => {
  it("returns null for null agent because PID 1 owns OpenClaw recovery", () => {
    expect(buildRecoveryScript(null, 18789)).toBeNull();
  });

  it("returns null for Hermes because PID 1 owns Hermes recovery", () => {
    expect(buildRecoveryScript(hermesAgent, 8642)).toBeNull();
  });

  it("embeds the port in the gateway launch command (#1925)", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("--port 19000");
  });

  it("embeds the default port when called with default value", () => {
    const script = buildRecoveryScript(minimalAgent, 18789);
    expect(script).toContain("--port 18789");
  });

  it("derives the recovery port from agent metadata when omitted", () => {
    const script = buildRecoveryScript(minimalAgent);
    expect(script).toContain("--port 19000");
    expect(script).not.toContain("--port undefined");
  });

  it("launches the default gateway command through the validated agent binary", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("command -v 'test-agent'");
    expect(script).toContain('"$AGENT_BIN" gateway run --port 19000');
  });

  it("falls back to openclaw gateway run when gateway_command is absent", () => {
    const agent = makeAgent({ gateway_command: undefined });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain('"$AGENT_BIN" gateway run --port 19000');
  });

  it("validates and launches custom gateway commands explicitly", () => {
    const agent = makeAgent({ gateway_command: "custom-launch --mode recovery" });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain("GATEWAY_CMD_BIN='custom-launch'");
    expect(script).toContain('command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1');
    expect(script).toContain(
      "_GATEWAY_PROC_PATTERN='[c]ustom-launch[[:space:]]+--mode[[:space:]]+recovery([[:space:]]|$)'",
    );
    expect("custom-launch --mode recovery --port 19000").toMatch(
      toJsRegex(extractGatewayProcessPattern(script)),
    );
    expect(script).toContain("nohup custom-launch --mode recovery --port 19000");
  });

  // Regression coverage for #2478. The recovery script must validate
  // /tmp/nemoclaw-proxy-env.sh, then source a generated recovery env carrying
  // the critical NODE_OPTIONS library guards. The pre-fix recovery path
  // swallowed sourcing errors via `2>/dev/null`, leaving respawned gateways
  // guard-less and crash-looping on the next library error from ciao,
  // model-pricing, or anything else hitting a sandboxed syscall.
  describe("hardened library-guard preload chain (#2478)", () => {
    it("sources the generated recovery env after validating the gateway env file", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("_nemoclaw_validate_recovery_proxy_env /tmp/nemoclaw-proxy-env.sh");
      expect(script).toContain('. "$_NEMOCLAW_RECOVERY_SOURCE_ENV"');
    });

    it("warns and restores guards when the gateway env file is missing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("/tmp/nemoclaw-proxy-env.sh missing");
      expect(script).toContain("restoring library guards from packaged preloads");
      expect(script).toContain("#2478");
      expect(script).not.toContain("gateway launching without library guards");
    });

    it("does not silence sourcing errors with 2>/dev/null", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toContain(". ~/.bashrc 2>/dev/null");
      expect(script).not.toContain(". /tmp/nemoclaw-proxy-env.sh 2>/dev/null");
    });

    it("checks NODE_OPTIONS for the safety-net and ciao preloads after sourcing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("nemoclaw-sandbox-safety-net");
      expect(script).toContain("nemoclaw-ciao-network-guard");
      expect(script).toContain("NODE_OPTIONS missing safety-net preload");
      expect(script).toContain("or ciao preload");
    });

    it("stops stale launcher and gateway processes before relaunch", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain(
        "_GATEWAY_PROC_PATTERN='[t]est-agent[[:space:]]+gateway[[:space:]]+run([[:space:]]|$)'",
      );
      expect(script).toContain('pkill -TERM -f "$_GATEWAY_PROC_PATTERN"');
      expect(script).toContain('pkill -KILL -f "$_GATEWAY_PROC_PATTERN"');
      expect(script).toContain("GATEWAY_STALE_PROCESSES");
    });

    it("fails recovery when trusted guard restoration cannot install required guards", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("_NEMOCLAW_CRITICAL_GUARDS_READY");
      expect(script).toContain("refusing unguarded gateway relaunch");
      expect(script).toContain('echo "$_E" >> "$_GATEWAY_LOG"; exit 1');
    });

    it("writes the warning to gateway.log so it persists for sysadmin tail", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Both warnings must end up in the selected gateway log, not just stderr —
      // executeSandboxCommand silently discards stderr from the recovery
      // script, so a warning that only goes to stderr is invisible to
      // anyone debugging a crash-loop. (#2478)
      expect(script).toContain('_nemoclaw_recovery_log "$_W"');
      expect(script).toContain('echo "$_msg" >> "$_GATEWAY_LOG"');
      // And the warning must be deferred until AFTER gateway.log is
      // safely opened with O_NOFOLLOW, otherwise the redirect targets a
      // stale or attacker-controlled file.
      const gatewayPrepIdx = script!.indexOf(" /tmp/gateway.log || exit 1;");
      const logSelectionIdx = script!.indexOf("_GATEWAY_LOG=/tmp/gateway.log");
      const warnIdx = script!.indexOf("_W=");
      expect(gatewayPrepIdx).toBeGreaterThanOrEqual(0);
      expect(logSelectionIdx).toBeGreaterThanOrEqual(0);
      expect(warnIdx).toBeGreaterThanOrEqual(0);
      expect(gatewayPrepIdx).toBeLessThan(logSelectionIdx);
      expect(logSelectionIdx).toBeLessThan(warnIdx);
    });

    it("appends (not truncates) gateway.log on launch so warnings survive", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Truncating with `>` wipes the [gateway-recovery] WARNING that the
      // recovery script wrote moments earlier — meaning a sysadmin tailing
      // gateway.log would see the eventual crash without the explanation.
      expect(script).toContain('>> "$_GATEWAY_LOG" 2>&1 &');
      expect(script).not.toMatch(/[^>]> \/tmp\/gateway\.log 2>&1 &/);
    });

    it("does not force non-OpenClaw agents to run as the gateway user", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toContain("chown gateway:gateway /tmp/gateway.log");
      expect(script).not.toContain("chown 'gateway:gateway' /tmp/gateway.log");
      expect(script).not.toContain("--reuid=gateway");
    });
  });
});
