// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directDockerfileCopySources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const DOCKERFILE_BASE = path.join(REPO_ROOT, "packages", "nemoclaw-openclaw", "Dockerfile.base");
const DOCKERIGNORE = path.join(REPO_ROOT, ".dockerignore");
const OLD_OPENCLAW_VERSION = "2026.3.11";
const OPENCLAW_MANIFEST_RELPATH = "packages/nemoclaw-openclaw/manifest.yaml";

export function oldBaseContextSources(): string[] {
  return directDockerfileBaseCopySources();
}

export function directDockerfileBaseCopySources(dockerfilePath = DOCKERFILE_BASE): string[] {
  return directDockerfileCopySources(dockerfilePath, "Dockerfile.base").map(({ source }) => {
    validateOldBaseContextSource(source);
    return source;
  });
}

export function dockerignoreSecretPatterns(dockerignorePath = DOCKERIGNORE): string[] {
  const patterns: string[] = [];
  let inSecuritySection = false;

  for (const rawLine of fs.readFileSync(dockerignorePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#\s*Security:/i.test(line)) {
      inSecuritySection = true;
      continue;
    }
    if (!inSecuritySection || !line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      throw new Error(`Unsupported negated .dockerignore security pattern: ${line}`);
    }
    patterns.push(line.replace(/^\.\//, ""));
  }

  if (patterns.length === 0) {
    throw new Error("No .dockerignore security patterns found");
  }
  return patterns;
}

function dockerignorePatternMatchesPath(pattern: string, relativePath: string): boolean {
  const normalizedPattern = pattern.replace(/^\/+/, "");
  const parts = relativePath.split("/");
  const fileName = parts.at(-1) ?? "";

  if (normalizedPattern.endsWith("/")) {
    const dirName = normalizedPattern.replace(/\/+$/, "");
    return parts.includes(dirName);
  }

  const target = normalizedPattern.includes("/") ? relativePath : fileName;
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

function matchesDockerignoreSecretPattern(relativePath: string): boolean {
  return dockerignoreSecretPatterns().some((pattern) =>
    dockerignorePatternMatchesPath(pattern, relativePath),
  );
}

function validateOldBaseContextSource(relativePath: string): string {
  const parts = relativePath.split("/");
  const resolved = path.resolve(REPO_ROOT, relativePath);
  const repoPrefix = `${REPO_ROOT}${path.sep}`;
  const invalidSource =
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /[$*?[\]"']/.test(relativePath) ||
    relativePath.startsWith("--") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    (resolved !== REPO_ROOT && !resolved.startsWith(repoPrefix));
  if (invalidSource) {
    throw new Error(`Unsupported direct Dockerfile.base COPY source: ${relativePath}`);
  }
  if (matchesDockerignoreSecretPattern(relativePath)) {
    throw new Error(
      `Unsupported .dockerignore-secret Dockerfile.base COPY source: ${relativePath}`,
    );
  }
  return resolved;
}

function copyOldBaseContextFile(buildContext: string, relativePath: string): void {
  const source = validateOldBaseContextSource(relativePath);
  const target = path.join(buildContext, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function createOldBaseBuildContext(): string {
  const buildContext = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-base-"));
  // The legacy bash test builds Dockerfile.base with the full repository as
  // context after temporarily lowering the package constraint in-place. Keep the
  // trusted checkout read-only while staging every current Dockerfile.base
  // direct COPY dependency needed by that old-base build.
  for (const relativePath of oldBaseContextSources()) {
    copyOldBaseContextFile(buildContext, relativePath);
  }

  const stagedManifest = path.join(buildContext, ...OPENCLAW_MANIFEST_RELPATH.split("/"));
  const original = fs.readFileSync(stagedManifest, "utf8");
  const versionConstraint = /^(\s*version_constraint:\s*).*/m;
  if (!versionConstraint.test(original)) {
    throw new Error("OpenClaw package version_constraint line was not found");
  }
  const lowered = original.replace(versionConstraint, `$1">=${OLD_OPENCLAW_VERSION}"`);
  fs.writeFileSync(stagedManifest, lowered, "utf8");
  return buildContext;
}
