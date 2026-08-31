// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { runProcessIdentityHarness } from "../helpers/process-identity.ts";

const RUNTIME_CONFIG_GUARD = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "runtime",
  "config-guard.py",
);
const SUPPORTS_NESTED_PID_NAMESPACE = false;

describe("Hermes startup process identity", () => {
  it("authenticates exactly one root namespace init and rejects stale or spoofed identities (#2426)", () => {
    const {
      openshell_argv_spoof: _openshellArgvSpoof,
      openshell_nested_argv_spoof: _openshellNestedArgvSpoof,
      openshell_supervised_command: _openshellSupervisedCommand,
      openshell_supervised_direct_command: _openshellSupervisedDirectCommand,
      openshell_noncanonical_bash: _openshellNoncanonicalBash,
      openshell_misplaced_start: _openshellMisplacedStart,
      openshell_empty_argument_spoof: _openshellEmptyArgumentSpoof,
      ...proof
    } = runProcessIdentityHarness(RUNTIME_CONFIG_GUARD);
    expect(proof).toEqual({
      remapped: true,
      stale: false,
      spoof: false,
      nonroot: false,
      noninit: false,
      wrong_namespace: false,
      duplicate: false,
      bounded: false,
      openshell_supervised: true,
      openshell_supervised_direct: true,
      openshell_landlock_all_namespaces_denied: true,
      openshell_landlock_supervisor_namespace_denied: true,
      openshell_wrong_supervisor: false,
      openshell_root_child: false,
      openshell_nested_child: false,
      // #6565 reproduces nested PID namespaces only for OpenClaw. Hermes keeps
      // its independently tested same-namespace topology until it has a
      // Hermes-specific reproduction or acceptance requirement.
      openshell_nested_pid_namespace: SUPPORTS_NESTED_PID_NAMESPACE,
      openshell_cross_namespace_outer_pid: false,
      openshell_nested_landlock_all_namespaces_denied: SUPPORTS_NESTED_PID_NAMESPACE,
      openshell_nested_landlock_supervisor_namespace_denied: SUPPORTS_NESTED_PID_NAMESPACE,
      openshell_non_direct_child: false,
      openshell_spoof: false,
      openshell_duplicate: false,
      openshell_required_child: true,
      openshell_wrong_required_child: false,
      openshell_nested_required_child: SUPPORTS_NESTED_PID_NAMESPACE,
      openshell_nested_wrong_required_child: false,
    });
  });
});

describe("Hermes exact startup argv", () => {
  it("rejects a trusted script path smuggled in an unrelated argv (#6565)", () => {
    const proof = runProcessIdentityHarness(RUNTIME_CONFIG_GUARD);

    expect(proof.openshell_argv_spoof).toBe(false);
    expect(proof.openshell_nested_argv_spoof).toBe(false);
    expect(proof.openshell_supervised_command).toBe(true);
    expect(proof.openshell_supervised_direct_command).toBe(true);
    expect(proof.openshell_noncanonical_bash).toBe(false);
    expect(proof.openshell_misplaced_start).toBe(false);
    expect(proof.openshell_empty_argument_spoof).toBe(false);
  });
});
