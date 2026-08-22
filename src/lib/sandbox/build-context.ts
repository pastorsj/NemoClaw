// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { harnessPackageContentDigest } from "../harness/package-registry";
import { createCustomBuildContextFilter } from "../onboard/custom-build-context";

export const SANDBOX_BUILD_CONTEXT_PREFIX = "nemoclaw-build-";
export type SandboxBuildContextOrigin = "custom" | "generated";

export interface StagedBuildContext {
  buildCtx: string;
  stagedDockerfile: string;
}

export interface BuildContextStats {
  fileCount: number;
  totalBytes: number;
}

type BuildContextStatsFilter = (entryPath: string) => boolean;

const MAX_REVIEWED_RUNTIME_ARTIFACT_BYTES = 8 * 1024 * 1024;
const AGENT_RUNTIME_PACKAGE_IGNORES = new Set([".nemoclaw-install.json", ".DS_Store"]);

function createBuildContextDir(tmpDir: string = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(tmpDir, SANDBOX_BUILD_CONTEXT_PREFIX));
}

function normalizeReadModesForDockerCopy(rootDir: string): void {
  const stat = fs.lstatSync(rootDir);
  if (stat.isDirectory()) {
    fs.chmodSync(rootDir, (stat.mode & 0o777 & ~0o022) | 0o555);
    for (const entry of fs.readdirSync(rootDir)) {
      normalizeReadModesForDockerCopy(path.join(rootDir, entry));
    }
    return;
  }

  if (stat.isFile()) {
    const mode = stat.mode & 0o777;
    fs.chmodSync(rootDir, (mode & ~0o022) | 0o444 | (mode & 0o111 ? 0o111 : 0));
  }
}

function copyReviewedRegularFileSync(
  sourceRoot: string,
  relativePath: string,
  target: string,
): void {
  const source = path.join(sourceRoot, relativePath);
  const opened = openRegularFileNoFollow(source);
  try {
    const bytes = opened.readBytes(MAX_REVIEWED_RUNTIME_ARTIFACT_BYTES);
    const resolvedRoot = fs.realpathSync(sourceRoot);
    const resolvedSource = fs.realpathSync(source);
    if (path.relative(resolvedRoot, resolvedSource) !== path.normalize(relativePath)) {
      throw new Error(`reviewed runtime artifact escapes its source directory: ${source}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  } finally {
    opened.close();
  }
}

export function stageAgentRuntimePackage(
  sourcePackageDir: string,
  buildCtx: string,
  expectedDigest?: string,
): string {
  const sourceDigest = harnessPackageContentDigest(sourcePackageDir);
  if (expectedDigest && sourceDigest !== expectedDigest) {
    throw new Error("Selected harness package no longer matches its loaded manifest");
  }
  const stagedPackageDir = path.join(buildCtx, "packages", path.basename(sourcePackageDir));
  const includePackagePath = createCustomBuildContextFilter(sourcePackageDir);
  fs.rmSync(stagedPackageDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagedPackageDir), { recursive: true });
  fs.cpSync(sourcePackageDir, stagedPackageDir, {
    mode: fs.constants.COPYFILE_FICLONE,
    recursive: true,
    filter: (sourcePath) => {
      const metadata = fs.lstatSync(sourcePath);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(
          `Agent runtime packages may contain only directories and regular files: ${sourcePath}`,
        );
      }
      return (
        !AGENT_RUNTIME_PACKAGE_IGNORES.has(path.basename(sourcePath)) &&
        includePackagePath(sourcePath)
      );
    },
  });
  normalizeReadModesForDockerCopy(stagedPackageDir);
  if (
    harnessPackageContentDigest(sourcePackageDir) !== sourceDigest ||
    harnessPackageContentDigest(stagedPackageDir) !== sourceDigest
  ) {
    throw new Error("Selected harness package changed while it was being staged");
  }
  return stagedPackageDir;
}

function stageMcpToolDiscoveryRuntime(rootDir: string, buildCtx: string): void {
  const sourceDir = path.join(rootDir, "tools", "mcp-tool-discovery-runtime");
  const stagedDir = path.join(buildCtx, "tools", "mcp-tool-discovery-runtime");
  fs.mkdirSync(stagedDir, { recursive: true });
  for (const fileName of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "install-reviewed-runtime.sh",
    "npm-ci-locked.sh",
    "build-runtime.ts",
    "mcp-tool-discovery.ts",
    "streamable-http-client.test.ts",
    "tool-discovery-core.ts",
  ]) {
    fs.copyFileSync(path.join(sourceDir, fileName), path.join(stagedDir, fileName));
  }
  for (const seedDirectory of ["mcp-runtime-npm-cache-seed", "npm-cache-seed"]) {
    fs.cpSync(path.join(sourceDir, seedDirectory), path.join(stagedDir, seedDirectory), {
      mode: fs.constants.COPYFILE_FICLONE,
      recursive: true,
    });
  }
  for (const relativePath of [
    "managed-startup-image-runtime.bundle",
    path.join("mcp-tool-discovery", "BUNDLED_PACKAGES.json"),
    path.join("mcp-tool-discovery", "THIRD_PARTY_LICENSES.txt"),
    path.join("mcp-tool-discovery", "mcp-tool-discovery.bundle"),
  ]) {
    const reviewedRuntimeDir = path.join(sourceDir, "reviewed-runtime-bundle");
    const target = path.join(stagedDir, "reviewed-runtime-bundle", relativePath);
    copyReviewedRegularFileSync(reviewedRuntimeDir, relativePath, target);
  }
  normalizeReadModesForDockerCopy(path.join(buildCtx, "tools"));
}

function stageManagedStartupRuntimeSources(rootDir: string, buildCtx: string): void {
  for (const relativePath of [
    path.join("core", "json-types.ts"),
    path.join("core", "ports.ts"),
    path.join("security", "credential-hash.ts"),
    path.join("state", "paths.ts"),
    path.join("state", "state-root.ts"),
  ]) {
    const source = path.join(rootDir, "src", "lib", relativePath);
    const target = path.join(buildCtx, "src", "lib", relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.cpSync(
    path.join(rootDir, "src", "lib", "onboard", "managed-bootstrap"),
    path.join(buildCtx, "src", "lib", "onboard", "managed-bootstrap"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(rootDir, "src", "lib", "onboard", "managed-startup"),
    path.join(buildCtx, "src", "lib", "onboard", "managed-startup"),
    { recursive: true },
  );
}

function stageLegacySandboxBuildContext(
  rootDir: string,
  tmpDir: string = os.tmpdir(),
): StagedBuildContext {
  const buildCtx = createBuildContextDir(tmpDir);
  try {
    const sourceAgentDir = path.join(rootDir, "packages", "nemoclaw-openclaw");
    const stagedAgentDir = stageAgentRuntimePackage(sourceAgentDir, buildCtx);
    fs.copyFileSync(path.join(stagedAgentDir, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
    fs.copyFileSync(
      path.join(rootDir, "tsconfig.runtime-preloads.json"),
      path.join(buildCtx, "tsconfig.runtime-preloads.json"),
    );
    stageMcpToolDiscoveryRuntime(rootDir, buildCtx);
    fs.cpSync(path.join(rootDir, "nemoclaw-blueprint"), path.join(buildCtx, "nemoclaw-blueprint"), {
      recursive: true,
    });
    normalizeReadModesForDockerCopy(path.join(buildCtx, "nemoclaw-blueprint"));
    fs.cpSync(path.join(rootDir, "scripts"), path.join(buildCtx, "scripts"), {
      recursive: true,
    });
    normalizeReadModesForDockerCopy(path.join(buildCtx, "scripts"));
    fs.cpSync(
      path.join(rootDir, "src", "lib", "messaging"),
      path.join(buildCtx, "src", "lib", "messaging"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(rootDir, "src", "lib", "tool-disclosure.ts"),
      path.join(buildCtx, "src", "lib", "tool-disclosure.ts"),
    );
    stageManagedStartupRuntimeSources(rootDir, buildCtx);
    normalizeReadModesForDockerCopy(path.join(buildCtx, "src"));
    normalizeReadModesForDockerCopy(stagedAgentDir);

    return {
      buildCtx,
      stagedDockerfile: path.join(buildCtx, "Dockerfile"),
    };
  } catch (error) {
    fs.rmSync(buildCtx, { recursive: true, force: true });
    throw error;
  }
}

function stageOptimizedSandboxBuildContext(
  rootDir: string,
  tmpDir: string = os.tmpdir(),
  sourceAgentDir: string = path.join(rootDir, "packages", "nemoclaw-openclaw"),
  expectedAgentDigest?: string,
): StagedBuildContext {
  const buildCtx = createBuildContextDir(tmpDir);
  try {
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const sourceBlueprintDir = path.join(rootDir, "nemoclaw-blueprint");
    const stagedBlueprintDir = path.join(buildCtx, "nemoclaw-blueprint");
    const stagedCiDir = path.join(buildCtx, "ci");
    const stagedScriptsDir = path.join(buildCtx, "scripts");

    const stagedAgentDir = stageAgentRuntimePackage(sourceAgentDir, buildCtx, expectedAgentDigest);
    fs.copyFileSync(path.join(stagedAgentDir, "Dockerfile"), stagedDockerfile);
    fs.copyFileSync(
      path.join(rootDir, "tsconfig.runtime-preloads.json"),
      path.join(buildCtx, "tsconfig.runtime-preloads.json"),
    );
    stageMcpToolDiscoveryRuntime(rootDir, buildCtx);

    fs.mkdirSync(stagedCiDir, { recursive: true });
    fs.copyFileSync(
      path.join(rootDir, "ci", "npm-audit-exceptions.json"),
      path.join(stagedCiDir, "npm-audit-exceptions.json"),
    );
    normalizeReadModesForDockerCopy(stagedCiDir);

    fs.mkdirSync(stagedBlueprintDir, { recursive: true });
    fs.copyFileSync(
      path.join(sourceBlueprintDir, "blueprint.yaml"),
      path.join(stagedBlueprintDir, "blueprint.yaml"),
    );
    fs.cpSync(
      path.join(sourceBlueprintDir, "policies"),
      path.join(stagedBlueprintDir, "policies"),
      {
        recursive: true,
      },
    );
    fs.cpSync(
      path.join(sourceBlueprintDir, "model-specific-setup"),
      path.join(stagedBlueprintDir, "model-specific-setup"),
      {
        recursive: true,
      },
    );
    normalizeReadModesForDockerCopy(stagedBlueprintDir);

    fs.mkdirSync(stagedScriptsDir, { recursive: true });
    fs.mkdirSync(path.join(stagedScriptsDir, "checks"), { recursive: true });
    fs.copyFileSync(
      path.join(rootDir, "scripts", "checks", "verify-openshell-policy-boundary-dependencies.mts"),
      path.join(stagedScriptsDir, "checks", "verify-openshell-policy-boundary-dependencies.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "checks", "materialize-locked-npm-cache-seed.mts"),
      path.join(stagedScriptsDir, "checks", "materialize-locked-npm-cache-seed.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "managed-startup-hold.sh"),
      path.join(stagedScriptsDir, "managed-startup-hold.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "managed-bootstrap-entrypoint.c"),
      path.join(stagedScriptsDir, "managed-bootstrap-entrypoint.c"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "managed-bootstrap-trampoline.sh"),
      path.join(stagedScriptsDir, "managed-bootstrap-trampoline.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "gateway-control.sh"),
      path.join(stagedScriptsDir, "gateway-control.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "managed-gateway-control.py"),
      path.join(stagedScriptsDir, "managed-gateway-control.py"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "state-dir-guard.py"),
      path.join(stagedScriptsDir, "state-dir-guard.py"),
    );
    // Shared sandbox initialisation library sourced by the entrypoint (#2277)
    fs.mkdirSync(path.join(stagedScriptsDir, "lib"), { recursive: true });
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "sandbox-init.sh"),
      path.join(stagedScriptsDir, "lib", "sandbox-init.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "corporate-ca-runtime.sh"),
      path.join(stagedScriptsDir, "lib", "corporate-ca-runtime.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "entrypoint-env-wrapper.sh"),
      path.join(stagedScriptsDir, "lib", "entrypoint-env-wrapper.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "gateway-supervisor.sh"),
      path.join(stagedScriptsDir, "lib", "gateway-supervisor.sh"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "sandbox-rlimits.sh"),
      path.join(stagedScriptsDir, "lib", "sandbox-rlimits.sh"),
    );
    // Build-time messaging applier used by OpenClaw and Hermes Dockerfiles.
    fs.cpSync(
      path.join(rootDir, "src", "lib", "messaging"),
      path.join(buildCtx, "src", "lib", "messaging"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(rootDir, "src", "lib", "tool-disclosure.ts"),
      path.join(buildCtx, "src", "lib", "tool-disclosure.ts"),
    );
    stageManagedStartupRuntimeSources(rootDir, buildCtx);
    normalizeReadModesForDockerCopy(path.join(buildCtx, "src"));
    fs.copyFileSync(
      path.join(rootDir, "scripts", "patch-bundled-npm-brace-expansion.mts"),
      path.join(stagedScriptsDir, "patch-bundled-npm-brace-expansion.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "patch-bundled-npm-tar.mts"),
      path.join(stagedScriptsDir, "patch-bundled-npm-tar.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "upgrade-bundled-npm.mts"),
      path.join(stagedScriptsDir, "upgrade-bundled-npm.mts"),
    );
    fs.mkdirSync(path.join(stagedScriptsDir, "lib"), { recursive: true });
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "patch-bundled-npm-ip-address.mts"),
      path.join(stagedScriptsDir, "lib", "patch-bundled-npm-ip-address.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "reviewed-npm-archive.mts"),
      path.join(stagedScriptsDir, "lib", "reviewed-npm-archive.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "bundled-npm-package.mts"),
      path.join(stagedScriptsDir, "lib", "bundled-npm-package.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "seed-reviewed-npm-cache.mts"),
      path.join(stagedScriptsDir, "lib", "seed-reviewed-npm-cache.mts"),
    );
    fs.copyFileSync(
      path.join(rootDir, "scripts", "lib", "reviewed-npm-audit.mts"),
      path.join(stagedScriptsDir, "lib", "reviewed-npm-audit.mts"),
    );
    normalizeReadModesForDockerCopy(stagedScriptsDir);

    return { buildCtx, stagedDockerfile };
  } catch (error) {
    fs.rmSync(buildCtx, { recursive: true, force: true });
    throw error;
  }
}

function collectBuildContextStats(
  dir: string,
  shouldInclude: BuildContextStatsFilter = () => true,
): BuildContextStats {
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (!shouldInclude(entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(entryPath).size;
      }
    }
  }

  walk(dir);
  return { fileCount, totalBytes };
}

export {
  collectBuildContextStats,
  normalizeReadModesForDockerCopy,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
};
