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
      "tests/host/agent-roster.test.ts",
      "tests/host/agent-command.test.ts",
      "tests/host/inference-config.test.ts",
      "tests/host/config-url.test.ts",
      "tests/host/mcp-adapter.test.ts",
      "tests/host/messaging-adapter.test.ts",
      "tests/host/session-adapter.test.ts",
      "tests/host/startup-adapter.test.ts",
      "tests/image/fabric-runtime.test.ts",
      "tests/integration/live-contract.test.ts",
      "tests/messaging/probe.test.ts",
      "tests/runtime/inference-reconcile.test.ts",
      "tests/runtime/process-lifecycle.test.ts",
      "tests/runtime/managed-gateway-profile.test.ts",
      "tests/runtime/session-admin.test.ts",
      "tests/runtime/session-qualify.test.ts",
      "tests/runtime/seal-config.test.ts",
      "tests/runtime/state-extensions.test.ts",
      "tests/runtime/state-restore.test.ts",
    ],
  },
});
