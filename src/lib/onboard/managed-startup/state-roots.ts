// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { HarnessManagedImageDeclaration } from "@nvidia/nemoclaw-harness-contract";

export interface ManagedStartupStateRoot {
  readonly mountTarget: string;
  readonly resourceIdentity: string;
  readonly ownershipLabels: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly readWrite: boolean;
}

export interface ManagedStartupWorkspaceRoot {
  readonly uid: number;
  readonly gid: number;
  readonly mode: 0o755 | 0o1775;
}

export const MANAGED_HERMES_STATE_ROOT = "/sandbox/.hermes" as const;
export const MANAGED_OPENCLAW_STATE_ROOT = "/sandbox/.openclaw" as const;
const HERMES_STATE_VOLUME_NAME_PREFIX = "nemoclaw-hermes-state-v1";
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

type ManagedImageRuntimeLayout = Pick<
  HarnessManagedImageDeclaration,
  "runtime_identity" | "state_root" | "workspace"
>;

function exactPackageId(packageId: string): string {
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new Error("Managed startup state-root package identity is invalid.");
  }
  return packageId;
}

function declaredMode(mode: string): number {
  return Number.parseInt(mode, 8);
}

function exactSandboxName(sandboxName: string): string {
  if (
    sandboxName.length === 0 ||
    sandboxName.includes("\0") ||
    sandboxName.includes("/") ||
    sandboxName === "." ||
    sandboxName === ".."
  ) {
    throw new Error("Managed startup state-root sandbox identity is invalid.");
  }
  return sandboxName;
}

function exactAgentIdentity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`Managed startup state-root ${label} authority is invalid.`);
  }
  return value;
}

export function managedStartupWorkspaceRoot(input: {
  readonly managedImage: ManagedImageRuntimeLayout;
}): ManagedStartupWorkspaceRoot {
  const uid = exactAgentIdentity(input.managedImage.runtime_identity.uid, "workspace UID");
  const gid = exactAgentIdentity(input.managedImage.runtime_identity.gid, "workspace GID");
  const declaration = input.managedImage.workspace ?? { owner: "runtime", mode: "0755" };
  return Object.freeze({
    uid: declaration.owner === "root" ? 0 : uid,
    gid,
    mode: declaredMode(declaration.mode) as ManagedStartupWorkspaceRoot["mode"],
  });
}

export function managedStartupStateRoots(input: {
  readonly packageId: string;
  readonly sandboxName: string;
  readonly managedImage: ManagedImageRuntimeLayout;
}): readonly ManagedStartupStateRoot[] {
  const packageId = exactPackageId(input.packageId);
  const sandboxName = exactSandboxName(input.sandboxName);
  const uid = exactAgentIdentity(input.managedImage.runtime_identity.uid, "UID");
  const gid = exactAgentIdentity(input.managedImage.runtime_identity.gid, "GID");
  const declaration = input.managedImage.state_root;
  if (!declaration) return Object.freeze([]);
  const mountTarget = declaration.mount_target;
  if (
    !/^\/sandbox\/[^/]+$/u.test(mountTarget) ||
    !path.posix.isAbsolute(mountTarget) ||
    path.posix.normalize(mountTarget) !== mountTarget
  ) {
    throw new Error("Managed startup state-root mount target is invalid.");
  }
  const labelPrefix = `io.nvidia.nemoclaw.${packageId}-state`;
  return Object.freeze([
    Object.freeze({
      mountTarget,
      resourceIdentity: `nemoclaw-${packageId}-state-v1-${sandboxName}`,
      ownershipLabels: Object.freeze({
        [`${labelPrefix}.managed`]: "true",
        [`${labelPrefix}.schema`]: "1",
        [`${labelPrefix}.sandbox`]: sandboxName,
        [`${labelPrefix}.target`]: mountTarget,
      }),
      uid,
      gid,
      mode: declaredMode(declaration.mode),
      readWrite: true,
    }),
  ]);
}

export function managedHermesStateVolumeName(sandboxName: string): string {
  return `${HERMES_STATE_VOLUME_NAME_PREFIX}-${exactSandboxName(sandboxName)}`;
}

export function managedHermesStateVolumeLabels(
  sandboxName: string,
): Readonly<Record<string, string>> {
  const [root] = managedStartupStateRoots({
    packageId: "hermes",
    sandboxName,
    managedImage: {
      runtime_identity: { uid: 1, gid: 1, workdir: "/sandbox" },
      state_root: { mount_target: MANAGED_HERMES_STATE_ROOT, mode: "3770" },
    },
  });
  return root?.ownershipLabels ?? Object.freeze({});
}
