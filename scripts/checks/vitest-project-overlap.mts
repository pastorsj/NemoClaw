// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_VITEST_PROJECTS = [
  "cli",
  "integration",
  "installer-integration",
  "package-contract",
  "plugin",
  "e2e-support",
  "e2e-live",
] as const;

type ExpectedVitestProject = (typeof EXPECTED_VITEST_PROJECTS)[number];

export type ProjectListing = {
  projectsByFile: Map<string, Set<string>>;
};

export type ProjectMembershipMismatch = {
  file: string;
  expected: ReadonlySet<string>;
  actual: ReadonlySet<string>;
  reason:
    | "overlap"
    | "unsupported-candidate"
    | "unexpected-listing"
    | "wrong-project"
    | "zero-membership";
};

export type PackageVitestPlan = {
  packageRoot: string;
  configs: readonly string[];
};

export type PackageProjectMembershipMismatch = {
  file: string;
  actual: ReadonlySet<string>;
  reason: "overlap" | "unexpected-listing" | "zero-membership";
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_CANDIDATE_ROOTS = ["src", "test", "packages/nemoclaw-openclaw/plugin/src"] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

function normalizeRepoPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function discoverCandidatesUnderRoots(repoRoot: string, roots: readonly string[]): Set<string> {
  const candidates: string[] = [];

  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        candidates.push(normalizeRepoPath(path.relative(repoRoot, absolutePath)));
      }
    }
  };

  for (const root of roots) walk(path.join(repoRoot, root));
  return new Set(candidates.sort((left, right) => left.localeCompare(right)));
}

export function discoverVitestCandidates(repoRoot: string = REPO_ROOT): Set<string> {
  return discoverCandidatesUnderRoots(repoRoot, TEST_CANDIDATE_ROOTS);
}

/** Finds each harness package test lane without teaching the check any harness names. */
export function discoverPackageVitestPlans(repoRoot: string = REPO_ROOT): PackageVitestPlan[] {
  const packagesRoot = path.join(repoRoot, "packages");
  if (!existsSync(packagesRoot)) return [];

  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry): PackageVitestPlan[] => {
      const packageRoot = path.join(packagesRoot, entry.name);
      if (!entry.name.startsWith("nemoclaw-") || !existsSync(path.join(packageRoot, "tests"))) {
        return [];
      }
      const configs = ["vitest.config.ts", "vitest.nemoclaw.ts"]
        .map((name) => path.join(packageRoot, name))
        .filter(existsSync)
        .map((config) => normalizeRepoPath(path.relative(repoRoot, config)));
      return [
        {
          packageRoot: normalizeRepoPath(path.relative(repoRoot, packageRoot)),
          configs,
        },
      ];
    })
    .sort((left, right) => left.packageRoot.localeCompare(right.packageRoot));
}

export function discoverPackageVitestCandidates(
  plans: readonly PackageVitestPlan[],
  repoRoot: string = REPO_ROOT,
): Set<string> {
  return discoverCandidatesUnderRoots(
    repoRoot,
    plans.map(({ packageRoot }) => path.posix.join(packageRoot, "tests")),
  );
}

export function expectedProjectForTestPath(file: string): ExpectedVitestProject | undefined {
  const normalized = normalizeRepoPath(file);
  if (normalized.startsWith("src/")) return "cli";
  if (normalized.startsWith("packages/nemoclaw-openclaw/plugin/src/")) return "plugin";
  if (normalized.startsWith("test/installer-integration/")) return "installer-integration";
  if (normalized.startsWith("test/package-contract/")) return "package-contract";
  if (normalized.startsWith("test/e2e/support/")) return "e2e-support";
  if (normalized.startsWith("test/e2e/live/")) return "e2e-live";
  if (normalized.startsWith("test/e2e/")) return undefined;
  if (normalized.startsWith("test/")) return "integration";
  return undefined;
}

export function resolveVitestInvocation(
  args: readonly string[],
  repoRoot: string = REPO_ROOT,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), ...args],
  };
}

export function parseProjectListing(output: string): ProjectListing {
  const projectsByFile = new Map<string, Set<string>>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\[([^\]]+)\]\s+(.+)$/);
    if (!match) throw new Error(`Could not parse Vitest project listing line: ${line}`);
    const [, project, listedFile] = match;
    const file = normalizeRepoPath(listedFile);
    const memberships = projectsByFile.get(file) ?? new Set<string>();
    memberships.add(project);
    projectsByFile.set(file, memberships);
  }
  return { projectsByFile };
}

export function parseProjectRoster(output: string): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new Error("Could not parse Vitest project roster JSON", { cause });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("projects" in value) ||
    !Array.isArray(value.projects)
  ) {
    throw new Error("Vitest project roster JSON must contain a projects array");
  }

  const projects = new Set<string>();
  for (const project of value.projects) {
    if (
      typeof project !== "object" ||
      project === null ||
      !("name" in project) ||
      typeof project.name !== "string" ||
      project.name.length === 0
    ) {
      throw new Error("Every Vitest project roster entry must have a non-empty name");
    }
    projects.add(project.name);
  }
  return projects;
}

export function findProjectMembershipMismatches(
  candidateFiles: ReadonlySet<string>,
  projectsByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ProjectMembershipMismatch[] {
  const candidates = new Set([...candidateFiles].map(normalizeRepoPath));
  const actualByFile = new Map<string, Set<string>>();
  for (const [file, memberships] of projectsByFile) {
    const normalized = normalizeRepoPath(file);
    const actual = actualByFile.get(normalized) ?? new Set<string>();
    for (const project of memberships) actual.add(project);
    actualByFile.set(normalized, actual);
  }

  const files = new Set([...candidates, ...actualByFile.keys()]);
  const mismatches: ProjectMembershipMismatch[] = [];
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const actual = new Set([...(actualByFile.get(file) ?? [])].sort());
    if (!candidates.has(file)) {
      mismatches.push({
        file,
        expected: new Set(),
        actual,
        reason: "unexpected-listing",
      });
      continue;
    }

    const expectedProject = expectedProjectForTestPath(file);
    if (!expectedProject) {
      mismatches.push({
        file,
        expected: new Set(),
        actual,
        reason: "unsupported-candidate",
      });
      continue;
    }

    const expected = new Set([expectedProject]);
    if (actual.size === 0) {
      mismatches.push({ file, expected, actual, reason: "zero-membership" });
    } else if (actual.size > 1) {
      mismatches.push({ file, expected, actual, reason: "overlap" });
    } else if (!actual.has(expectedProject)) {
      mismatches.push({ file, expected, actual, reason: "wrong-project" });
    }
  }
  return mismatches;
}

/** Requires every package test to belong to one, and only one, package Vitest config. */
export function findPackageProjectMembershipMismatches(
  candidateFiles: ReadonlySet<string>,
  configsByFile: ReadonlyMap<string, ReadonlySet<string>>,
): PackageProjectMembershipMismatch[] {
  const candidates = new Set([...candidateFiles].map(normalizeRepoPath));
  const actualByFile = new Map<string, Set<string>>();
  for (const [file, configs] of configsByFile) {
    const normalized = normalizeRepoPath(file);
    const actual = actualByFile.get(normalized) ?? new Set<string>();
    for (const config of configs) actual.add(normalizeRepoPath(config));
    actualByFile.set(normalized, actual);
  }

  const mismatches: PackageProjectMembershipMismatch[] = [];
  for (const file of [...new Set([...candidates, ...actualByFile.keys()])].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const actual = new Set([...(actualByFile.get(file) ?? [])].sort());
    if (!candidates.has(file)) {
      mismatches.push({ file, actual, reason: "unexpected-listing" });
    } else if (actual.size === 0) {
      mismatches.push({ file, actual, reason: "zero-membership" });
    } else if (actual.size > 1) {
      mismatches.push({ file, actual, reason: "overlap" });
    }
  }
  return mismatches;
}

export function findProjectRosterMismatches(projects: ReadonlySet<string>): {
  missing: string[];
  unexpected: string[];
} {
  const expected = new Set<string>(EXPECTED_VITEST_PROJECTS);
  return {
    missing: [...expected].filter((project) => !projects.has(project)).sort(),
    unexpected: [...projects].filter((project) => !expected.has(project)).sort(),
  };
}

function formatProjects(projects: ReadonlySet<string>): string {
  return projects.size > 0 ? [...projects].sort().join(", ") : "<none>";
}

function runVitest(args: readonly string[]): string {
  const invocation = resolveVitestInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_RUN_LIVE_E2E: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function main(): void {
  const { projectsByFile } = parseProjectListing(runVitest(["list", "--filesOnly"]));
  const projects = parseProjectRoster(runVitest(["--list-tags=json"]));
  const candidates = discoverVitestCandidates();
  const mismatches = findProjectMembershipMismatches(candidates, projectsByFile);
  const roster = findProjectRosterMismatches(projects);
  const packagePlans = discoverPackageVitestPlans();
  const packageCandidates = discoverPackageVitestCandidates(packagePlans);
  const configsByFile = new Map<string, Set<string>>();
  for (const { configs } of packagePlans) {
    for (const config of configs) {
      const listing = parseProjectListing(runVitest(["list", "--config", config, "--filesOnly"]));
      for (const file of listing.projectsByFile.keys()) {
        const memberships = configsByFile.get(file) ?? new Set<string>();
        memberships.add(config);
        configsByFile.set(file, memberships);
      }
    }
  }
  const packageMismatches = findPackageProjectMembershipMismatches(
    packageCandidates,
    configsByFile,
  );

  if (
    roster.missing.length > 0 ||
    roster.unexpected.length > 0 ||
    mismatches.length > 0 ||
    packageMismatches.length > 0
  ) {
    console.error("Vitest project discovery does not match the repository test contract:");
    if (roster.missing.length > 0) {
      console.error(`  missing projects: ${roster.missing.join(", ")}`);
    }
    if (roster.unexpected.length > 0) {
      console.error(`  unexpected projects: ${roster.unexpected.join(", ")}`);
    }
    for (const { file, expected, actual, reason } of mismatches) {
      console.error(
        `  ${file}: ${reason}; expected ${formatProjects(expected)}; found ${formatProjects(actual)}`,
      );
    }
    for (const { file, actual, reason } of packageMismatches) {
      console.error(
        `  ${file}: package-${reason}; expected exactly one package config; found ${formatProjects(actual)}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Vitest project membership is exact (${candidates.size} core candidates across ${projects.size} projects; ${packageCandidates.size} package candidates across ${packagePlans.flatMap(({ configs }) => configs).length} configs).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
