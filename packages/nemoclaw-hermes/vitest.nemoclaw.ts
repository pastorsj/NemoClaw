// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig } from "vitest/config";

import { hermesNemoclawSplitTests, hermesNemoclawTestMoves } from "./tests/test-moves.mts";

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
const canonicalSourceAliases = [
  "banner-boundary",
  "credential-filter-boundary",
  "openshell-policy-boundary",
  "private-networks-boundary",
  "sandbox-name",
  "snapshot-sanitizer-boundary",
].map((moduleName) => ({
  find: new RegExp(`^.*${moduleName}\\.cjs$`),
  replacement: path.join(repositoryRoot, "src/lib/shared", `${moduleName}.cts`),
}));

export default defineConfig({
  ...typedSourceTransform,
  root: import.meta.dirname,
  test: {
    name: "hermes-nemoclaw",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    alias: canonicalSourceAliases,
    globalSetup: path.join(repositoryRoot, "test/helpers/vitest-temp-root.ts"),
    setupFiles: [
      "tests/helpers/test-setup.ts",
      path.join(repositoryRoot, "test/helpers/isolate-test-state.ts"),
      path.join(repositoryRoot, "test/helpers/onboard-script-mocks.cjs"),
    ],
    env: {
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
      NODE_OPTIONS: sourceNodeOptions,
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF:
        "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    include: [
      ...hermesNemoclawTestMoves.map(({ destination }) => destination),
      ...hermesNemoclawSplitTests,
      "tests/image/fabric-policy.test.ts",
      "tests/integration/skill-capability.test.ts",
      "tests/runtime/state-posture.test.ts",
    ],
  },
});
