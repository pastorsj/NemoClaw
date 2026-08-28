---
phase: NCC-02-agent-package-foundation
plan: 09
subsystem: registry-package-authority
tags: [registry, route, policy, package-identity]
requires: [02-08]
provides:
  - Exact optional package identity on final and pending registry state
  - Optional migration provenance on the owning sandbox row
affects: [02-10, 02-15, 02-16, 02-17]
requirements-completed: [PKG-03A, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 09: Registry Package Authority Summary

Final registry rows, pending route reservations, and pending verified-policy state can now retain
one exact package identity without resolving pointers or inventing authority.

## Accomplishments

- Added optional exact identity and migration provenance to the owning sandbox schema.
- Preserved exact identity through route reservations and pending policy verification.
- Kept legacy absence readable while rejecting malformed present state before mutation.
- Kept migration provenance on the owner; nested pending policy state carries identity only.

## Commits

1. `99b49d9c6e` — add registry package authority
2. `07f9ea988e` — preserve pending package authority

## Verification

- 131 focused state, route, policy, and security tests passed.
- CLI typecheck, repository checks, project membership, growth checks, format, and lint passed.

## Self-Check: PASSED
