// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PackageTestMove = {
  source: string;
  destination: string;
};

function createTestMoveRecords(
  testMoves: Readonly<Record<string, string>>,
): readonly PackageTestMove[] {
  return Object.entries(testMoves).map(([source, destination]) => ({ source, destination }));
}

export const hermesPackageTestMoves = createTestMoveRecords({
  "test/e2e/support/hermes-langfuse-credential-patch.test.ts":
    "tests/compat/langfuse-credentials.test.ts",
  "test/hermes-api-port-startup.test.ts": "tests/runtime/port-startup.test.ts",
  "test/hermes-cli-adapter-validator.test.ts": "tests/runtime/cli-adapter.test.ts",
  "test/hermes-cron-execution-runtime-patch.test.ts": "tests/compat/cron-execution.test.ts",
  "test/hermes-cron-restore-drain-patch.test.ts": "tests/compat/cron-drain.test.ts",
  "test/hermes-dashboard-credential-launch.test.ts": "tests/runtime/dashboard-launch.test.ts",
  "test/hermes-dashboard-profile-migration-security.test.ts":
    "tests/config/profile-migration.test.ts",
  "test/hermes-dashboard-provisioning.test.ts": "tests/runtime/dashboard-provisioning.test.ts",
  "test/hermes-gateway-pid-cleanup.test.ts": "tests/runtime/pid-cleanup.test.ts",
  "test/hermes-gateway-process-identity-patch.test.ts": "tests/compat/gateway-identity.test.ts",
  "test/hermes-gateway-runtime-metadata-patch.test.ts": "tests/compat/gateway-metadata.test.ts",
  "test/hermes-image-build-probes.test.ts": "tests/image/build-probes.test.ts",
  "test/hermes-managed-policy.test.ts": "tests/config/managed-policy.test.ts",
  "test/hermes-mcp-runtime-capability.test.ts": "tests/image/mcp-runtime.test.ts",
  "test/hermes-mcp-credential-boundary-manifest.test.ts":
    "tests/runtime/credential-manifest.test.ts",
  "test/hermes-neutral-platform-env-activation.test.ts":
    "tests/runtime/platform-activation.test.ts",
  "test/hermes-nonroot-strict-hash-reconciliation.test.ts": "tests/runtime/hash-reconcile.test.ts",
  "test/hermes-openshell-runtime-env-boundary.test.ts": "tests/runtime/openshell-env.test.ts",
  "test/hermes-plugin-handlers.test.ts": "tests/runtime/plugin-handlers.test.ts",
  "test/hermes-profile-policy-defaults.test.ts": "tests/config/policy-defaults.test.ts",
  "test/hermes-restart-config-seal-recovery.test.ts": "tests/runtime/seal-recovery.test.ts",
  "test/hermes-restart-config-seal-transition.test.ts": "tests/runtime/seal-transition.test.ts",
  "test/hermes-restart-config-seal-write-lock.test.ts": "tests/runtime/config-write.test.ts",
  "test/hermes-secret-boundary-api-key.test.ts": "tests/runtime/secret-boundary.test.ts",
  "test/hermes-share-mount-deps.test.ts": "tests/image/share-mount.test.ts",
  "test/hermes-sqlite-temp-store-patch.test.ts": "tests/compat/sqlite-store.test.ts",
  "test/hermes-tool-gateway-runtime-credentials.test.ts": "tests/host/runtime-credentials.test.ts",
  "test/hermes-whatsapp-dashboard-session-patch.test.ts": "tests/compat/whatsapp-session.test.ts",
  "test/hermes-wrapper-oneshot-routing.test.ts": "tests/runtime/oneshot-routing.test.ts",
  "test/hermes-wrapper-provider-merge.test.ts": "tests/runtime/provider-merge.test.ts",
  "test/package-contract/hermes-standalone-package.test.ts": "tests/integration/standalone.test.ts",
  "test/repro-2376.test.ts": "tests/image/shell-profile.test.ts",
  "test/seed-hermes-dashboard-config.test.ts": "tests/config/dashboard-seed.test.ts",
});

export const hermesNemoclawTestMoves = createTestMoveRecords({
  "test/agents/hermes/hermes-config-transaction-wiring.test.ts":
    "tests/integration/config-transaction.test.ts",
  "test/agents/hermes/hermes-discord-credential-binding.test.ts":
    "tests/integration/discord-binding.test.ts",
  "test/agents/hermes/hermes-home-channel-snapshot.test.ts":
    "tests/integration/home-snapshot.test.ts",
  "test/agents/hermes/hermes-kanban-snapshot.test.ts": "tests/integration/kanban-snapshot.test.ts",
  "test/agents/hermes/hermes-mcp-credential-revision.test.ts":
    "tests/runtime/credential-revision.test.ts",
  "test/agents/hermes/hermes-mcp-startup-probe.test.ts": "tests/integration/mcp-probe.test.ts",
  "test/agents/hermes/hermes-provider-foundation.test.ts":
    "tests/integration/provider-onboarding.test.ts",
  "test/agents/hermes/hermes-release-supplement.test.ts":
    "tests/integration/release-supplement.test.ts",
  "test/agents/hermes/hermes-state-ledger-snapshot.test.ts":
    "tests/integration/state-snapshot.test.ts",
  "test/agents/hermes/nemohermes-alias.test.ts": "tests/integration/cli-alias.test.ts",
  "test/agents/hermes/reviewed-hermes-platform-action.test.ts":
    "tests/integration/platform-resolver.test.ts",
  "test/generate-hermes-config.test.ts": "tests/config/generator.test.ts",
  "test/hermes-api-port-marker.test.ts": "tests/runtime/port-marker.test.ts",
  "test/hermes-cron-restore-control.test.ts": "tests/runtime/cron-restore.test.ts",
  "test/hermes-dependency-review.test.ts": "tests/image/dependency-review.test.ts",
  "test/hermes-discord-recovery-permissions.test.ts": "tests/runtime/discord-recovery.test.ts",
  "test/hermes-doctor-config-hash.test.ts": "tests/runtime/doctor-hash.test.ts",
  "test/hermes-env-secret-boundary-hardening.test.ts": "tests/config/secret-boundary.test.ts",
  "test/hermes-final-image-layout.test.ts": "tests/image/final-layout.test.ts",
  "test/hermes-gateway-auxiliary-retry.test.ts": "tests/runtime/gateway-retry.test.ts",
  "test/hermes-gateway-supervisor-recovery.test.ts": "tests/runtime/supervisor-recovery.test.ts",
  "test/hermes-gateway-wrapper.test.ts": "tests/runtime/gateway-wrapper.test.ts",
  "test/hermes-lazy-dependency-lifecycle.test.ts": "tests/image/lazy-dependencies.test.ts",
  "test/hermes-light-skin-boundary.test.ts": "tests/compat/light-skin.test.ts",
  "test/hermes-loader.test.ts": "tests/runtime/module-loader.test.ts",
  "test/hermes-managed-exit-authorization.test.ts": "tests/runtime/exit-authorization.test.ts",
  "test/hermes-mcp-api-port.test.ts": "tests/runtime/mcp-port.test.ts",
  "test/hermes-mcp-apply-race.test.ts": "tests/runtime/apply-race.test.ts",
  "test/hermes-mcp-config-transaction.test.ts": "tests/runtime/mcp-transaction.test.ts",
  "test/hermes-mcp-force-cleanup.test.ts": "tests/runtime/force-cleanup.test.ts",
  "test/hermes-mcp-integrity-state.test.ts": "tests/runtime/mcp-integrity.test.ts",
  "test/hermes-mcp-private-target-validation.test.ts": "tests/runtime/target-validation.test.ts",
  "test/hermes-mcp-probe-api-port.test.ts": "tests/runtime/probe-port.test.ts",
  "test/hermes-mcp-reload-convergence.test.ts": "tests/runtime/reload-convergence.test.ts",
  "test/hermes-mcp-rollback-pending.test.ts": "tests/runtime/rollback-pending.test.ts",
  "test/hermes-runtime-api-key.test.ts": "tests/runtime/api-key.test.ts",
  "test/hermes-runtime-config-guard.test.ts": "tests/runtime/config-guard.test.ts",
  "test/hermes-start-config-integrity.test.ts": "tests/runtime/start-integrity.test.ts",
  "test/hermes-start-path-shadow.test.ts": "tests/runtime/path-shadow.test.ts",
  "test/hermes-start.test.ts": "tests/runtime/startup.test.ts",
  "test/hermes-tirith-retry-finalization.test.ts": "tests/compat/tirith-retry.test.ts",
  "test/hermes-tool-gateway-broker.test.ts": "tests/host/tool-broker.test.ts",
  "test/hermes-tool-gateway-package-paths.test.ts": "tests/host/package-paths.test.ts",
  "test/update-hermes-agent-script.test.ts": "tests/runtime/agent-update.test.ts",
});

// Package-owned assertions split out of broader root suites.
export const hermesPackageTestSplits: readonly PackageTestMove[] = [
  {
    source: "test/package-contract/harness-packages.test.ts",
    destination: "tests/integration/archive.test.ts",
  },
  { source: "test/sandbox-provisioning.test.ts", destination: "tests/image/base-tools.test.ts" },
  {
    source: "test/inference-provider-id-rename.test.ts",
    destination: "tests/image/provider-id.test.ts",
  },
  { source: "test/runner.test.ts", destination: "tests/image/runtime-hardening.test.ts" },
  {
    source: "test/fixture-umask-normalization.test.ts",
    destination: "tests/runtime/config-permissions.test.ts",
  },
  {
    source: "test/startup-process-identity.test.ts",
    destination: "tests/runtime/process-identity.test.ts",
  },
];

export const hermesPackageSplitTests = hermesPackageTestSplits.map(
  ({ destination }) => destination,
);

// Package-owned assertions split from a root suite and requiring the exact
// NemoClaw checkout for shared policy fixtures.
export const hermesNemoclawTestSplits: readonly PackageTestMove[] = [
  {
    source: "test/effective-policy-contracts.test.ts",
    destination: "tests/host/policy-matrix.test.ts",
  },
  { source: "test/sandbox-provisioning.test.ts", destination: "tests/image/provisioning.test.ts" },
  { source: "test/sandbox-rlimit-hooks.test.ts", destination: "tests/image/rlimit-hooks.test.ts" },
  {
    source: "test/security/corporate-ca-runtime-merge.test.ts",
    destination: "tests/runtime/corporate-ca.test.ts",
  },
  {
    source: "test/networking/corporate-ca-tls-e2e.test.ts",
    destination: "tests/runtime/ca-tls.test.ts",
  },
  {
    source: "test/inference-provider-id-rename.test.ts",
    destination: "tests/runtime/provider-route.test.ts",
  },
];

export const hermesNemoclawSplitTests = hermesNemoclawTestSplits.map(
  ({ destination }) => destination,
);
