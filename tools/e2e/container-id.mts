// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DOCKER_CONTAINER_ID = /^[a-f0-9]{64}$/u;

interface ContainerResolverResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Validate the single immutable ID returned by a privileged container resolver. */
export function requireResolvedContainerId(
  result: ContainerResolverResult,
  sandboxName: string,
): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
    throw new Error(
      `registered sandbox container resolver failed for '${sandboxName}': ${result.stderr.trim()}`,
    );
  }
  const containerId = result.stdout.trim();
  if (!DOCKER_CONTAINER_ID.test(containerId)) {
    throw new Error("registered sandbox container resolver returned an invalid immutable ID");
  }
  return containerId;
}
