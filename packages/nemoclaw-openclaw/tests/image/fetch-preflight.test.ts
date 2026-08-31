// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
  REVIEWED_OPENCLAW_2026_7_1_MANAGED_PROXY_SHAPE,
  runFetchGuardPatchBlock,
} from "../helpers/fetch-suite";

describe("fetch-guard patch regression guard", () => {
  it("activates the managed-proxy path for unconfigured strict fetches only inside the sandbox (#4687)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-managed-proxy.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const GUARDED_FETCH_MODE = { STRICT: 'strict' };",
        "function isManagedProxyActive() { return process.env.OPENCLAW_PROXY_ACTIVE === '1'; }",
        "function hasProxyEnvConfigured() { return true; }",
        "function computeCanUseManagedProxy(mode, params) {",
        "  const dispatcherPolicy = params.dispatcherPolicy;",
        `  ${REVIEWED_OPENCLAW_2026_7_1_MANAGED_PROXY_SHAPE}`,
        "  const canUseManagedProxy = isStrictManagedProxyActive && hasProxyEnvConfigured();",
        "  return canUseManagedProxy;",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b, computeCanUseManagedProxy as g };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(
        dist,
        tmp,
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 4 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: route unconfigured strict fetch");

      const mod = await import(`${modulePath}?${Date.now()}`);
      const prevSandbox = process.env.OPENSHELL_SANDBOX;
      const prevManaged = process.env.OPENCLAW_PROXY_ACTIVE;
      try {
        // In-sandbox, no explicit dispatcher policy -> reuse the env proxy.
        process.env.OPENSHELL_SANDBOX = "1";
        delete process.env.OPENCLAW_PROXY_ACTIVE;
        expect(mod.g("strict", {})).toBe(true);
        // In-sandbox but an explicit dispatcher policy is supplied -> untouched.
        expect(mod.g("strict", { dispatcherPolicy: { mode: "explicit-proxy" } })).toBe(false);
        // Outside the sandbox -> original strict/direct behavior is preserved.
        delete process.env.OPENSHELL_SANDBOX;
        expect(mod.g("strict", {})).toBe(false);
        // Upstream managed-proxy activation still works regardless of sandbox.
        process.env.OPENCLAW_PROXY_ACTIVE = "1";
        expect(mod.g("strict", {})).toBe(true);
        // Non-strict modes never take the managed-proxy branch.
        process.env.OPENSHELL_SANDBOX = "1";
        delete process.env.OPENCLAW_PROXY_ACTIVE;
        expect(mod.g("trusted_env_proxy", {})).toBe(false);
      } finally {
        if (prevSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
        else process.env.OPENSHELL_SANDBOX = prevSandbox;
        if (prevManaged === undefined) delete process.env.OPENCLAW_PROXY_ACTIVE;
        else process.env.OPENCLAW_PROXY_ACTIVE = prevManaged;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports Patch 4 not needed when the managed-proxy gate is absent", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-absent-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-no-managed-proxy.js"),
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 4 not needed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the managed-proxy gate drifts but managed-proxy references remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-managed-proxy-drift.js"),
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "function isManagedProxyActive() { return process.env.OPENCLAW_PROXY_ACTIVE === '1'; }",
        "function proxyEnvSet() { return true; }",
        // Drifted shape: renamed variables, so the exact reviewed gate is gone.
        "const canUseManagedProxy = currentMode === 'strict' && isManagedProxyActive() && proxyEnvSet();",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 4 target missing but managed-proxy references remain");
      expect(patch.stderr).toContain("Patch 4 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function reviewedCronPreflightFixture({
    auditOccurrences = 1,
    includeFetchWithSsrFGuard = true,
    includeBuildLocalProviderSsrFPolicy = true,
    patchedOccurrences = 0,
  }: {
    auditOccurrences?: number;
    includeFetchWithSsrFGuard?: boolean;
    includeBuildLocalProviderSsrFPolicy?: boolean;
    patchedOccurrences?: number;
  } = {}): string {
    const lines: string[] = [
      "const PREFLIGHT_TIMEOUT_MS = 2500;",
      "function buildProbeUrl(api, baseUrl) { return baseUrl + (api === 'ollama' ? '/api/tags' : '/models'); }",
    ];
    const policyHelper = includeBuildLocalProviderSsrFPolicy
      ? "buildLocalProviderSsrFPolicy"
      : "buildDriftedSsrFPolicy";
    if (includeBuildLocalProviderSsrFPolicy) {
      lines.push(
        "function buildLocalProviderSsrFPolicy(baseUrl) {",
        "  const parsed = new URL(baseUrl);",
        "  return { hostnameAllowlist: [parsed.hostname], allowPrivateNetwork: true };",
        "}",
      );
    } else {
      lines.push(
        "function buildDriftedSsrFPolicy(baseUrl) {",
        "  const parsed = new URL(baseUrl);",
        "  return { hostnameAllowlist: [parsed.hostname] };",
        "}",
      );
    }
    lines.push("async function probeLocalProviderEndpoint(params) {");
    for (let index = 0; index < patchedOccurrences; index += 1) {
      lines.push(
        `  const ${index === 0 ? "patched" : `patched_${index}`} = await ${
          includeFetchWithSsrFGuard ? "fetchWithSsrFGuard" : "callPatchedFetch"
        }({`,
        `    url: buildProbeUrl(params.api, params.baseUrl),`,
        `    policy: ${policyHelper}(params.baseUrl),`,
        `    timeoutMs: PREFLIGHT_TIMEOUT_MS,`,
        `    mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight",`,
        "  });",
      );
    }
    for (let index = 0; index < auditOccurrences - patchedOccurrences; index += 1) {
      lines.push(
        `  const ${index === 0 ? "result" : `result_${index}`} = await ${
          includeFetchWithSsrFGuard ? "fetchWithSsrFGuard" : "callUnpatchedFetch"
        }({`,
        `    url: buildProbeUrl(params.api, params.baseUrl),`,
        `    policy: ${policyHelper}(params.baseUrl),`,
        `    timeoutMs: PREFLIGHT_TIMEOUT_MS,`,
        `    auditContext: "cron-model-provider-preflight",`,
        "  });",
      );
    }
    lines.push(
      "  return null;",
      "}",
      "export { probeLocalProviderEndpoint, preflightCronModelProvider };",
      "function preflightCronModelProvider() {}",
      "",
    );
    return lines.join("\n");
  }

  function writeNeighbouringFetchGuardFixtures(dist: string): void {
    // Earlier patches in the same RUN block (1, 2, 2b, 4) only need the dist to
    // navigate their "not needed" branches; mirror the trusted-proxy-only
    // classification proven by the dedicated two-file regression test so
    // execution reaches Patch 6 without classifying the dist as unknown.
    fs.writeFileSync(
      path.join(dist, "media-runtime.js"),
      "export { readRemoteMediaBuffer, saveRemoteMedia, fetchRemoteMedia };\n",
    );
    fs.writeFileSync(
      path.join(dist, "fetch-guard-neighbour.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );
  }

  it("applies Patch 6 to reviewed and formatting-variant cron preflight fixtures", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-happy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    const preflightPath = path.join(dist, "model-preflight.runtime.js");
    fs.writeFileSync(preflightPath, reviewedCronPreflightFixture());
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain(
        "Patch 6 applied to OpenClaw 2026.7.1 cron preflight trusted env-proxy",
      );
      const patched = fs.readFileSync(preflightPath, "utf-8");
      expect(
        patched.match(/mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"/g)
          ?.length,
      ).toBe(1);
      expect(patched).not.toMatch(/(?<!_proxy", )auditContext: "cron-model-provider-preflight"/);
      fs.writeFileSync(
        preflightPath,
        reviewedCronPreflightFixture().replace(
          'auditContext: "cron-model-provider-preflight"',
          "auditContext  :  'cron-model-provider-preflight'",
        ),
      );
      const variantPatch = runFetchGuardPatchBlock(dist, tmp);
      expect(variantPatch.status, `${variantPatch.stdout}${variantPatch.stderr}`).toBe(0);
      expect(fs.readFileSync(preflightPath, "utf-8")).toContain(
        `mode: "trusted_env_proxy", auditContext  :  'cron-model-provider-preflight'`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats an already-patched cron preflight fixture as a no-op", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-idempotent-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    const preflightPath = path.join(dist, "model-preflight.runtime.js");
    const source = reviewedCronPreflightFixture({ auditOccurrences: 1, patchedOccurrences: 1 });
    fs.writeFileSync(preflightPath, source);
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 6 already present in");
      expect(patch.stdout).not.toContain("Patch 6 applied to OpenClaw");
      expect(fs.readFileSync(preflightPath, "utf-8")).toBe(source);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips Patch 6 when the dist has no cron preflight references", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-absent-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain(
        "OpenClaw 2026.7.1 has no cron model-provider preflight; Patch 6 not needed",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the fetchWithSsrFGuard helper is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-no-fetch-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ includeFetchWithSsrFGuard: false }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("no fetchWithSsrFGuard call");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the SsrF policy helper is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-no-policy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ includeBuildLocalProviderSsrFPolicy: false }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("no buildLocalProviderSsrFPolicy");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the audit context literal is ambiguous (multi-callsite)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-ambiguous-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ auditOccurrences: 2 }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("refusing ambiguous multi-callsite rewrite");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
