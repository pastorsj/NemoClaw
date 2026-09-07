// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import { deepAgentsPackageSplitTests, deepAgentsPackageTestMoves } from "./tests/test-moves.mts";

const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};

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
      "tests/host/inference-config.test.ts",
      "tests/host/config-url.test.ts",
      "tests/host/messaging-adapter.test.ts",
      "tests/host/session-adapter.test.ts",
      "tests/host/startup-adapter.test.ts",
      "tests/image/fabric-runtime.test.ts",
      "tests/integration/live-contract.test.ts",
      "tests/runtime/backup-ready.test.ts",
      "tests/runtime/selection-qualify.test.ts",
    ],
  },
});
