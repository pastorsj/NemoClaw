// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
  DOCKERFILE_BASE,
  REVIEWED_OPENCLAW_2026_7_1_WEB_FETCH_SHAPE,
  dockerRunCommandBetween,
  readDockerfileMcporterVersion,
  readRequiredMatch,
  runDockerfilePatchBlock,
  runOpenClawUpgradeBlock,
  webGuardedFetchFixtureSource,
} from "../helpers/fetch-suite";

describe("fetch-guard patch regression guard", () => {
  it("anchors web_fetch proxy mode to the reviewed OpenClaw 2026.7.1 contract", () => {
    expect(REVIEWED_OPENCLAW_2026_7_1_WEB_FETCH_SHAPE).toContain(
      "function fetchWithWebToolsNetworkGuard(params)",
    );
    expect(REVIEWED_OPENCLAW_2026_7_1_WEB_FETCH_SHAPE).toContain(
      "withTrustedEnvProxyGuardedFetchMode(resolved)",
    );
  });

  it("fails the image build when the NemoClaw OpenClaw plugin cannot install", () => {
    const command = dockerRunCommandBetween(
      "# Install NemoClaw plugin into OpenClaw",
      "# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.",
    );
    const script = [
      "openclaw() {",
      '  if [ "${1:-} ${2:-} ${3:-}" = "plugins install /opt/nemoclaw" ]; then',
      '    [ "${NPM_CONFIG_IGNORE_SCRIPTS:-}" = "true" ] || return 43',
      '    [ "${npm_config_ignore_scripts:-}" = "true" ] || return 44',
      "    return 42",
      "  fi",
      "  return 0",
      "}",
      command,
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
    expect(result.status).toBe(42);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-install-"));
    const inspectMarker = path.join(tmp, "inspected");
    const successScript = [
      "openclaw() {",
      '  case "${1:-} ${2:-} ${3:-}" in',
      '    "plugins install /opt/nemoclaw") echo "installed" ;;',
      `    "plugins inspect nemoclaw") : > ${JSON.stringify(inspectMarker)} ;;`,
      '    "plugins enable nemoclaw") return 43 ;;',
      "  esac",
      "  return 0",
      "}",
      command,
    ].join("\n");
    const success = spawnSync("bash", ["-c", successScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(success.status).toBe(0);
    expect(fs.existsSync(inspectMarker)).toBe(true);
  });

  it("installs the reviewed locked graph for stale and same-version OpenClaw bases", () => {
    const stale = runOpenClawUpgradeBlock("2026.3.11");
    expect(stale.result.status, stale.result.stderr).toBe(0);
    expect(stale.result.stdout).toContain(
      `Base image OpenClaw 2026.3.11 lacks matching reviewed provenance; installing ${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}`,
    );
    expect(stale.calls).toMatch(
      /npm --prefix \S+\/openclaw-runtime ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress/,
    );
    expect(stale.calls).toContain("postinstall-bundled-plugins.mjs");
    expect(stale.calls).not.toContain("npm install -g");
    expect(stale.calls).not.toContain("npm pack");

    const current = runOpenClawUpgradeBlock(CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION);
    expect(current.result.status, current.result.stderr).toBe(0);
    expect(current.result.stdout).toContain(
      `Base image OpenClaw ${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION} lacks matching reviewed provenance; installing ${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}`,
    );
    expect(current.calls).toMatch(
      /npm --prefix \S+\/openclaw-runtime ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress/,
    );
    expect(current.calls).toContain("postinstall-bundled-plugins.mjs");
    expect(current.calls).not.toContain("npm install -g");
    expect(current.calls).not.toContain("npm pack");

    const newer = runOpenClawUpgradeBlock("2026.7.2");
    expect(newer.result.status).toBe(1);
    expect(newer.result.stderr).toContain(
      "newer than reviewed target " + CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
    );
    expect(newer.calls).not.toContain(
      `npm pack https://registry.npmjs.org/openclaw/-/openclaw-${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}.tgz --pack-destination`,
    );
    expect(newer.calls).not.toContain("npm install -g --no-audit --no-fund --no-progress ");
  });

  it("reinstalls mcporter from the committed graph when the inherited version matches", () => {
    const invocation = runOpenClawUpgradeBlock(CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION);
    const expectedMcporterVersion = readDockerfileMcporterVersion();

    expect(invocation.result.status, invocation.result.stderr).toBe(0);
    expect(invocation.result.stdout).toContain(
      `Installing locked mcporter ${expectedMcporterVersion} dependency graph`,
    );
    expect(invocation.calls).toMatch(
      /npm --prefix \S+ ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress/,
    );
    expect(invocation.calls).toContain("StreamableHTTPServerTransport");
    expect(invocation.calls).toMatch(
      /node --experimental-strip-types \/scripts\/lib\/reviewed-npm-audit\.mts --directory \S+ --exceptions \S+ --graph mcporter-runtime --threshold high/,
    );
    expect(invocation.calls).not.toContain("audit signatures");
    readRequiredMatch(
      DOCKERFILE_BASE,
      /(npm --prefix \/usr\/local\/lib\/nemoclaw\/mcporter-runtime ci\s*\\\s*--ignore-scripts --omit=dev --no-audit --no-fund --no-progress)/,
      "mcporter base lockfile install with lifecycle scripts disabled",
    );
    expect(
      dockerRunCommandBetween(
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
    ).toContain("rm -rf /usr/local/lib/node_modules/mcporter /usr/local/bin/mcporter");
  });

  it("applies the Dockerfile OpenClaw compatibility patch block to executable fixtures", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-patches-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const symlinkTarget = path.join(tmp, "real-install-base");
    const symlinkBase = path.join(tmp, "install-base-link");
    fs.mkdirSync(symlinkTarget);
    fs.symlinkSync(symlinkTarget, symlinkBase);

    const fetchGuardPath = path.join(dist, "fetch-guard-fixture.js");
    const webGuardPath = path.join(dist, "web-guarded-fetch-fixture.js");
    const installSafePath = path.join(dist, "install-safe-path-fixture.js");
    const installPackageDirPath = path.join(dist, "install-package-dir-fixture.js");
    const clientPath = path.join(dist, "client-fixture.js");
    const serverPath = path.join(dist, "server.impl-fixture.js");

    fs.writeFileSync(
      fetchGuardPath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "globalThis.proxyChecks = [];",
        "globalThis.hostnameChecks = [];",
        "async function assertExplicitProxyAllowed(proxyUrl) { globalThis.proxyChecks.push(proxyUrl); throw new Error('proxy rejected'); }",
        "function normalizeHostname(value) { return String(value || '').toLowerCase().replace(/\\.+$/, ''); }",
        "function resolveHostnamePolicyChecks(hostname, policy) {",
        "  const normalized = normalizeHostname(hostname);",
        "  globalThis.hostnameChecks.push(normalized);",
        "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '169.254.169.254' || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
        "  return { normalized, skipPrivateNetworkChecks: false };",
        "}",
        "function assertHostnameAllowedWithPolicy(hostname, policy) { return resolveHostnamePolicyChecks(hostname, policy).normalized; }",
        "globalThis.assertExplicitProxyAllowed = assertExplicitProxyAllowed;",
        "globalThis.assertHostnameAllowedWithPolicy = assertHostnameAllowedWithPolicy;",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(webGuardPath, webGuardedFetchFixtureSource());
    fs.writeFileSync(
      installSafePath,
      [
        'import fs from "node:fs/promises";',
        "export async function acceptsBaseDir(baseDir) {",
        "  const baseLstat = await fs.lstat(baseDir);",
        "  return baseLstat.isDirectory();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      installPackageDirPath,
      [
        'import fs from "node:fs/promises";',
        "export async function assertInstallBaseStable(params) {",
        "  const baseLstat = await fs.lstat(params.installBaseDir);",
        "  if (baseLstat.isSymbolicLink()) throw new Error('symlink');",
        "  if (await fs.realpath(params.installBaseDir) !== params.expectedRealPath) throw new Error('drift');",
        "  return baseLstat.isDirectory();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(clientPath, "export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n");
    fs.writeFileSync(serverPath, "export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n");

    try {
      const patch = runDockerfilePatchBlock(
        dist,
        tmp,
        "# Patch OpenClaw chat.send gateway behavior",
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      expect(patch.stdout).toContain("Patch 2b applied");

      const fetchGuard = await import(`${fetchGuardPath}?${Date.now()}`);
      expect(fetchGuard.a).toBe(fetchGuard.b);
      const previousSandboxEnv = process.env.OPENSHELL_SANDBOX;
      process.env.OPENSHELL_SANDBOX = "1";
      try {
        await (globalThis as any).assertExplicitProxyAllowed("http://10.200.0.1:3128");
        await import(`${webGuardPath}?${Date.now()}`);
        const trusted = await (globalThis as any).fetchWithWebToolsNetworkGuard({
          url: "http://host.openshell.internal:8000",
          useEnvProxy: true,
        });
        expect(trusted.hostname).toBe("host.openshell.internal");
        expect(trusted.policy).toEqual({
          allowedHostnames: ["host.openshell.internal"],
        });
        expect(() =>
          (globalThis as any).assertHostnameAllowedWithPolicy("host.openshell.internal"),
        ).toThrow(/blocked host\.openshell\.internal/);
        delete process.env.OPENSHELL_SANDBOX;
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://host.openshell.internal:8000",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked host\.openshell\.internal/);
        process.env.OPENSHELL_SANDBOX = "1";
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://host.openshell.internal:8000",
            useEnvProxy: false,
          }),
        ).rejects.toThrow(/blocked host\.openshell\.internal/);
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://foo.internal",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked foo\.internal/);
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://169.254.169.254",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked 169\.254\.169\.254/);
      } finally {
        if (previousSandboxEnv === undefined) {
          delete process.env.OPENSHELL_SANDBOX;
        } else {
          process.env.OPENSHELL_SANDBOX = previousSandboxEnv;
        }
      }
      expect((globalThis as any).proxyChecks).toEqual([]);
      expect((globalThis as any).hostnameChecks).toEqual([
        {
          normalized: "host.openshell.internal",
          policy: { allowedHostnames: ["host.openshell.internal"] },
        },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "foo.internal", policy: undefined },
        { normalized: "169.254.169.254", policy: undefined },
      ]);

      const installSafe = await import(`${installSafePath}?${Date.now()}`);
      await expect(installSafe.acceptsBaseDir(symlinkBase)).resolves.toBe(true);

      const installPackageDir = await import(`${installPackageDirPath}?${Date.now()}`);
      await expect(
        installPackageDir.assertInstallBaseStable({
          installBaseDir: symlinkBase,
          expectedRealPath: fs.realpathSync(symlinkBase),
        }),
      ).resolves.toBe(true);

      const client = await import(`${clientPath}?${Date.now()}`);
      const server = await import(`${serverPath}?${Date.now()}`);
      expect(client.DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS).toBe(60_000);
      expect(server.DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS).toBe(60_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
