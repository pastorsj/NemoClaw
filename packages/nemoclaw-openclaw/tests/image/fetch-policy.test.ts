// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
  runFetchGuardPatchBlock,
  webGuardedFetchFixtureSource,
} from "../helpers/fetch-suite";

describe("fetch-guard patch regression guard", () => {
  it("rewrites strict media fetch exports and makes proxy validation sandbox-aware", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-test.js");
    const webGuardPath = path.join(dist, "web-guarded-fetch-test.js");
    fs.writeFileSync(
      modulePath,
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
        "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
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

    try {
      const patch = runFetchGuardPatchBlock(
        dist,
        tmp,
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      expect(patch.stdout).toContain("Patch 2b applied");
      const verify = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const exports = await import(${JSON.stringify(modulePath)});
const web = await import(${JSON.stringify(webGuardPath)});
if (exports.a !== exports.b) throw new Error('strict export was not redirected to trusted env proxy mode');
await globalThis.assertExplicitProxyAllowed('http://10.200.0.1:3128');
if (globalThis.proxyChecks.length !== 0) throw new Error('sandbox proxy validation did not bypass target-policy checks');
let genericBlocked = false;
try { globalThis.assertHostnameAllowedWithPolicy('host.openshell.internal'); } catch { genericBlocked = true; }
if (!genericBlocked) throw new Error('generic SSRF helper allowed host gateway');
const trusted = await web.c({ url: 'http://host.openshell.internal:8000', useEnvProxy: true });
if (trusted.hostname !== 'host.openshell.internal') throw new Error('host gateway was not allowed through web_fetch trusted proxy');
let strictBlocked = false;
try { await web.c({ url: 'http://host.openshell.internal:8000', useEnvProxy: false }); } catch { strictBlocked = true; }
if (!strictBlocked) throw new Error('strict web_fetch allowed host gateway');
let blocked = false;
try { await web.c({ url: 'http://10.0.0.1', useEnvProxy: true }); } catch { blocked = true; }
if (!blocked) throw new Error('private IP literal was not blocked');`,
        ],
        { encoding: "utf-8", env: { ...process.env, OPENSHELL_SANDBOX: "1" }, timeout: 5000 },
      );
      expect(verify.status).toBe(0);
      expect(verify.stderr).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies the proxy validator patch while the target function still exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-skip-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-fixed.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const mediaDispatcher = {",
        "  allowPrivateProxy: true,",
        "};",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "  return proxyPolicy;",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain(
        "export { withTrustedEnvProxyGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
      );
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies a 3+ file trusted-proxy-only layout as Patch 1 not needed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-strict-skip-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const mediaRuntimePath = path.join(dist, "media-runtime.js");
    const mediaAttachmentPath = path.join(dist, "media-attachment.js");
    const mediaRuntimeSource = [
      "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
      "async function fetchGuardedMediaResponse() {",
      "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
      "}",
      "export { withTrustedEnvProxyGuardedFetchMode as a, fetchGuardedMediaResponse as b };",
      "",
    ].join("\n");
    const mediaAttachmentSource = [
      "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
      "async function fetchGuardedMediaResponse() {",
      "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'https://example.com/media' }));",
      "}",
      "export { withTrustedEnvProxyGuardedFetchMode as a, fetchGuardedMediaResponse as b };",
      "",
    ].join("\n");
    const mediaOtherSource = mediaAttachmentSource.replace("/media'", "/other'");
    fs.writeFileSync(mediaRuntimePath, mediaRuntimeSource);
    fs.writeFileSync(mediaAttachmentPath, mediaAttachmentSource);
    fs.writeFileSync(path.join(dist, "media-other.js"), mediaOtherSource);

    expect(`${mediaRuntimeSource}\n${mediaAttachmentSource}\n${mediaOtherSource}`).not.toContain(
      "withStrictGuardedFetchMode",
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 not needed");
      expect(patch.stdout).toContain("Patch 2 not needed");
      expect(fs.readFileSync(mediaRuntimePath, "utf-8")).toBe(mediaRuntimeSource);
      expect(fs.readFileSync(mediaAttachmentPath, "utf-8")).toBe(mediaAttachmentSource);
      expect(fs.readFileSync(path.join(dist, "media-other.js"), "utf-8")).toBe(mediaOtherSource);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the proxy validator patch when pinned hostname checks are not proxy-related", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-target-hostname-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-target-hostname.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse(targetUrl) {",
        "  const parsedTargetUrl = new URL(targetUrl);",
        "  await resolvePinnedHostnameWithPolicy(parsedTargetUrl.hostname, {});",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 not needed");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).not.toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when strict export disappears without a reviewed trusted fetch callsite", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-unreviewed-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-unreviewed.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const withDefaultGuardedFetchMode = Symbol('default');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withDefaultGuardedFetchMode({}));",
        "}",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "  return proxyPolicy;",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dist, "unrelated-trusted-fetch.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchProfile() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout",
      );
      expect(patch.stderr).toContain("Patch 1 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed with actionable details when strict export disappears but strict references remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-unknown-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const stillUsesStrict = 'withStrictGuardedFetchMode';",
        "async function assertExplicitProxyAllowed(proxyUrl) { return proxyUrl; }",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout",
      );
      expect(patch.stderr).toContain("Patch 1 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the proxy validator target disappears but proxy hostname checks remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-unknown-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-proxy-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "async function validateExplicitProxy(proxyUrl) {",
        "  const parsedProxyUrl = new URL(proxyUrl);",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {});",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2 target missing but proxy hostname validation references remain",
      );
      expect(patch.stderr).toContain("Patch 2 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the web_fetch trusted-proxy callsite disappears but web fetch refs remain", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-host-gateway-unknown-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "ssrf-host-gateway-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const webFetchConfig = { useTrustedEnvProxy: true };",
        "async function runWebFetch() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "const toolName = 'web_fetch';",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2b target missing but web_fetch/trusted-proxy references remain",
      );
      expect(patch.stderr).toContain("Patch 2b cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the web_fetch target disappears but the runtime useEnvProxy symbol remains", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-use-env-proxy-unknown-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "ssrf-host-gateway-use-env-proxy-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "async function renamedWebToolsNetworkGuard(params) {",
        "  const { useEnvProxy, ...rest } = params;",
        "  return useEnvProxy ? rest : { ...rest, strict: true };",
        "}",
        "export { renamedWebToolsNetworkGuard as t };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2b target missing but web_fetch/trusted-proxy references remain",
      );
      expect(patch.stderr).toContain("Patch 2b cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when a renamed proxy validator uses an intermediate hostname variable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-renamed-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-proxy-renamed.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "async function validateProxyUrl(proxyUrl) {",
        "  const parsedProxyUrl = new URL(proxyUrl);",
        "  const proxyHostname = parsedProxyUrl.hostname;",
        "  await resolvePinnedHostnameWithPolicy(proxyHostname, {",
        "    policy: { allowPrivateNetwork: true }",
        "  });",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2 target missing but proxy hostname validation references remain",
      );
      expect(patch.stderr).toContain("Patch 2 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch when only comments match the reviewed shape", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-comments-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-comments.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  // const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "  // hostnameAllowlist: void 0,",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, { policy });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch without private proxy allowance", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-private-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-no-private.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch for unrelated reviewed-shape code", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-opt-in-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-unrelated-shape.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const someDispatcher = {",
        "  allowPrivateProxy: true,",
        "};",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy",
        "  });",
        "}",
        "function unrelatedReviewedShape(dispatcherPolicy, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  return resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
