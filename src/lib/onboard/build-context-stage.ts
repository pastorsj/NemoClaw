// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import { validateHarnessPackage } from "../agent-runtime/package/validation";
import { isErrnoException } from "../core/errno";
import {
  collectBuildContextStats,
  SANDBOX_BUILD_CONTEXT_PREFIX,
  type SandboxBuildContextOrigin,
  type StagedBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../sandbox/build-context";
import { SandboxBaseImageResolutionError } from "../sandbox-base-image";
import {
  CUSTOM_BUILD_CONTEXT_WARN_BYTES,
  createCustomBuildContextFilter,
  isInsideIgnoredCustomBuildContextPath,
} from "./custom-build-context";

export interface CreateSandboxBuildContextInput {
  root: string;
  fromDockerfile: string | null;
  agent: AgentDefinition | null | undefined;
  createAgentSandbox(agent: AgentDefinition): StagedBuildContext;
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  exit?(code?: number): never;
  stageDefaultSandboxBuildContext?(rootDir: string): StagedBuildContext;
}

export interface CreateSandboxBuildContextResult extends StagedBuildContext {
  origin: SandboxBuildContextOrigin;
  cleanupBuildCtx(): boolean;
}

/** Exact staged and patched context transferred from rebuild preflight to create. */
export interface PreparedSandboxBuildContext extends CreateSandboxBuildContextResult {
  buildId: string;
  dashboardRemoteBindPrepared?: boolean;
  /** Recheck retained bytes at the final one-shot consumption boundary. */
  verifyBuildCtx?(): boolean;
  /** Exact recorded target authorized to consume a generic rebuild handoff. */
  rebuildTarget?: {
    agentName: string | null;
    fromDockerfile: string | null;
  };
}

function isSameFile(leftPath: string, rightPath: string): boolean {
  try {
    return fs.realpathSync(leftPath) === fs.realpathSync(rightPath);
  } catch {
    return path.resolve(leftPath) === path.resolve(rightPath);
  }
}

function isCanonicalFile(filePath: string, expectedPath: string): boolean {
  try {
    return path.resolve(filePath) === expectedPath && fs.realpathSync(filePath) === expectedPath;
  } catch {
    return false;
  }
}

function isMatchingRepositoryDockerfile(
  selectedDockerfile: string,
  agent: AgentDefinition,
): boolean {
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(agent.name) ||
    typeof agent.packageRoot !== "string" ||
    !agent.dockerfilePath
  ) {
    return false;
  }

  const packageDirectoryName = `nemoclaw-${agent.name}`;
  const sourcePackageRoot = path.dirname(selectedDockerfile);
  const sourcePackagesRoot = path.dirname(sourcePackageRoot);
  if (
    path.basename(selectedDockerfile) !== "Dockerfile" ||
    path.basename(sourcePackageRoot) !== packageDirectoryName ||
    path.basename(sourcePackagesRoot) !== "packages"
  ) {
    return false;
  }

  const repositoryRoot = path.dirname(sourcePackagesRoot);
  const installedPackageRoot = path.resolve(agent.packageRoot);
  const expectedSourceDockerfile = path.join(
    repositoryRoot,
    "packages",
    packageDirectoryName,
    "Dockerfile",
  );
  const expectedInstalledDockerfile = path.join(
    installedPackageRoot,
    "packages",
    packageDirectoryName,
    "Dockerfile",
  );
  if (
    !isCanonicalFile(selectedDockerfile, expectedSourceDockerfile) ||
    !isCanonicalFile(agent.dockerfilePath, expectedInstalledDockerfile)
  ) {
    return false;
  }

  try {
    // The caller revalidates the selected package authority before staging.
    // This boundary separately proves that source, built, and installed bytes
    // still describe that same package before treating --from as managed.
    if (!fs.readFileSync(selectedDockerfile).equals(fs.readFileSync(agent.dockerfilePath))) {
      return false;
    }
    const bundledIdentity = validateHarnessPackage(
      path.join(repositoryRoot, "dist", "harnesses", packageDirectoryName),
    ).identity;
    const installedIdentity = validateHarnessPackage(installedPackageRoot).identity;
    return (
      bundledIdentity.id === agent.name &&
      installedIdentity.id === agent.name &&
      bundledIdentity.kind === installedIdentity.kind &&
      bundledIdentity.id === installedIdentity.id &&
      bundledIdentity.packageVersion === installedIdentity.packageVersion &&
      bundledIdentity.contentDigest === installedIdentity.contentDigest
    );
  } catch {
    return false;
  }
}

function createCleanupBuildContext(buildCtx: string): () => boolean {
  return () => {
    try {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
}

export function stageCreateSandboxBuildContext(
  input: CreateSandboxBuildContextInput,
): CreateSandboxBuildContextResult {
  const log = input.log ?? console.log;
  const warn = input.warn ?? console.warn;
  const error = input.error ?? console.error;
  const exit = input.exit ?? ((code?: number): never => process.exit(code));
  const origin = input.fromDockerfile ? "custom" : "generated";

  let build: StagedBuildContext;

  if (input.fromDockerfile) {
    const fromResolved = path.resolve(input.fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      error(`  Custom Dockerfile not found: ${fromResolved}`);
      exit(1);
    }
    if (!fs.statSync(fromResolved).isFile()) {
      error(`  Custom Dockerfile path is not a file: ${fromResolved}`);
      exit(1);
    }
    // The managed agent Dockerfile copies repository-root paths (src/,
    // scripts/, nemoclaw-blueprint/), so the parent-directory contract can
    // never satisfy it. Stage it exactly like the managed build instead of
    // failing at the first COPY (#7205).
    const agentDockerfile = input.agent?.dockerfilePath ?? null;
    const defaultDockerfile = path.join(input.root, "Dockerfile");
    if (!input.agent && isSameFile(fromResolved, defaultDockerfile)) {
      // A null agent selects the repository's default OpenClaw build. Only
      // that exact Dockerfile inherits the managed root build context; any
      // other caller-supplied Dockerfile remains on the custom boundary.
      log(`  Using trusted OpenClaw Dockerfile: ${fromResolved}`);
      log("  Staging the repository root as the default OpenClaw build context.");
      build = (input.stageDefaultSandboxBuildContext ?? stageOptimizedSandboxBuildContext)(
        input.root,
      );
      return {
        ...build,
        origin: "generated",
        cleanupBuildCtx: createCleanupBuildContext(build.buildCtx),
      };
    }
    const isSelectedAgentDockerfile =
      input.agent &&
      agentDockerfile &&
      (isSameFile(fromResolved, agentDockerfile) ||
        isMatchingRepositoryDockerfile(fromResolved, input.agent));
    if (input.agent && isSelectedAgentDockerfile) {
      log(`  Using trusted ${input.agent.displayName} Dockerfile: ${fromResolved}`);
      log(
        `  Staging the selected ${input.agent.displayName} package as the managed build context.`,
      );
      try {
        build = input.createAgentSandbox(input.agent);
      } catch (err) {
        if (err instanceof SandboxBaseImageResolutionError) {
          error(`  ${err.message}`);
          exit(1);
        }
        throw err;
      }
      return {
        ...build,
        origin: "generated",
        cleanupBuildCtx: createCleanupBuildContext(build.buildCtx),
      };
    }
    const buildContextDir = path.dirname(fromResolved);
    if (isInsideIgnoredCustomBuildContextPath(buildContextDir)) {
      error(`  Custom Dockerfile is inside an ignored build-context path: ${buildContextDir}`);
      error("  Move your Dockerfile to a dedicated directory and retry.");
      exit(1);
    }
    log(`  Using custom Dockerfile: ${fromResolved}`);
    log(`  Docker build context: ${buildContextDir}`);
    const shouldIncludeCustomContextPath = createCustomBuildContextFilter(buildContextDir);
    const buildContextStats = collectBuildContextStats(
      buildContextDir,
      shouldIncludeCustomContextPath,
    );
    if (buildContextStats.totalBytes > CUSTOM_BUILD_CONTEXT_WARN_BYTES) {
      const sizeMb = (buildContextStats.totalBytes / 1_000_000).toFixed(1);
      warn(
        `  WARN: build context contains about ${sizeMb} MB across ${buildContextStats.fileCount} files.`,
      );
      warn(
        "  The --from flag sends the Dockerfile's parent directory to Docker; use a dedicated directory if this is not intentional.",
      );
    }
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const cleanupCustomBuildCtx = (): void => {
      try {
        fs.rmSync(buildCtx, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; the original error is more useful to the caller.
      }
    };
    try {
      fs.cpSync(buildContextDir, buildCtx, {
        recursive: true,
        filter: shouldIncludeCustomContextPath,
      });
      // Always materialize the selected Dockerfile as a regular file. cpSync
      // preserves symlinks, which would otherwise leave a retained rebuild
      // context dependent on a mutable source path after preflight succeeds.
      fs.rmSync(stagedDockerfile, { force: true });
      fs.copyFileSync(fromResolved, stagedDockerfile);
    } catch (err) {
      cleanupCustomBuildCtx();
      const errorObject = typeof err === "object" && err !== null ? err : null;
      if (isErrnoException(errorObject) && errorObject.code === "EACCES") {
        error(`  Permission denied while copying build context from: ${buildContextDir}`);
        error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        error("  Move your Dockerfile to a dedicated directory and retry.");
        exit(1);
      }
      throw err;
    }
    build = { buildCtx, stagedDockerfile };
  } else if (input.agent) {
    try {
      build = input.createAgentSandbox(input.agent);
    } catch (err) {
      if (err instanceof SandboxBaseImageResolutionError) {
        error(`  ${err.message}`);
        exit(1);
      }
      throw err;
    }
  } else {
    build = (input.stageDefaultSandboxBuildContext ?? stageOptimizedSandboxBuildContext)(
      input.root,
    );
  }

  return {
    ...build,
    origin,
    cleanupBuildCtx: createCleanupBuildContext(build.buildCtx),
  };
}
