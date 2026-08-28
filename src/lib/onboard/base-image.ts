// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  buildLocalBaseTag,
  defaultOpenclawBaseDockerfile,
  resolveSandboxBaseImage,
  OPENCLAW_SANDBOX_BASE_IMAGE as SANDBOX_BASE_IMAGE,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { sandboxBaseImageHasSecurityInventory } from "../sandbox-base-image/security-inventory";
import { getInstalledOpenshellVersion } from "./openshell-version";

/**
 * Reject a published or cached OpenClaw base that predates the immutable
 * security package inventory consumed by the completed-image verification.
 * Accepting that base only defers the mismatch to the last Dockerfile layer,
 * after the expensive final image has already been built.
 */
export const openClawBaseImageHasSecurityInventory = sandboxBaseImageHasSecurityInventory;

function requireOpenClawBaseDockerfile(rootDir: string): string {
  if (!path.isAbsolute(rootDir) || path.resolve(rootDir) !== rootDir) {
    throw new Error("OpenClaw package root must be a canonical absolute path");
  }
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(rootDir);
  } catch {
    throw new Error(`OpenClaw package root is missing: ${rootDir}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`OpenClaw package root is not a trusted directory: ${rootDir}`);
  }

  const dockerfilePath = defaultOpenclawBaseDockerfile(rootDir);
  let resolvedDockerfile: string;
  try {
    resolvedDockerfile = fs.realpathSync(dockerfilePath);
  } catch {
    throw new Error(`OpenClaw base Dockerfile is missing: ${dockerfilePath}`);
  }
  const relative = path.relative(rootDir, resolvedDockerfile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("OpenClaw base Dockerfile escapes its package root");
  }
  if (!fs.statSync(resolvedDockerfile).isFile()) {
    throw new Error(`OpenClaw base Dockerfile is not a file: ${dockerfilePath}`);
  }
  return resolvedDockerfile;
}

/**
 * Resolve a compatible sandbox-base image and pin it to a repo digest when
 * possible. PR-branch validation tries the nearest release tag before
 * source-SHA or latest; an unavailable or incompatible nearest release tag
 * requires a local Dockerfile.base build instead of falling through to a
 * mutable tag.
 */
export function pullAndResolveBaseImageDigest(options: {
  rootDir: string;
  requireOpenshellSandboxAbi?: boolean;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceRefresh?: boolean;
}): {
  digest: string | null;
  ref: string;
  source?: string;
  glibcVersion?: string | null;
  metadata?: SandboxBaseImageResolutionMetadata;
} | null {
  const dockerfilePath = requireOpenClawBaseDockerfile(options.rootDir);
  return resolveSandboxBaseImage({
    imageName: SANDBOX_BASE_IMAGE,
    dockerfilePath,
    localTag: buildLocalBaseTag("nemoclaw-sandbox-base-local", options.rootDir),
    envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
    label: "OpenClaw sandbox base image",
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    validateImage: openClawBaseImageHasSecurityInventory,
    validationDescription: "the immutable security package inventory",
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceRefresh,
    rootDir: options.rootDir,
  });
}

export function getStableGatewayImageRef(versionOutput: string | null = null): string | null {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}
