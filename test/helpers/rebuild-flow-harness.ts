// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { HarnessPackageIdentity } from "../../src/lib/harness/package-types";
import { createHarnessPackageFixture, type HarnessPackageFixture } from "./harness-packages";
import { type RebuildSandbox, snapshotEnv } from "./rebuild-flow-test-support";

export * from "./rebuild-flow-test-support";

const requireDist = createRequire(
  new URL("../../src/lib/actions/sandbox/rebuild.ts", import.meta.url),
);
const rebuildModulePath = "./rebuild.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];

// Cache stable dependency modules outside each test's timeout. The rebuild
// entry itself is still reloaded after these modules receive fresh spies.
export const agentDefs = requireDist("../../agent/defs.js");
export const agentOnboard = requireDist("../../agent/onboard.js");
export const agentRuntime = requireDist("../../agent/runtime.js");
export const buildContextFingerprint = requireDist(
  "../../adapters/fs/build-context-fingerprint.js",
);
export const destroy = requireDist("./destroy.js");
export const dockerImage = requireDist("../../adapters/docker/image.js");
export const dockerInspect = requireDist("../../adapters/docker/inspect.js");
export const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
export const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
export const gatewayState = requireDist("./gateway-state.js");
export const gatewayTeardownAuthority = requireDist(
  "../../onboard/gateway-teardown-authority.js",
) as typeof import("../../src/lib/onboard/gateway-teardown-authority");
export const hermesProviderAuth = requireDist("../../hermes-provider-auth.js");
export const mcpBridge = requireDist("./mcp-bridge.js");
export const messaging = requireDist("../../messaging/index.js");
export const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
export const nim = requireDist("../../inference/nim.js");
export const onboardCredentialEnv = requireDist("../../onboard/credential-env.js");
export const onboardSession = requireDist("../../state/onboard-session.js");
export const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
export const policies = requireDist("../../policy/index.js");
export const portableAgentLifecycle = requireDist(
  "../../onboard/experimental/portable-agent-lifecycle.js",
);
export const processRecovery = requireDist("./process-recovery.js");
export const { rebuildOnboardDependencies } = requireDist("./rebuild-onboard-dependencies.js");
export const rebuildCustomImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
export const rebuildFlowHelpers = requireDist("./rebuild-flow-helpers.js");
export const rebuildInference = requireDist("./inference-invocation-probe.js");
export const rebuildManagedImage = requireDist("./rebuild-managed-image-preflight.js");
export const rebuildMessagingConflict = requireDist("./rebuild-messaging-conflict-preflight.js");
export const rebuildPreparedImageContext = requireDist("./rebuild-prepared-image-context.js");
export const rebuildRoutePreflight = requireDist("./rebuild-preflight-guards.js");
export const rebuildShields = requireDist("./rebuild-shields.js");
export const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
export const registry = requireDist("../../state/registry.js");
export const registryPersistence = requireDist("../../state/registry/persistence.js");
export const resolve = requireDist("../../adapters/openshell/resolve.js");
export const sandboxList = requireDist("../../openshell-sandbox-list.js");
export const sandboxAgent = requireDist("../../onboard/sandbox-agent.js");
export const sandboxSession = requireDist("../../state/sandbox-session.js");
export const sandboxState = requireDist("../../state/sandbox.js");
export const sandboxVersion = requireDist("../../sandbox/version.js");
export const shields = requireDist("../../shields/index.js");

export function purgeRebuildModule(): void {
  delete require.cache[requireDist.resolve(rebuildModulePath)];
}

export function loadRebuildSandbox(): RebuildSandbox {
  return requireDist(rebuildModulePath).rebuildSandbox;
}

export function sourceSandboxGateway(argv: string[], verb: string): string | null {
  const gatewayFlag = argv.indexOf("-g");
  return argv[0] === "sandbox" && argv[1] === verb && argv.at(-1) === "alpha" && gatewayFlag > 0
    ? (argv[gatewayFlag + 1] ?? null)
    : null;
}

const harnessTempDirs: string[] = [];
const harnessCleanupCallbacks: Array<() => void> = [];
const REBUILD_HOME_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-rebuild-homes");
const harnessPackageFixtures = new Map<
  string,
  {
    readonly fixture: HarnessPackageFixture;
    readonly identities: Map<string, HarnessPackageIdentity>;
  }
>();

export function createHarnessTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  harnessTempDirs.push(dir);
  return dir;
}

const STANDARD_REBUILD_HARNESS_IDS = new Set(["openclaw", "hermes", "langchain-deepagents-code"]);

/** Install exact standard-harness authority under an isolated rebuild-test home. */
export function installRebuildHarnessPackage(agentName: string): HarnessPackageIdentity | null {
  if (!STANDARD_REBUILD_HARNESS_IDS.has(agentName)) return null;
  const testHome = process.env.HOME?.trim();
  if (!testHome) throw new Error("Rebuild harness tests require an isolated HOME.");
  const storeRoot = path.join(fs.realpathSync(testHome), ".nemoclaw", "harnesses");
  let state = harnessPackageFixtures.get(storeRoot);
  if (!state) {
    const fixture = createHarnessPackageFixture({ storeRoot });
    state = { fixture, identities: new Map() };
    harnessPackageFixtures.set(storeRoot, state);
    harnessCleanupCallbacks.push(() => {
      fixture.cleanup();
      harnessPackageFixtures.delete(storeRoot);
    });
  }
  const installed = state.identities.get(agentName);
  if (installed) return installed;
  const identity = state.fixture.install(
    agentName as "openclaw" | "hermes" | "langchain-deepagents-code",
  ).identity;
  state.identities.set(agentName, identity);
  return identity;
}

export type RebuildFlowTestHookOptions = {
  acceptThirdPartySoftware?: boolean;
};

export function installRebuildFlowTestHooks(options: RebuildFlowTestHookOptions = {}): void {
  const restoreRebuildFlowEnv = snapshotEnv([
    "HOME",
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
    "NEMOCLAW_SANDBOX_NAME",
  ]);
  beforeEach(() => {
    fs.mkdirSync(REBUILD_HOME_PARENT, { recursive: true, mode: 0o700 });
    fs.chmodSync(REBUILD_HOME_PARENT, 0o700);
    const testHome = fs.mkdtempSync(path.join(REBUILD_HOME_PARENT, "home-"));
    fs.chmodSync(testHome, 0o700);
    harnessTempDirs.push(testHome);
    process.env.HOME = testHome;
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    if (options.acceptThirdPartySoftware) {
      process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
    } else {
      delete process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE;
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    purgeRebuildModule();
    for (const dir of harnessTempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const cleanup of harnessCleanupCallbacks.splice(0)) cleanup();
    restoreRebuildFlowEnv();
  });
}
