// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deepAgentsNemoclawTestMoves,
  deepAgentsPackageTestMoves,
} from "../../packages/nemoclaw-langchain-deepagents-code/tests/test-moves.mts";
import {
  hermesNemoclawTestMoves,
  hermesPackageTestMoves,
} from "../../packages/nemoclaw-hermes/tests/test-moves.mts";
import {
  openclawNemoclawTestMoves,
  openclawPackageTestMoves,
} from "../../packages/nemoclaw-openclaw/tests/test-moves.mts";

export type PackageTestMove = {
  readonly source: string;
  readonly destination: string;
};

export type PackageTestMoveInventory = {
  readonly packageRoot: string;
  readonly moves: readonly PackageTestMove[];
};

export type TestOwnershipIssue =
  | {
      readonly kind: "historical-source-present";
      readonly path: string;
      readonly destination: string;
    }
  | {
      readonly kind: "package-destination-missing";
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly kind: "retired-agent-test";
      readonly path: string;
    };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export const PACKAGE_TEST_MOVE_INVENTORIES = [
  {
    packageRoot: "packages/nemoclaw-hermes",
    moves: [...hermesPackageTestMoves, ...hermesNemoclawTestMoves],
  },
  {
    packageRoot: "packages/nemoclaw-openclaw",
    moves: [...openclawPackageTestMoves, ...openclawNemoclawTestMoves],
  },
  {
    packageRoot: "packages/nemoclaw-langchain-deepagents-code",
    moves: [...deepAgentsPackageTestMoves, ...deepAgentsNemoclawTestMoves],
  },
] as const satisfies readonly PackageTestMoveInventory[];

function normalizePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function findRetiredAgentTests(repoRoot: string): string[] {
  const retiredRoot = path.join(repoRoot, "test", "agents");
  if (!fs.existsSync(retiredRoot)) return [];

  const tests: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && TEST_FILE_PATTERN.test(entry.name)) {
        tests.push(normalizePath(repoRoot, absolutePath));
      }
    }
  };
  walk(retiredRoot);
  return tests.sort((left, right) => left.localeCompare(right));
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findTestOwnershipIssues(
  repoRoot: string = REPO_ROOT,
  inventories: readonly PackageTestMoveInventory[] = PACKAGE_TEST_MOVE_INVENTORIES,
): TestOwnershipIssue[] {
  const issues: TestOwnershipIssue[] = findRetiredAgentTests(repoRoot).map((testPath) => ({
    kind: "retired-agent-test",
    path: testPath,
  }));

  for (const inventory of inventories) {
    for (const move of inventory.moves) {
      if (fs.existsSync(path.join(repoRoot, move.source))) {
        issues.push({
          kind: "historical-source-present",
          path: move.source,
          destination: path.posix.join(inventory.packageRoot, move.destination),
        });
      }

      const destination = path.join(repoRoot, inventory.packageRoot, move.destination);
      if (!isFile(destination)) {
        issues.push({
          kind: "package-destination-missing",
          path: path.posix.join(inventory.packageRoot, move.destination),
          source: move.source,
        });
      }
    }
  }

  return issues.sort((left, right) =>
    `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`),
  );
}

export function formatTestOwnershipIssue(issue: TestOwnershipIssue): string {
  switch (issue.kind) {
    case "historical-source-present":
      return `${issue.path}: historical full-move source still exists; package owner is ${issue.destination}`;
    case "package-destination-missing":
      return `${issue.path}: package test destination is missing for historical source ${issue.source}`;
    case "retired-agent-test":
      return `${issue.path}: test/agents is retired; move this harness-native test into its package`;
  }
}

export function runTestOwnershipCheck(repoRoot: string = REPO_ROOT): void {
  const issues = findTestOwnershipIssues(repoRoot);
  if (issues.length === 0) return;
  for (const issue of issues) console.error(formatTestOwnershipIssue(issue));
  process.exitCode = 1;
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  runTestOwnershipCheck();
}
