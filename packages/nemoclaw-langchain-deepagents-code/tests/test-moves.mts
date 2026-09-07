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

export const deepAgentsPackageTestMoves = createTestMoveRecords({
  "test/cli/non-interactive-error-classification.test.ts":
    "tests/compat/error-classification.test.ts",
  "test/agents/deepagents/dcode-login-profile.test.ts": "tests/config/login-profile.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-reasoning-effort.test.ts":
    "tests/config/reasoning-effort.test.ts",
  "test/agents/deepagents/dcode-managed-exec.test.ts": "tests/runtime/managed-exec.test.ts",
  "test/agents/deepagents/dcode-non-interactive-json.test.ts": "tests/runtime/json-output.test.ts",
  "test/agents/deepagents/dcode-session-supervisor.test.ts":
    "tests/runtime/session-supervisor.test.ts",
  "test/agents/deepagents/dcode-wrapper-empty-prompt.test.ts": "tests/runtime/empty-prompt.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-retry-boundary.test.ts":
    "tests/runtime/retry-boundary.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-direct-module-patch.test.ts":
    "tests/compat/runtime-patch.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-image-credentials.test.ts":
    "tests/image/credentials.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-managed-mcp-hardening.test.ts":
    "tests/host/mcp-hardening.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-observability.test.ts":
    "tests/host/observability.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-progressive-tool-disclosure.test.ts":
    "tests/host/tool-disclosure.test.ts",
});

export const deepAgentsNemoclawTestMoves = createTestMoveRecords({
  "test/channels/channels-add-deepagents-rejection.test.ts":
    "tests/integration/channel-rejection.test.ts",
  "test/agents/deepagents/dcode-start-keepalive.test.ts": "tests/runtime/keepalive.test.ts",
  "test/agents/deepagents/dcode-wrapper-identity.test.ts": "tests/runtime/identity.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-auto-approval-image.test.ts":
    "tests/image/auto-approval.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-config.test.ts":
    "tests/config/generator.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-headless-runtime.test.ts":
    "tests/runtime/headless.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-fetch-proxy.test.ts":
    "tests/host/fetch-proxy.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-image.test.ts": "tests/image/contracts.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-managed-entrypoints.test.ts":
    "tests/runtime/entrypoints.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-managed-model-params.test.ts":
    "tests/config/model-params.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-nemotron-profile-plugin.test.ts":
    "tests/config/profile-plugin.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-profile-build-gate.test.ts":
    "tests/image/profile-gate.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-provider-label.test.ts":
    "tests/config/provider-label.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-proxy-launcher.test.ts":
    "tests/runtime/proxy-launcher.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-secret-pattern-parity.test.ts":
    "tests/host/secret-parity.test.ts",
  "test/agents/deepagents/dcode-base-image-workflow.test.ts":
    "tests/integration/base-workflow.test.ts",
  "test/agents/deepagents/dcode-sandbox-identity-integration.test.ts":
    "tests/integration/sandbox-identity.test.ts",
  "test/agents/deepagents/deepagents-code-tui-startup-check.test.ts":
    "tests/runtime/tui-startup.test.ts",
  "test/agents/deepagents/deepagents-mcp-legacy-lifecycle.test.ts":
    "tests/integration/mcp-lifecycle.test.ts",
  "test/agents/deepagents/deepagents-mcp-runtime-capability.test.ts":
    "tests/integration/mcp-capability.test.ts",
  "test/agents/deepagents/langchain-deepagents-code-proxy-runtime-contract.test.ts":
    "tests/runtime/proxy-contract.test.ts",
  "test/agents/deepagents/nemo-deepagents-alias.test.ts": "tests/integration/cli-alias.test.ts",
});

// These destinations contain package-owned assertions extracted from broader
// root suites. Their source suites remain core-owned and are not full moves.
export const deepAgentsPackageTestSplits: readonly PackageTestMove[] = [
  {
    source: "test/package-contract/harness-packages.test.ts",
    destination: "tests/integration/archive.test.ts",
  },
  {
    source: "test/sandbox/sandbox-provisioning.test.ts",
    destination: "tests/image/base-tools.test.ts",
  },
  {
    source: "test/inference/inference-provider-id-rename.test.ts",
    destination: "tests/image/provider-id.test.ts",
  },
];

export const deepAgentsPackageSplitTests = deepAgentsPackageTestSplits.map(
  ({ destination }) => destination,
);

export const deepAgentsNemoclawTestSplits: readonly PackageTestMove[] = [
  {
    source: "test/platform/images/corporate-ca-dockerfile-decode.test.ts",
    destination: "tests/image/corporate-ca.test.ts",
  },
  {
    source: "test/e2e/support/dcode-acceptance.test.ts",
    destination: "tests/image/policy-additions.test.ts",
  },
  {
    source: "test/sandbox/sandbox-rlimit-hooks.test.ts",
    destination: "tests/image/rlimit-hooks.test.ts",
  },
];

export const deepAgentsNemoclawSplitTests = deepAgentsNemoclawTestSplits.map(
  ({ destination }) => destination,
);
