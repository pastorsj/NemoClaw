// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { minimalAgent } from "../../agent/hermes-recovery-boundary-fixtures";
import { buildRecoveryScript } from "../../agent/runtime";
import { runGuardRecovery } from "./recovery-preload.test-support";
import { GATEWAY_PRELOAD_GUARDS } from "./recovery-preload";

const [SAFETY_NET_GUARD, CIAO_GUARD] = GATEWAY_PRELOAD_GUARDS;

describe("gateway recovery preload repair", () => {
  it("runs the generated recovery helper through /bin/sh -c", () => {
    const result = runGuardRecovery({ fakeRoot: true, shell: "sh" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PE_MISSING=0");
    expect(result.stderr).not.toContain("Bad substitution");
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
  });

  it("restores missing proxy-env.sh from trusted packaged preloads", () => {
    const result = runGuardRecovery({});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PE_MISSING=0");
    expect(result.stdout).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.stdout).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.tmpSafetyNet).toContain("trusted safety net");
    expect(result.files.tmpCiao).toContain("trusted ciao guard");
    expect(result.files.tmpSafetyNetMode).toBe(0o444);
    expect(result.files.tmpCiaoMode).toBe(0o444);
    expect(result.files.proxyEnvMode).toBe(0o444);
    const proxyEnv = result.files.proxyEnv ?? "";
    expect(proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.gatewayLog).toContain("[gateway-recovery] WARNING");
    expect(result.files.gatewayLog).toContain("restoring library guards");
  });

  it("does not accept substring matches as installed preload guards", () => {
    const result = runGuardRecovery({
      proxyEnvContent: `export NODE_OPTIONS="--require /tmp/not-nemoclaw-sandbox-safety-net.js --require /tmp/not-nemoclaw-ciao-network-guard.js"\n`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.stdout).toContain(`--require ${result.paths.tmpCiao}`);
  });

  it("does not duplicate exact --require entries", () => {
    const result = runGuardRecovery({
      proxyEnvContent: `export NODE_OPTIONS="--require ${SAFETY_NET_GUARD.tmpPath} --require=${CIAO_GUARD.tmpPath}"\n`,
    });
    expect(result.status).toBe(0);
    const nodeOptions = result.stdout.match(/^NODE_OPTIONS=(.*)$/m)?.[1] ?? "";
    expect(nodeOptions.match(new RegExp(result.paths.tmpSafetyNet, "g"))?.length).toBe(1);
    expect(nodeOptions.match(new RegExp(result.paths.tmpCiao, "g"))?.length).toBe(1);
  });

  it("rebuilds a metadata-safe proxy-env.sh without sourcing shell content", () => {
    const result = runGuardRecovery({
      proxyEnvContent: (paths) =>
        [
          `touch ${JSON.stringify(paths.hostileMarker)}`,
          `export NODE_OPTIONS="--require ${SAFETY_NET_GUARD.tmpPath} --require=${CIAO_GUARD.tmpPath}"`,
          "",
        ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.files.hostileProxyEnvSourced).toBe(false);
    expect(result.files.proxyEnv).not.toContain("touch");
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
  });

  it("preserves a trusted full proxy-env.sh while sourcing only a generated recovery copy", () => {
    const result = runGuardRecovery({
      fakeRoot: true,
      proxyEnvContent: [
        "# Proxy configuration (overrides narrow OpenShell defaults on connect)",
        'export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"',
        "export OPENCLAW_GATEWAY_TOKEN='trusted-token'",
        "# nemoclaw-configure-guard begin",
        "openclaw() {",
        '  command openclaw "$@"',
        "}",
        "# nemoclaw-configure-guard end",
        `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require ${SAFETY_NET_GUARD.tmpPath}"`,
        'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require /tmp/nemoclaw-http-proxy-fix.js"',
        `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require ${CIAO_GUARD.tmpPath}"`,
        "# Tool cache redirects — keep transient tool state under /tmp",
        "export npm_config_cache=/tmp/.npm-cache",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.files.proxyEnv).toContain("OPENCLAW_GATEWAY_TOKEN='trusted-token'");
    expect(result.files.proxyEnv).toContain("openclaw() {");
    expect(result.files.proxyEnv).toContain("/tmp/nemoclaw-http-proxy-fix.js");
    expect(result.files.recoverySourceEnv).toContain("OPENCLAW_GATEWAY_TOKEN='trusted-token'");
    expect(result.files.recoverySourceEnv).toContain("openclaw() {");
    expect(result.files.recoverySourceEnv).toContain("/tmp/nemoclaw-http-proxy-fix.js");
    const nodeOptions = result.stdout.match(/^NODE_OPTIONS=(.*)$/m)?.[1] ?? "";
    expect(nodeOptions.match(new RegExp(result.paths.tmpSafetyNet, "g"))?.length).toBe(1);
    expect(nodeOptions.match(new RegExp(result.paths.tmpCiao, "g"))?.length).toBe(1);
  });

  it("repairs an incomplete trusted proxy-env.sh without dropping full runtime entries", () => {
    const result = runGuardRecovery({
      fakeRoot: true,
      proxyEnvContent: [
        "# Proxy configuration (overrides narrow OpenShell defaults on connect)",
        'export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"',
        "export OPENCLAW_GATEWAY_TOKEN='trusted-token'",
        "# nemoclaw-configure-guard begin",
        "openclaw() {",
        '  command openclaw "$@"',
        "}",
        "# nemoclaw-configure-guard end",
        `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require ${SAFETY_NET_GUARD.tmpPath}"`,
        'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require /tmp/nemoclaw-http-proxy-fix.js"',
        "export npm_config_cache=/tmp/.npm-cache",
        "",
      ].join("\n"),
    });
    expect(result.status).toBe(0);
    expect(result.files.proxyEnv).toContain("OPENCLAW_GATEWAY_TOKEN='trusted-token'");
    expect(result.files.proxyEnv).toContain("openclaw() {");
    expect(result.files.proxyEnv).toContain("/tmp/nemoclaw-http-proxy-fix.js");
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.gatewayLog).toContain("proxy-env.sh incomplete");
  });

  it("rewrites a non-root metadata-safe proxy-env.sh that is missing one guard", () => {
    const result = runGuardRecovery({
      proxyEnvContent: `export NODE_OPTIONS="--require ${SAFETY_NET_GUARD.tmpPath}"\n`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.stdout).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.proxyEnvMode).toBe(0o444);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpCiao}`);
    expect(result.files.gatewayLog).toContain("proxy-env.sh missing or unsafe");
  });

  it("rebuilds an unsafe proxy-env.sh without sourcing attacker-controlled content", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        fs.writeFileSync(
          paths.proxyEnv,
          [
            `touch ${JSON.stringify(paths.hostileMarker)}`,
            "export NODE_OPTIONS='--require /tmp/attacker.js'",
            "",
          ].join("\n"),
        );
        fs.chmodSync(paths.proxyEnv, 0o666);
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PE_MISSING=0");
    expect(result.files.hostileProxyEnvSourced).toBe(false);
    expect(result.files.proxyEnvMode).toBe(0o444);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.files.proxyEnv).not.toContain("/tmp/attacker.js");
    expect(result.files.gatewayLog).toContain("unsafe mode");
    expect(result.files.gatewayLog).toContain("rebuilding from packaged preloads");
  });

  it("replaces a symlinked proxy-env.sh instead of sourcing it", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        const target = path.join(paths.root, "attacker-proxy-env.sh");
        fs.writeFileSync(target, `touch ${JSON.stringify(paths.hostileMarker)}\n`);
        fs.symlinkSync(target, paths.proxyEnv);
      },
    });
    expect(result.status).toBe(0);
    expect(result.files.hostileProxyEnvSourced).toBe(false);
    expect(result.files.proxyEnvIsSymlink).toBe(false);
    expect(result.files.proxyEnv).toContain(`--require ${result.paths.tmpSafetyNet}`);
    expect(result.files.gatewayLog).toContain("is a symlink");
  });

  it("fails closed when proxy-env.sh is a directory", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        fs.mkdirSync(paths.proxyEnv);
      },
    });
    expect(result.status).toBe(17);
    expect(result.stdout).toContain("GUARDS_MISSING");
    expect(result.files.gatewayLog).toContain("is a directory");
    expect(result.files.gatewayLog).toContain("refusing recovered proxy-env install");
  });

  it("replaces a symlinked tmp preload with a trusted staged file", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        const target = path.join(paths.root, "attacker-controlled.js");
        fs.writeFileSync(target, "module.exports = 'wrong';\n");
        fs.symlinkSync(target, paths.tmpSafetyNet);
      },
    });
    expect(result.status).toBe(0);
    expect(result.files.tmpSafetyNetIsSymlink).toBe(false);
    expect(result.files.tmpSafetyNet).toContain("trusted safety net");
  });

  it("refuses recovery when a trusted packaged preload source is unavailable", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        fs.rmSync(paths.sourceCiao);
      },
    });
    expect(result.status).toBe(17);
    expect(result.stdout).toContain("GUARDS_MISSING");
    expect(result.files.gatewayLog).toContain("trusted preload source");
    expect(result.files.gatewayLog).toContain("refusing preload install");
  });

  it("refuses recovery when a trusted packaged preload source is group writable", () => {
    const result = runGuardRecovery({
      beforeScript(paths) {
        fs.chmodSync(paths.sourceCiao, 0o664);
      },
    });
    expect(result.status).toBe(17);
    expect(result.stdout).toContain("GUARDS_MISSING");
    expect(result.files.gatewayLog).toContain("trusted preload source");
    expect(result.files.gatewayLog).toContain("unsafe mode=664");
  });

  it("refuses recovery when a trusted packaged preload source is group writable in root mode", () => {
    const result = runGuardRecovery({
      fakeRoot: true,
      beforeScript(paths) {
        fs.chmodSync(paths.sourceCiao, 0o664);
      },
    });
    expect(result.status).toBe(17);
    expect(result.stdout).toContain("GUARDS_MISSING");
    expect(result.files.gatewayLog).toContain("trusted preload source");
    expect(result.files.gatewayLog).toContain("unsafe mode=664");
  });

  it("wires the repair helper into custom-agent recovery", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("restoring library guards from packaged preloads");
    expect(script).toContain("/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js");
    expect(script).toContain("/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js");
    expect(script).not.toContain("gateway launching without library guards");
  });

  it("validates proxy-env.sh before sourcing it in gateway recovery scripts", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).not.toContain("[ -r /tmp/nemoclaw-proxy-env.sh ]; then .");
    const validateIdx = script!.indexOf(
      "_nemoclaw_validate_recovery_proxy_env /tmp/nemoclaw-proxy-env.sh",
    );
    const sourceIdx = script!.indexOf('then . "$_NEMOCLAW_RECOVERY_SOURCE_ENV"');
    expect(validateIdx).toBeGreaterThanOrEqual(0);
    expect(sourceIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeLessThan(sourceIdx);
  });

  it("validates proxy-env.sh before shell init hooks can source it", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).not.toBeNull();
    const validateIdx = script!.indexOf(
      "_nemoclaw_validate_recovery_proxy_env /tmp/nemoclaw-proxy-env.sh",
    );
    const bashrcIdx = script!.indexOf("[ -f ~/.bashrc ] && . ~/.bashrc;");
    const healthIdx = script!.indexOf("_GW_CODE=");
    expect(validateIdx).toBeGreaterThanOrEqual(0);
    expect(bashrcIdx).toBeGreaterThanOrEqual(0);
    expect(healthIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeLessThan(bashrcIdx);
    expect(bashrcIdx).toBeLessThan(healthIdx);
  });

  it("repairs guard files before health probing and the ALREADY_RUNNING fast path", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).not.toBeNull();
    const safetyNetStageIdx = script!.indexOf(
      `_nemoclaw_stage_recovery_preload ${SAFETY_NET_GUARD.tmpPath} ${SAFETY_NET_GUARD.sourcePath}`,
    );
    const ciaoStageIdx = script!.indexOf(
      `_nemoclaw_stage_recovery_preload ${CIAO_GUARD.tmpPath} ${CIAO_GUARD.sourcePath}`,
    );
    const healthIdx = script!.indexOf("_GW_CODE=");
    const alreadyRunningIdx = script!.indexOf("echo ALREADY_RUNNING; exit 0");
    expect(safetyNetStageIdx).toBeGreaterThanOrEqual(0);
    expect(ciaoStageIdx).toBeGreaterThanOrEqual(0);
    expect(healthIdx).toBeGreaterThanOrEqual(0);
    expect(alreadyRunningIdx).toBeGreaterThanOrEqual(0);
    expect(safetyNetStageIdx).toBeLessThan(healthIdx);
    expect(ciaoStageIdx).toBeLessThan(healthIdx);
    expect(healthIdx).toBeLessThan(alreadyRunningIdx);
  });
});
