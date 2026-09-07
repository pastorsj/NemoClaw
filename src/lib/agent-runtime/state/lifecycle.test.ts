// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManifestRecord } from "../manifest-types";
import { readStateLifecycle } from "./lifecycle";

const UNSAFE_PRIVILEGED_COMMAND_PATHS = [
  "/sandbox/state-control",
  "/usr/local/bin/../sandbox/state-control",
  "/usr/local/bin/future\\state-control",
  "/usr/local/bin/future\u001b-state-control",
] as const;

function stateManifest(options: {
  readonly backupCommand?: string;
  readonly managedExtensionCommand?: string;
  readonly scheduledWorkCommand?: string;
}): ManifestRecord {
  const scheduledWork: ManifestRecord = options.scheduledWorkCommand
    ? {
        support: "managed",
        controller: { command: [options.scheduledWorkCommand], timeout_seconds: 30 },
        jobs_path: "tasks/jobs.json",
        scripts_path: "tasks/scripts",
        profiles_path: "profiles",
        runtime_root: "/sandbox/.future",
      }
    : { support: "disabled", reason: "This package does not run scheduled work." };
  const postRestore: ManifestRecord = options.scheduledWorkCommand
    ? {
        kind: "managed",
        command: null,
        reapply_messaging: false,
        restart_runtime: true,
        mutable_config: "not-required",
        config_integrity: { kind: "not-required" },
        settle_device_pairing: false,
        notify_gateway_token_change: false,
      }
    : { kind: "not-required" };
  const managedExtensions: ManifestRecord = options.managedExtensionCommand
    ? {
        support: "managed",
        controller: {
          command: [options.managedExtensionCommand],
          timeout_seconds: 30,
        },
        state_directory: "extensions",
        preserved_directories: [],
        allowed_symlinks: [],
      }
    : {
        support: "disabled",
        reason: "This package has no managed extensions.",
      };
  const backupQuiescence: ManifestRecord = options.backupCommand
    ? { kind: "command", command: [options.backupCommand], timeout_seconds: 15 }
    : { kind: "not-required" };
  return {
    state_lifecycle: {
      backup_quiescence: backupQuiescence,
      snapshot_restore: [],
      rebuild: {
        managed_extensions: managedExtensions,
        scheduled_work: scheduledWork,
        post_restore: postRestore,
      },
    },
  };
}

describe("privileged state lifecycle commands", () => {
  it.each(UNSAFE_PRIVILEGED_COMMAND_PATHS)(
    "rejects the unsafe backup command path %j",
    (commandPath) => {
      expect(() => readStateLifecycle(stateManifest({ backupCommand: commandPath }))).toThrow(
        /backup_quiescence\.command\[0\].*image-owned executable path/u,
      );
    },
  );

  it.each(UNSAFE_PRIVILEGED_COMMAND_PATHS)(
    "rejects the unsafe managed-extension command path %j",
    (commandPath) => {
      expect(() =>
        readStateLifecycle(stateManifest({ managedExtensionCommand: commandPath })),
      ).toThrow(/managed_extensions\.controller\.command/u);
    },
  );

  it.each(UNSAFE_PRIVILEGED_COMMAND_PATHS)(
    "rejects the unsafe scheduled-work command path %j",
    (commandPath) => {
      expect(() =>
        readStateLifecycle(stateManifest({ scheduledWorkCommand: commandPath })),
      ).toThrow(/scheduled_work\.controller\.command/u);
    },
  );
});
