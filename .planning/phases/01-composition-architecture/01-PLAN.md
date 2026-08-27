<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 1 Plan: Architecture Baseline

## Goal

Produce a decision-ready component architecture against exact current main without implementing a
new supported surface.

## Tasks

- [x] Refresh `origin/main` and create a clean local architecture branch.
- [x] Preserve the previous package migration and user-owned local state.
- [x] Quantify why a direct merge or rebase is unsafe.
- [x] Map current agent, runtime-provider, serving, platform, messaging, MCP, state, dashboard,
  observability, CLI, installer, and test boundaries.
- [x] Audit the previous package installer, onboarding workflow, folder structures, and test lanes.
- [x] Evaluate NeMo Fabric stable and current source against NemoClaw's real boundaries.
- [x] Define the common package envelope and three typed contracts.
- [x] Define in-tree structures, CLI behavior, selection receipt, update model, migration order,
  testing, effort, risks, and required decisions.
- [x] Record the candidate in GSD project, requirements, roadmap, state, research, and summary files.
- [ ] Receive the maintainer product-scope decision required before Phase 2.

## Verification

- `git status --short --branch`
- `git diff --check`
- Markdown and repository checks for the added GSD artifacts
- independent evidence review of current code paths and NeMo Fabric conclusions

## Stop Condition

Do not implement Phase 2 until a recorded decision has status `Accept` and states the reason,
repository placement, accountable maintainer, initial supported components, trust and activation
policy, validation plan and environments, and rollback plan for the exact proposal revision.
