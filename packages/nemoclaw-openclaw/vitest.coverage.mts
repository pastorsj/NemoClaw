// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig, defineProject } from "vitest/config";

import pluginVitestProjectOptions from "./plugin/vitest.project.ts";

const pluginVitestProject = defineProject(pluginVitestProjectOptions);

export default defineConfig({
  ...pluginVitestProject,
  test: {
    ...pluginVitestProject.test,
    globalSetup: path.resolve(import.meta.dirname, "tests/helpers/temp-root.ts"),
    coverage: {
      provider: "v8",
      include: ["plugin/src/**/*.ts", "plugin/src/**/*.cts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "json-summary", "cobertura"],
      reportsDirectory: "coverage",
      thresholds: {
        perFile: true,
        "plugin/src/blueprint/ssrf.ts": {
          lines: 95,
          functions: 100,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
