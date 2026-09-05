// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig } from "vitest/config";

const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceRequireHook = path.join(repositoryRoot, "test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [
  process.env.NODE_OPTIONS,
  `--require=${JSON.stringify(sourceRequireHook)}`,
]
  .filter(Boolean)
  .join(" ");

export const deepAgentsNemoclawTestMoves = [
  {
    source: "test/agents/deepagents/dcode-start-keepalive.test.ts",
    destination: "tests/runtime/keepalive.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-wrapper-identity.test.ts",
    destination: "tests/runtime/identity.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-auto-approval-image.test.ts",
    destination: "tests/image/auto-approval.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-config.test.ts",
    destination: "tests/config/generator.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-headless-runtime.test.ts",
    destination: "tests/runtime/headless.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-fetch-proxy.test.ts",
    destination: "tests/host/fetch-proxy.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-image.test.ts",
    destination: "tests/image/contracts.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-managed-entrypoints.test.ts",
    destination: "tests/runtime/entrypoints.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-managed-model-params.test.ts",
    destination: "tests/config/model-params.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-nemotron-profile-plugin.test.ts",
    destination: "tests/config/profile-plugin.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-profile-build-gate.test.ts",
    destination: "tests/image/profile-gate.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-provider-label.test.ts",
    destination: "tests/config/provider-label.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-proxy-launcher.test.ts",
    destination: "tests/runtime/proxy-launcher.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-secret-pattern-parity.test.ts",
    destination: "tests/host/secret-parity.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    destination: "tests/integration/base-workflow.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-sandbox-identity-integration.test.ts",
    destination: "tests/integration/sandbox-identity.test.ts",
  },
  {
    source: "test/agents/deepagents/deepagents-code-tui-startup-check.test.ts",
    destination: "tests/runtime/tui-startup.test.ts",
  },
  {
    source: "test/agents/deepagents/deepagents-mcp-legacy-lifecycle.test.ts",
    destination: "tests/integration/mcp-lifecycle.test.ts",
  },
  {
    source: "test/agents/deepagents/deepagents-mcp-runtime-capability.test.ts",
    destination: "tests/integration/mcp-capability.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-proxy-runtime-contract.test.ts",
    destination: "tests/runtime/proxy-contract.test.ts",
  },
  {
    source: "test/agents/deepagents/nemo-deepagents-alias.test.ts",
    destination: "tests/integration/cli-alias.test.ts",
  },
] as const;

// Package-owned assertions split from broader root suites. These tests read
// shared NemoClaw fixtures or scripts, so the composed lane supplies the exact
// core revision explicitly.
export const deepAgentsNemoclawTestSplits = [
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
] as const;

export const deepAgentsNemoclawSplitTests = deepAgentsNemoclawTestSplits.map(
  ({ destination }) => destination,
);

// These assertions were interleaved across multiple Deep Agents suites. They
// form one composed contract here because they all inspect the core-owned live
// E2E checks that qualify this package.
export const deepAgentsNemoclawExtractedTests = [
  "tests/integration/e2e-contracts.test.ts",
] as const;

export default defineConfig({
  ...typedSourceTransform,
  root: import.meta.dirname,
  test: {
    name: "langchain-deepagents-code-nemoclaw",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Composed tests retain the same subprocess budget as the root integration
    // project while remaining explicitly owned by this package.
    testTimeout: 15_000,
    maxWorkers: 4,
    setupFiles: [
      path.join(repositoryRoot, "test/helpers/isolate-test-state.ts"),
      sourceRequireHook,
    ],
    env: {
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
      NEMOCLAW_TEST_TIMEOUT: process.env.NEMOCLAW_TEST_TIMEOUT ?? "60000",
      NODE_OPTIONS: sourceNodeOptions,
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF:
        "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    include: [
      ...deepAgentsNemoclawTestMoves.map(({ destination }) => destination),
      ...deepAgentsNemoclawSplitTests,
      ...deepAgentsNemoclawExtractedTests,
      "tests/integration/skill-capability.test.ts",
    ],
  },
});
