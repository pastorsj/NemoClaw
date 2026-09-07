// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHECKS } from "../../scripts/checks/run.mts";
import {
  findTestOwnershipIssues,
  type PackageTestMoveInventory,
} from "../../scripts/checks/test-ownership.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const packageMoves: readonly PackageTestMoveInventory[] = [
  {
    packageRoot: "packages/example",
    moves: [
      {
        source: "test/legacy.test.ts",
        destination: "tests/runtime/current.test.ts",
      },
    ],
  },
];

function withRepositoryFixture(run: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-test-ownership-"));
  try {
    run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { force: true, recursive: true });
  }
}

function writeFixture(repoRoot: string, relativePath: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "fixture\n");
}

describe("test ownership check", () => {
  it("accepts absent full-move sources with package destinations", () => {
    withRepositoryFixture((repoRoot) => {
      writeFixture(repoRoot, "packages/example/tests/runtime/current.test.ts");
      // A source represented by a split record remains core-owned. It is not
      // part of the full-move inventory and must remain allowed.
      writeFixture(repoRoot, "test/core-owned.test.ts");

      expect(findTestOwnershipIssues(repoRoot, packageMoves)).toEqual([]);
    });
  });

  it("rejects test files anywhere below the retired agent directory", () => {
    withRepositoryFixture((repoRoot) => {
      writeFixture(repoRoot, "packages/example/tests/runtime/current.test.ts");
      writeFixture(repoRoot, "test/agents/example/runtime/legacy.test.ts");
      writeFixture(repoRoot, "test/agents/example/legacy.spec.mts");
      writeFixture(repoRoot, "test/agents/example/README.md");

      expect(findTestOwnershipIssues(repoRoot, packageMoves)).toEqual([
        {
          kind: "retired-agent-test",
          path: "test/agents/example/legacy.spec.mts",
        },
        {
          kind: "retired-agent-test",
          path: "test/agents/example/runtime/legacy.test.ts",
        },
      ]);
    });
  });

  it("reports both a surviving full-move source and its missing destination", () => {
    withRepositoryFixture((repoRoot) => {
      writeFixture(repoRoot, "test/legacy.test.ts");

      expect(findTestOwnershipIssues(repoRoot, packageMoves)).toEqual([
        {
          kind: "historical-source-present",
          path: "test/legacy.test.ts",
          destination: "packages/example/tests/runtime/current.test.ts",
        },
        {
          kind: "package-destination-missing",
          path: "packages/example/tests/runtime/current.test.ts",
          source: "test/legacy.test.ts",
        },
      ]);
    });
  });

  it("accepts the repository's recorded full moves", () => {
    expect(findTestOwnershipIssues(REPO_ROOT)).toEqual([]);
  });

  it("runs from the shared repository check entrypoint", () => {
    expect(CHECKS).toContainEqual({
      name: "test-ownership",
      command: process.platform === "win32" ? "tsx.cmd" : "tsx",
      args: ["scripts/checks/test-ownership.mts"],
    });
  });
});
