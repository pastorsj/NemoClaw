// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import { hermesPackageSplitTests, hermesPackageTestMoves } from "./tests/test-moves.mts";

const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};

export default defineConfig({
  ...typedSourceTransform,
  root: import.meta.dirname,
  test: {
    name: "hermes-package",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    setupFiles: ["tests/helpers/test-setup.ts"],
    include: [
      ...hermesPackageTestMoves.map(({ destination }) => destination),
      ...hermesPackageSplitTests,
      "tests/host/adapter-build.test.ts",
      "tests/host/inference-config.test.ts",
      "tests/host/config-url.test.ts",
      "tests/host/messaging-adapter.test.ts",
      "tests/host/provider-broker.test.ts",
      "tests/host/provider-auth.test.ts",
      "tests/host/tool-gateway.test.ts",
      "tests/host/session-adapter.test.ts",
      "tests/host/startup-adapter.test.ts",
      "tests/image/fabric-lifecycle.test.ts",
      "tests/image/fabric-runtime.test.ts",
      "tests/integration/live-contract.test.ts",
      "tests/runtime/inference-reconcile.test.ts",
      "tests/runtime/process-lifecycle.test.ts",
      "tests/runtime/managed-gateway-profile.test.ts",
      "tests/runtime/state-restore.test.ts",
      "tests/runtime/startup-seal.test.ts",
    ],
  },
});
