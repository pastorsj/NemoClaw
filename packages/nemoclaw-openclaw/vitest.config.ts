// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import { openclawPackageSplitTests, openclawPackageTestMoves } from "./tests/test-moves.mts";

const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};

export default defineConfig({
  ...typedSourceTransform,
  root: import.meta.dirname,
  test: {
    name: "openclaw-package",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    globalSetup: "tests/helpers/temp-root.ts",
    setupFiles: ["tests/helpers/fixture-umask.ts"],
    include: [
      ...openclawPackageTestMoves.map(({ destination }) => destination),
      ...openclawPackageSplitTests,
      "tests/host/adapter-build.test.ts",
      "tests/host/config-url.test.ts",
      "tests/host/mcp-adapter.test.ts",
      "tests/host/startup-adapter.test.ts",
      "tests/image/fabric-runtime.test.ts",
      "tests/runtime/seal-config.test.ts",
    ],
  },
});
