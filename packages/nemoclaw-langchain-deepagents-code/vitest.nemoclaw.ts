// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig } from "vitest/config";

import { deepAgentsNemoclawSplitTests, deepAgentsNemoclawTestMoves } from "./tests/test-moves.mts";

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
