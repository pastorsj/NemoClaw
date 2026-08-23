#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type RemediationRequest = Readonly<{
  archivePath: string;
  env?: NodeJS.ProcessEnv;
  helperPath: string;
  packageSpec: string;
  workingDirectory: string;
}>;

export type RemediatedArchive = Readonly<
  | {
      archivePath: string;
      integrity: string;
      remediated: false;
    }
  | {
      archivePath: string;
      integrity: string;
      metadataIntegrity: string;
      remediated: true;
      treeIntegrity: string;
    }
>;

export const OPENCLAW_NPM_REMEDIATION_HELPER_ENV =
  "NEMOCLAW_OPENCLAW_NPM_REMEDIATION_HELPER";

function requirePackageHelperPath(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !isAbsolute(value)) {
    throw new Error("OpenClaw npm remediation requires an absolute package-helper path");
  }
  const helperPath = resolve(value);
  if (helperPath !== value) {
    throw new Error("OpenClaw npm remediation package-helper path must be canonical");
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(helperPath);
  } catch (error) {
    throw new Error(`OpenClaw npm remediation package helper is unavailable: ${helperPath}`, {
      cause: error,
    });
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o022) !== 0 ||
    (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
  ) {
    throw new Error(`OpenClaw npm remediation package helper is not trusted: ${helperPath}`);
  }
  return helperPath;
}

function parseRemediationResult(output: string): RemediatedArchive {
  const result = JSON.parse(output) as Partial<RemediatedArchive>;
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.archivePath !== "string" ||
    typeof result.integrity !== "string" ||
    typeof result.remediated !== "boolean" ||
    (result.remediated &&
      (typeof result.metadataIntegrity !== "string" || typeof result.treeIntegrity !== "string"))
  ) {
    throw new Error("OpenClaw npm remediation helper returned an invalid result");
  }
  return result as RemediatedArchive;
}

/** Run the package-owned remediation from the shared messaging build boundary. */
export function remediateReviewedOpenClawPluginArchive(
  request: RemediationRequest,
): RemediatedArchive {
  const helperPath = requirePackageHelperPath(request.helperPath);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      helperPath,
      "--archive",
      resolve(request.archivePath),
      "--package-spec",
      request.packageSpec,
      "--working-directory",
      resolve(request.workingDirectory),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...request.env },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `OpenClaw npm remediation helper exited with status ${String(result.status ?? "unknown")}: ${result.stderr.trim()}`,
    );
  }
  return parseRemediationResult(result.stdout);
}
