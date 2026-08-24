---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: agent-runtime-package-migration
status: executing
stopped_at: Phase 11 Task 1
last_updated: "2026-08-23T23:18:00-04:00"
last_activity: 2026-08-23 - Merged origin/main locally and started the package workflow phase.
progress:
  total_phases: 11
  completed_phases: 0
  total_plans: 51
  completed_plans: 3
  percent: 6
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 11 of 11 (Package Workflow)
Plan: 11-01
Task: 1 of 4 - Freeze the package workflow and configuration command
Status: Executing

The branch is based on `origin/main` commit `67aab7ef57` through local merge commit `fff00cbbfb`.
The worktree was clean when Phase 11 started. All commits remain local.

## Completion Tracker

- [ ] Task 1: Freeze the package workflow and configuration command.
- [ ] Task 2: Reorganize OpenClaw, Hermes, and LangChain Deep Agents Code.
- [ ] Task 3: Remove proven agent-specific core dispatch.
- [ ] Task 4: Qualify deterministic checks and one no-messaging live journey.

## Success Conditions

- Existing onboarding choices, flags, aliases, and sandbox behavior do not change.
- Each package tree explains build, configuration, startup, runtime, compatibility, and checks.
- Managed startup invokes `/usr/local/lib/nemoclaw/generate-config` for every current managed agent.
- NemoClaw core does not select a configuration generator by agent ID.
- Package contracts, focused tests, type-checks, and repository checks pass.
- One configured Brev environment completes a credential-free install through cleanup journey.
- Live messaging-service tests remain excluded.

## Decisions

- Keep the common root contract: `README.md`, `package.json`, `manifest.yaml`, `Dockerfile.base`,
  `Dockerfile`, `start.sh`, and `policy-additions.yaml`.
- Use responsibility directories only when the package needs them: `config`, `runtime`, `host`,
  `compat`, `plugin`, and `checks`.
- Use one or two words for file names when that is precise. Permit a third word only when needed.
- Use descriptive function and class names that state the action and object.
- Treat host helpers as bounded transition code. Do not create an unrestricted callback system.
- Keep current MCP behavior until a fixed in-sandbox mutation boundary can replace its closed
  adapter dispatch.
- Keep OpenShell at `0.0.106`.

## Constraints

- This branch is a local implementation candidate. It does not establish canonical support.
- Do not push or write to GitHub.
- Do not print or commit values from `.env`.
- Do not run live Telegram, Discord, Slack, WeChat, WhatsApp, Microsoft Teams, or Google Chat tests.
- Preserve the `stash@{0}` OpenShell `0.0.111` migration unless the user requests it.

## Validation Evidence

Upstream merge `fff00cbbfb`:

- `npm run typecheck:cli` passed.
- Focused CLI tests passed: 56 assertions.
- Focused integration tests passed: 162 assertions across the merge and Dockerfile checks.
- Focused E2E-support tests passed: 23 assertions.
- `npm run checks:repository` passed.
- Normal pre-commit and commit-msg hooks passed.

## Resume

Read `.planning/phases/11-package-workflow/11-CONTEXT.md` and execute
`.planning/phases/11-package-workflow/11-01-PLAN.md` from Task 1.
