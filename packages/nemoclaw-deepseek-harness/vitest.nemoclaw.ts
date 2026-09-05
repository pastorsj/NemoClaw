// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { include: /\.(?:[cm]?ts|[jt]sx)$/ },
  root: import.meta.dirname,
  test: {
    name: "deepseek-harness-nemoclaw",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    include: ["tests/integration/**/*.test.ts"],
  },
});
