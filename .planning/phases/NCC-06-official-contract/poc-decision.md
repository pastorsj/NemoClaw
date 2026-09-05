<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Official-ready contract local POC decision

- **Status:** Accept — local fork implementation and development evaluation only.
- **Accepted:** 2026-09-05, when the local fork owner directed execution of the audited completion
  work.
- **Decision owner:** Sam Pastoriza, owner of the local fork branch.
- **Reason:** Determine whether NemoClaw can offer one understandable, typed, capability-driven
  harness package contract without retaining harness-specific behavior in its trusted core.
- **Placement:** NemoClaw core owns package authority, platform and runtime orchestration,
  credentials, policy, transactions, rollback, and the finite contract. Harness-native behavior
  and tests live in their packages. NeMo Fabric remains the package-selected headless data plane.
- **Scope:** The POC may add typed authoring and conformance support, explicit package capabilities,
  operator-selected external artifacts, package lifecycle operations, generic managed composition,
  package-owned E2E invocation, architecture guardrails, and package-by-package native migrations.
- **Trust boundary:** The first external source is an operator-selected local artifact. NemoClaw
  must validate its complete tree, digest, compatibility, and receipt before activation. This does
  not establish publisher authenticity, registry approval, or support.
- **Compatibility:** The contract has no V1/V2 product labels. Packages declare compatible
  NemoClaw ranges and capabilities; unsupported or incompatible operations fail before mutation.
- **Validation:** Deterministic contract and package tests precede no-messaging macOS and Brev live
  journeys. Exact revision, package digest, runtime identity, redaction, cleanup, and rollback
  evidence are required.
- **Lifecycle:** Each migration moves one native behavior and its detailed tests, replaces the core
  branch with data, a fixed sandbox command, or a finite typed plan, and deletes the old branch.
- **Rollback:** Revert the local milestone commits. Existing sandboxes remain pinned to their exact
  package receipts and must never silently follow another package object.
- **Product boundary:** This decision authorizes only the local POC. It does not activate or
  document canonical NemoClaw support. Upstream support still requires a separate recorded product
  decision with accountable NVIDIA maintainers.
