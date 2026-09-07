// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Receipt-backed command used to prove that package state is safe to capture. */
export type HarnessBackupQuiescenceDeclaration =
  | { readonly kind: "not-required"; readonly command?: never; readonly timeout_seconds?: never }
  | {
      readonly kind: "command";
      readonly command: readonly string[];
      readonly timeout_seconds: number;
    };

/** Finite core-owned operations a package may request after an ordinary snapshot restore. */
export type HarnessSnapshotRestoreAction = "repair-mutable-config" | "restart-runtime";

/** One fixed package command run inside the receipt-pinned sandbox image. */
export interface HarnessStateCommandDeclaration {
  readonly command: readonly string[];
  readonly timeout_seconds: number;
}

/** One bounded extension owned by the selected managed image. */
export interface HarnessManagedExtension {
  readonly id: string;
  /** Direct child of `state_directory`, or null when the extension lives outside captured state. */
  readonly directory: string | null;
  /** Native configuration paths owned by this image extension. */
  readonly configPaths: readonly string[];
}

/** Strict response returned by the package-owned managed-extension controller. */
export interface HarnessManagedExtensionInspection {
  readonly schemaVersion: 1;
  readonly extensions: readonly HarnessManagedExtension[];
}

/** Finite symlink shapes that package state may contain during a safe backup. */
export type HarnessStateSymlinkRule =
  | {
      readonly kind: "exact-target";
      readonly source_pattern: string;
      readonly targets: readonly string[];
    }
  | {
      readonly kind: "relative-within";
      readonly source_pattern: string;
      /** Number of ancestors above the symlink's parent that bound the resolved target. */
      readonly root_ancestor_depth: number;
      readonly forbidden_prefixes: readonly string[];
    };

/** Package-owned protocol for image extensions that must survive state replacement safely. */
export type HarnessManagedExtensionsDeclaration =
  | { readonly support: "disabled"; readonly reason: string }
  | {
      readonly support: "managed";
      /** Core appends the finite `inspect-managed-extensions` operation. */
      readonly controller: HarnessStateCommandDeclaration;
      /** Declared top-level state directory containing extension children. */
      readonly state_directory: string;
      /** Always image-owned direct children retained from the new image. */
      readonly preserved_directories: readonly string[];
      readonly allowed_symlinks: readonly HarnessStateSymlinkRule[];
    };

/** Package-owned integrity operations around core-managed state mutations. */
export type HarnessConfigIntegrityDeclaration =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "commands";
      readonly refresh: HarnessStateCommandDeclaration;
      readonly verify: HarnessStateCommandDeclaration;
    };

/** A package's finite scheduled-work transaction protocol. */
export type HarnessScheduledWorkDeclaration =
  | { readonly support: "disabled"; readonly reason: string }
  | {
      readonly support: "managed";
      /** Core appends one finite transaction action and its validated identity arguments. */
      readonly controller: HarnessStateCommandDeclaration;
      /** Relative state locations used to validate the completed backup before replacement. */
      readonly jobs_path: string;
      readonly scripts_path: string;
      readonly profiles_path: string;
      readonly runtime_root: `/sandbox/${string}`;
    };

/** Receipt-backed work performed after core restores package state. */
export type HarnessPostRestoreDeclaration =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "managed";
      readonly command: HarnessStateCommandDeclaration | null;
      readonly reapply_messaging: boolean;
      readonly restart_runtime: boolean;
      readonly mutable_config: "not-required" | "repair" | "verify";
      readonly config_integrity: HarnessConfigIntegrityDeclaration;
      readonly settle_device_pairing: boolean;
      readonly notify_gateway_token_change: boolean;
    };

/**
 * Typed rebuild behavior selected by the exact package receipt.
 *
 * The package supplies only data and fixed commands. NemoClaw retains archive
 * paths, transaction order, runtime-provider authority, resource pins,
 * deadlines, output limits, rollback, and redacted diagnostics.
 */
export interface HarnessRebuildStateDeclaration {
  readonly managed_extensions: HarnessManagedExtensionsDeclaration;
  /** Bounded non-secret environment files and keys core may preserve during rebuild. */
  readonly preserved_environment?: {
    readonly files: readonly {
      readonly path: string;
      readonly patterns: readonly string[];
      readonly render_target: string;
    }[];
  };
  readonly scheduled_work: HarnessScheduledWorkDeclaration;
  readonly post_restore: HarnessPostRestoreDeclaration;
}

/** Package-owned selection of the finite state lifecycle NemoClaw orchestrates. */
export interface HarnessStateLifecycleDeclaration {
  readonly backup_quiescence: HarnessBackupQuiescenceDeclaration;
  readonly snapshot_restore: readonly HarnessSnapshotRestoreAction[];
  readonly rebuild: HarnessRebuildStateDeclaration;
}
