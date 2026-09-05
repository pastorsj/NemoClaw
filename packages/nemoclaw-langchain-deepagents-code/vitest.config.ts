// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};

export const deepAgentsPackageTestMoves = [
  {
    source: "test/cli/non-interactive-error-classification.test.ts",
    destination: "tests/compat/error-classification.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-login-profile.test.ts",
    destination: "tests/config/login-profile.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-reasoning-effort.test.ts",
    destination: "tests/config/reasoning-effort.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-managed-exec.test.ts",
    destination: "tests/runtime/managed-exec.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-non-interactive-json.test.ts",
    destination: "tests/runtime/json-output.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-session-supervisor.test.ts",
    destination: "tests/runtime/session-supervisor.test.ts",
  },
  {
    source: "test/agents/deepagents/dcode-wrapper-empty-prompt.test.ts",
    destination: "tests/runtime/empty-prompt.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-retry-boundary.test.ts",
    destination: "tests/runtime/retry-boundary.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-direct-module-patch.test.ts",
    destination: "tests/compat/runtime-patch.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-image-credentials.test.ts",
    destination: "tests/image/credentials.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-managed-mcp-hardening.test.ts",
    destination: "tests/host/mcp-hardening.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-observability.test.ts",
    destination: "tests/host/observability.test.ts",
  },
  {
    source: "test/agents/deepagents/langchain-deepagents-code-progressive-tool-disclosure.test.ts",
    destination: "tests/host/tool-disclosure.test.ts",
  },
] as const;

export const deepAgentsPackageTestSplits = [
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
] as const;

export const deepAgentsPackageSplitTests = deepAgentsPackageTestSplits.map(
  ({ destination }) => destination,
);

export default defineConfig({
  ...typedSourceTransform,
  root: import.meta.dirname,
  test: {
    name: "langchain-deepagents-code-package",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    env: {
      NEMOCLAW_TEST_TIMEOUT: process.env.NEMOCLAW_TEST_TIMEOUT ?? "60000",
    },
    // These tests spawn Python and shell fixtures. Match the previous root
    // integration lane's timeout and bound concurrent subprocesses locally.
    testTimeout: 15_000,
    maxWorkers: 4,
    include: [
      ...deepAgentsPackageTestMoves.map(({ destination }) => destination),
      ...deepAgentsPackageSplitTests,
      "tests/host/adapter-build.test.ts",
      "tests/host/config-url.test.ts",
      "tests/image/fabric-runtime.test.ts",
    ],
  },
});
