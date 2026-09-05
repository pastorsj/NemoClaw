// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { include: /\.(?:[cm]?ts|[jt]sx)$/ },
  root: import.meta.dirname,
  test: {
    name: "deepseek-harness-package",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    include: [
      "tests/config/**/*.test.ts",
      "tests/host/**/*.test.ts",
      "tests/image/**/*.test.ts",
      "tests/runtime/**/*.test.ts",
    ],
  },
});
