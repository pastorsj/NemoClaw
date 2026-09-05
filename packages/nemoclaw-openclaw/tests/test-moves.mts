// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PackageTestMove = {
  source: string;
  destination: string;
};

function createTestMoveRecords(
  testMoves: Readonly<Record<string, string>>,
): readonly PackageTestMove[] {
  return Object.entries(testMoves).map(([source, destination]) => ({
    source,
    destination,
  }));
}

export const openclawPackageTestMoves = createTestMoveRecords({
  "test/runtime/sandbox/clean-runtime-shell-env-shim.test.ts":
    "tests/runtime/shell-cleanup.test.ts",
  "test/runtime/gateway/gateway-watchdog-kill-marker.test.ts": "tests/runtime/kill-marker.test.ts",
  "test/helpers/openclaw-env-fixture.test.ts": "tests/runtime/env-fixture.test.ts",
  "test/agents/openclaw/kimi-inference-compat-plugin.test.ts":
    "tests/compat/kimi-inference.test.ts",
  "test/agents/openclaw/openclaw-2026-7-startup-compat.test.ts":
    "tests/compat/startup-2026-7.test.ts",
  "test/agents/openclaw/openclaw-chat-send-patch.test.ts": "tests/compat/chat-send.test.ts",
  "test/agents/openclaw/openclaw-config-guard.test.ts": "tests/runtime/config-guard.test.ts",
  "test/agents/openclaw/openclaw-device-approval-policy.test.ts":
    "tests/compat/device-policy.test.ts",
  "test/agents/openclaw/openclaw-device-self-approval-auth-scopes.test.ts":
    "tests/compat/device-scopes.test.ts",
  "test/agents/openclaw/openclaw-device-self-approval-patch-upgrade.test.ts":
    "tests/compat/device-upgrade.test.ts",
  "test/agents/openclaw/openclaw-device-self-approval-patch.test.ts":
    "tests/compat/self-approval.test.ts",
  "test/agents/openclaw/openclaw-device-stored-auth-patch.test.ts":
    "tests/compat/stored-auth.test.ts",
  "test/agents/openclaw/openclaw-gateway-daemon-dialback-patch.test.ts":
    "tests/compat/daemon-dialback.test.ts",
  "test/agents/openclaw/openclaw-issue-4434-diagnostics-patch.test.ts":
    "tests/compat/diagnostics-4434.test.ts",
  "test/openclaw-loader.test.ts": "tests/runtime/loader.test.ts",
  "test/agents/openclaw/openclaw-managed-transport-diagnostics-patch.test.ts":
    "tests/compat/transport-diagnostics.test.ts",
  "test/agents/openclaw/openclaw-mcp-npx-patch.test.ts": "tests/compat/mcp-npx.test.ts",
  "test/agents/openclaw/openclaw-mcp-reliability-patch.test.ts":
    "tests/compat/mcp-reliability.test.ts",
  "test/agents/openclaw/openclaw-mcp-tools-list-timeout-patch.test.ts":
    "tests/compat/mcp-timeout.test.ts",
  "test/agents/openclaw/openclaw-shared-state-permissions-patch.test.ts":
    "tests/compat/state-permissions.test.ts",
  "test/agents/openclaw/openclaw-state-file-repair.test.ts": "tests/runtime/state-repair.test.ts",
  "test/agents/openclaw/openclaw-tool-catalog-patch.test.ts": "tests/compat/tool-catalog.test.ts",
  "test/agents/openclaw/openclaw-tool-search-runtime-validator.test.ts":
    "tests/runtime/tool-validator.test.ts",
  "test/agents/openclaw/openclaw-version-parser.test.ts": "tests/runtime/version-parser.test.ts",
  "test/runtime/sandbox/sandbox-provisioning-tavily.test.ts": "tests/image/tavily-plugin.test.ts",
});

export const openclawNemoclawTestMoves = createTestMoveRecords({
  "src/lib/state/sandbox-recreated-openclaw-restore.test.ts":
    "tests/integration/recreated-state.test.ts",
  "test/agents/agents-manifest-policy-conformance.test.ts": "tests/config/agent-policy.test.ts",
  "test/onboarding/blueprint-runtime-identity-lifecycle.test.ts":
    "tests/integration/runtime-identity.test.ts",
  "test/credentials/credential-exposure.test.ts": "tests/integration/credential-exposure.test.ts",
  "test/security/fetch-guard-patch-regression.test.ts": "tests/image/fetch-install.test.ts",
  "test/generation/generate-openclaw-config-agents-manifest.test.ts":
    "tests/config/agents-manifest.test.ts",
  "test/generation/generate-openclaw-config-gemini-compat.test.ts":
    "tests/config/gemini-compat.test.ts",
  "test/generation/generate-openclaw-config-gpt5-compat.test.ts":
    "tests/config/gpt5-compat.test.ts",
  "test/generation/generate-openclaw-config-path-defaults.test.ts":
    "tests/config/path-defaults.test.ts",
  "test/generation/generate-openclaw-config-plugin-entries.test.ts":
    "tests/config/plugin-entries.test.ts",
  "test/generation/generate-openclaw-config-reasoning-effort.test.ts":
    "tests/config/reasoning-effort.test.ts",
  "test/generation/generate-openclaw-config-reload.test.ts": "tests/config/reload.test.ts",
  "test/generation/generate-openclaw-config-security-audit.test.ts":
    "tests/config/security-audit.test.ts",
  "test/generation/generate-openclaw-config-slack-allowlist.test.ts":
    "tests/config/slack-allowlist.test.ts",
  "test/generation/generate-openclaw-config-web-search.test.ts": "tests/config/web-search.test.ts",
  "test/generation/generate-openclaw-config.test.ts": "tests/config/generator.test.ts",
  "test/generation/generate-openclaw-tool-disclosure-config.test.ts":
    "tests/config/tool-disclosure.test.ts",
  "test/runtime/gateway/gateway-pid-recording.test.ts": "tests/runtime/gateway-pid.test.ts",
  "test/runtime/gateway/gateway-serving-watchdog.test.ts": "tests/runtime/gateway-watchdog.test.ts",
  "test/runtime/gateway/gateway-watchdog-validation.test.ts":
    "tests/runtime/watchdog-config.test.ts",
  "test/networking/http-proxy-fix-e2e.test.ts": "tests/runtime/proxy-e2e.test.ts",
  "test/networking/http-proxy-fix-rewrite.test.ts": "tests/runtime/proxy-rewrite.test.ts",
  "test/networking/http-proxy-fix-sync.test.ts": "tests/runtime/proxy-preload.test.ts",
  "test/security/mcporter-supply-chain.test.ts": "tests/image/mcporter.test.ts",
  "test/runtime/messaging/messaging-runtime-preload-packaging.test.ts":
    "tests/image/messaging-preloads.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-auto-pair-bootstrap.test.ts":
    "tests/runtime/pair-bootstrap.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-early-output.test.ts":
    "tests/runtime/early-output.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-gateway-health.test.ts":
    "tests/runtime/gateway-health.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-gateway-marker.test.ts":
    "tests/runtime/gateway-marker.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-gateway-recovery-race.test.ts":
    "tests/runtime/gateway-recovery.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-gateway-token-env.test.ts":
    "tests/runtime/gateway-token.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-gateway-ws-host.test.ts":
    "tests/runtime/gateway-route.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-guard-recovery.test.ts":
    "tests/runtime/guard-recovery.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-config-io.test.ts":
    "tests/runtime/config-io.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-perms.test.ts":
    "tests/runtime/config-permissions.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-plugin-refresh.test.ts":
    "tests/runtime/plugin-refresh.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-preload-gateway.test.ts":
    "tests/runtime/preload-gateway.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-reasoning-effort.test.ts":
    "tests/runtime/reasoning-effort.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-reconcile.test.ts":
    "tests/runtime/model-reconcile.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-runtime-env-alias.test.ts":
    "tests/runtime/env-alias.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-wechat-placeholder.test.ts":
    "tests/runtime/wechat-placeholder.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-safe-tmp.test.ts": "tests/runtime/safe-temp.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-scope-replacement.test.ts":
    "tests/runtime/device-scope.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-shared-state-topology.test.ts":
    "tests/runtime/shared-state.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-slack-runtime.test.ts":
    "tests/runtime/slack-env.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start-telegram-runtime.test.ts":
    "tests/runtime/telegram-preload.test.ts",
  "test/agents/openclaw/runtime/nemoclaw-start.test.ts": "tests/runtime/startup.test.ts",
  "test/inference/managed/nemotron-inference-fix.test.ts": "tests/runtime/nemotron-preload.test.ts",
  "test/inference/ollama/ollama-local-openclaw-config-propagation.test.ts":
    "tests/config/ollama-route.test.ts",
  "test/inference/llama/llama-cpp-openclaw-agent-qualification.test.ts":
    "tests/integration/llama-cpp.test.ts",
  "test/agents/openclaw/openclaw-2026-6-npm-remediation.test.ts": "tests/compat/npm-2026-6.test.ts",
  "test/agents/openclaw/openclaw-dependency-review.test.ts":
    "tests/image/dependency-review.test.ts",
  "test/agents/openclaw/openclaw-diagnostics-jaeger-runtime.test.ts":
    "tests/compat/jaeger-runtime.test.ts",
  "test/agents/openclaw/openclaw-diagnostics-npm-remediation.test.ts":
    "tests/compat/diagnostics-remediation.test.ts",
  "test/agents/openclaw/openclaw-integrity-pin-base.test.ts": "tests/image/integrity-base.test.ts",
  "test/agents/openclaw/openclaw-integrity-pin-contract.test.ts":
    "tests/image/integrity-contract.test.ts",
  "test/agents/openclaw/openclaw-integrity-pin-plugin-install.test.ts":
    "tests/image/integrity-plugin.test.ts",
  "test/agents/openclaw/openclaw-gemini-inference-compat-runtime.test.ts":
    "tests/integration/gemini-runtime.test.ts",
  "test/agents/openclaw/openclaw-gemini-runtime-image.test.ts":
    "tests/integration/runtime-image.test.ts",
  "test/agents/openclaw/openclaw-locked-install.test.ts": "tests/image/locked-install.test.ts",
  "test/agents/openclaw/openclaw-managed-messaging-offline-build.test.ts":
    "tests/image/offline-messaging.test.ts",
  "test/agents/openclaw/openclaw-managed-restart-respawn.test.ts":
    "tests/runtime/restart-respawn.test.ts",
  "test/agents/openclaw/openclaw-msteams-message-hints-patch.test.ts":
    "tests/compat/msteams-hints.test.ts",
  "test/agents/openclaw/openclaw-npm-remediation.test.ts": "tests/compat/npm-remediation.test.ts",
  "test/agents/openclaw/openclaw-optional-plugin-build.test.ts": "tests/image/plugin-build.test.ts",
  "test/agents/openclaw/openclaw-real-patched-dist-harness.test.ts":
    "tests/compat/dist-harness.test.ts",
  "test/agents/openclaw/openclaw-security-audit-suppressions-real.test.ts":
    "tests/runtime/audit-suppressions.test.ts",
  "test/agents/openclaw/openclaw-slack-deny-feedback-patch.test.ts":
    "tests/compat/slack-feedback.test.ts",
  "test/e2e-runtime/proxy-env-gateway-token-conflict.test.ts": "tests/runtime/proxy-token.test.ts",
  "test/e2e-runtime/repro-4538-raw-doctor-perms.test.ts":
    "tests/runtime/doctor-permissions.test.ts",
  "test/runtime/policy/repro-5978-policy-denial-hint.test.ts": "tests/runtime/policy-hint.test.ts",
  "test/e2e-runtime/repro-7795-connect-shell-sandbox-label.test.ts":
    "tests/runtime/sandbox-label.test.ts",
  "test/runtime/sandbox/sandbox-provisioning-helper-permissions.test.ts":
    "tests/image/helper-permissions.test.ts",
  "test/security/security-c2-dockerfile-injection.test.ts": "tests/image/config-safety.test.ts",
  "test/install/verify-wechat-runtime-lock.test.ts": "tests/image/wechat-lock.test.ts",
  "test/package-contract/openclaw-plugin-clean-build.test.ts":
    "tests/integration/clean-build.test.ts",
});

// Package-only assertions split out of broader source suites.
export const openclawPackageTestSplits: readonly PackageTestMove[] = [
  {
    source: "src/lib/state/openclaw-config-merge.test.ts",
    destination: "tests/host/config-merge.test.ts",
  },
  {
    source: "src/lib/state/openclaw-config-merge-tool-search.test.ts",
    destination: "tests/host/tool-merge.test.ts",
  },
  {
    source: "test/package-contract/harness-packages.test.ts",
    destination: "tests/integration/archive.test.ts",
  },
  {
    source: "test/inference/inference-provider-id-rename.test.ts",
    destination: "tests/image/provider-id.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start-auto-pair-bootstrap.test.ts",
    destination: "tests/runtime/pair-diagnostics.test.ts",
  },
  {
    source: "test/e2e-runtime/runner.test.ts",
    destination: "tests/image/runtime-hardening.test.ts",
  },
  {
    source: "test/e2e-runtime/runner.test.ts",
    destination: "tests/image/tmux.test.ts",
  },
  {
    source: "test/runtime/sandbox/sandbox-provisioning.test.ts",
    destination: "tests/image/base-tools.test.ts",
  },
  {
    source: "test/runtime/sandbox/sandbox-provisioning.test.ts",
    destination: "tests/image/health-check.test.ts",
  },
  {
    source: "test/runtime/sandbox/sandbox-provisioning.test.ts",
    destination: "tests/image/provisioning.test.ts",
  },
  {
    source: "test/runtime/gateway/startup-process-identity.test.ts",
    destination: "tests/runtime/process-identity.test.ts",
  },
  {
    source: "test/runtime/messaging/whatsapp-qr-compact.test.ts",
    destination: "tests/runtime/whatsapp-pairing.test.ts",
  },
];

export const openclawPackageSplitTests = openclawPackageTestSplits.map(
  ({ destination }) => destination,
);

// Package-owned assertions split from larger root suites. This lane supplies
// the exact NemoClaw checkout that their fixtures and production paths read.
export const openclawNemoclawTestSplits: readonly PackageTestMove[] = [
  {
    source: "src/lib/state/openclaw-config-restore-input.test.ts",
    destination: "tests/integration/config-restore.test.ts",
  },
  {
    source: "test/generation/generate-openclaw-config.test.ts",
    destination: "tests/config/generator-validation.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-tui-chat-correlation.test.ts",
    destination: "tests/e2e/chat-correlation.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-gateway-log-redaction.test.ts",
    destination: "tests/e2e/gateway-redaction.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-security-revision-container-e2e.test.ts",
    destination: "tests/e2e/security-revision.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-config-restore.test.ts",
    destination: "tests/integration/config-restore.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-config-snapshot.test.ts",
    destination: "tests/integration/config-snapshot.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-config-transaction-wiring.test.ts",
    destination: "tests/integration/config-transaction.test.ts",
  },
  {
    source: "test/security/corporate-ca-runtime-merge.test.ts",
    destination: "tests/runtime/corporate-ca.test.ts",
  },
  {
    source: "test/networking/corporate-ca-tls-e2e.test.ts",
    destination: "tests/runtime/ca-tls.test.ts",
  },
  {
    source: "test/e2e-runtime/entrypoint-env-wrapper.test.ts",
    destination: "tests/runtime/entrypoint-env.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start-auto-pair-bootstrap.test.ts",
    destination: "tests/integration/pair-settlement.test.ts",
  },
  {
    source: "test/security/fetch-guard-patch-regression.test.ts",
    destination: "tests/image/fetch-policy.test.ts",
  },
  {
    source: "test/security/fetch-guard-patch-regression.test.ts",
    destination: "tests/image/fetch-preflight.test.ts",
  },
  {
    source: "test/inference/inference-provider-id-rename.test.ts",
    destination: "tests/config/provider-route.test.ts",
  },
  {
    source: "test/agents/openclaw/openclaw-lifecycle-policy.test.ts",
    destination: "tests/image/lifecycle-policy.test.ts",
  },
  {
    source: "test/runtime/messaging/messaging-runtime-preload-packaging.test.ts",
    destination: "tests/runtime/messaging-preloads.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start-auto-pair-bootstrap.test.ts",
    destination: "tests/runtime/auto-pair.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/config-recovery.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/gateway-config.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/model-config.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/privilege-drop.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/telegram-diagnostics.test.ts",
  },
  {
    source: "test/agents/openclaw/runtime/nemoclaw-start.test.ts",
    destination: "tests/runtime/workspace-migration.test.ts",
  },
  {
    source: "test/runtime/sandbox/repro-2681-group-writable.test.ts",
    destination: "tests/runtime/normalizer.test.ts",
  },
  {
    source: "test/runtime/sandbox/sandbox-rlimit-hooks.test.ts",
    destination: "tests/image/rlimit-hooks.test.ts",
  },
  {
    source: "test/runtime/gateway/service-env.test.ts",
    destination: "tests/runtime/service-env.test.ts",
  },
  {
    source: "test/runtime/gateway/service-env.test.ts",
    destination: "tests/runtime/shell-env.test.ts",
  },
  {
    source: "test/runtime/messaging/whatsapp-qr-compact.test.ts",
    destination: "tests/runtime/whatsapp-qr.test.ts",
  },
];

export const openclawNemoclawSplitTests = openclawNemoclawTestSplits.map(
  ({ destination }) => destination,
);
