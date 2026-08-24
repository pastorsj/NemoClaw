---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: agent-runtime-package-migration
status: completed
stopped_at: Phase 11 Plan 01 complete
last_updated: "2026-08-24T13:49:00-04:00"
last_activity: 2026-08-24 - Completed the in-tree package workflow and no-messaging live qualification.
progress:
  total_phases: 11
  completed_phases: 1
  total_plans: 51
  completed_plans: 4
  percent: 8
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 11 of 11 (Package Workflow)
Plan: 11-01
Task: 5 of 5 - Qualify deterministic checks and one no-messaging live journey
Status: Complete

The branch is based on `origin/main` commit `67aab7ef57` through local merge commit `fff00cbbfb`.
`git status --short` had no entries when Phase 11 started. The local remote-tracking ref
`pastorsj/agent-runtime-package-migration` points to `72f9622736`. Commits through `fbf3b94280`
and the closing GSD summary remain local.

## Completion Tracker

- [x] Task 1: Freeze the package workflow and configuration command.
- [x] Task 2: Reorganize OpenClaw, Hermes, and LangChain Deep Agents Code.
- [x] Task 3: Remove proven agent-specific core dispatch.
- [x] Task 4: Make OpenClaw and Hermes startup entrypoints readable.
- [x] Task 5: Qualify deterministic checks and one no-messaging live journey.

## Success Conditions

- Existing onboarding choices, flags, aliases, and sandbox behavior do not change.
- Each package tree explains build, configuration, startup, runtime, compatibility, and checks.
- Managed startup invokes `/usr/local/lib/nemoclaw/generate-config` for every current managed agent.
- NemoClaw core does not select a configuration generator by agent ID.
- Package contracts, focused tests, type-checks, and repository checks pass.
- OpenClaw and Hermes `start.sh` files remain visible workflows backed by bounded runtime modules.
- One configured Brev environment completes a no-messaging install through cleanup journey.
- Live messaging-service tests remain excluded.

## Decisions

- Keep the registry-required root contract: `package.json`, `manifest.yaml`, `Dockerfile.base`,
  `Dockerfile`, `start.sh`, and `policy-additions.yaml`. The in-tree authoring template also
  includes `README.md`.
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

Task 1:

- Managed startup now invokes `/usr/local/lib/nemoclaw/generate-config` for every current agent.
- OpenClaw, Hermes, LangChain Deep Agents Code, and the Pi compatibility image install a
  package-owned wrapper as a root-owned, non-symbolic-link executable with mode `0555`.
- Focused CLI and package-contract tests passed: 51 and 46 assertions.
- Focused image integration tests passed: 195 assertions.
- `npm run typecheck:cli`, `npm run checks:repository`, ShellCheck, Bash syntax checks, and
  `git diff --check` passed.

Tasks 2 and 3:

- OpenClaw, Hermes, and LangChain Deep Agents Code now use the shared `config`, `runtime`, `host`,
  `compat`, `plugin`, and `checks` directory vocabulary where each responsibility exists.
- Each package README explains its build, configuration, startup, runtime, compatibility, and
  check flow.
- OpenClaw configuration separates agent payload translation and model setup from its workflow
  entry point. An image-layout subprocess test verifies its package-relative imports.
- Core no longer selects a native configuration generator by agent ID. Remaining named package
  helpers retain explicit authorization, transaction, rollback, or runtime-specific behavior.
- Package contracts passed: 81 common assertions and 15 Hermes packed-artifact and host-boundary
  assertions. Configuration integration passed: 248 assertions. Source-checkout fallback
  regression tests passed: 78 assertions.
- All 55 configuration files validated. CLI and plugin type-checking, repository checks, reviewed
  runtime bundle verification, and `git diff --check` passed.
- A default-worker full-suite attempt was stopped after unrelated host load caused widespread
  timeout failures. Task 5 will rerun the deterministic suite with bounded workers after the
  startup split.

Task 4:

- OpenClaw `start.sh` is 967 lines and loads six package-owned shell modules plus one bounded
  automatic-pairing watcher. Its plugin runner and migration-state entry points now delegate
  blueprint planning and host-state discovery to named modules while preserving their imports.
- Hermes `start.sh` is 688 lines and loads five package-owned shell modules in execution order.
  Its native plugin keeps `register(ctx)` as the stable entry point, and its host tool broker now
  separates credential authority, clone control, and request proxying without changing core's
  receipt-verified entry point.
- Deep Agents Code keeps its launch chain and moves status, identity, and managed help output into
  `runtime/agent-status.sh`; the remaining large runtime files retain atomic security or pinned
  compatibility responsibilities documented by the package.
- Bash syntax, ShellCheck, and Python compilation passed. Focused integration tests passed:
  OpenClaw 359 assertions with 6 platform skips, Hermes startup 246 assertions, Deep Agents Code
  174 assertions with 41 Linux-only skips, OpenClaw plugin 259 assertions, Hermes host broker 31
  assertions, Hermes plugin integration 7 assertions, and Hermes Python plugin 5 assertions.

Task 5:

- The bounded broad deterministic run passed 2,450 files and 38,474 tests. The final package
  contract run passed 1,346 tests. The final registry change passed 54 focused tests, and six
  related integration files passed 205 tests with 16 documented skips.
- Apple silicon macOS listed and installed all three packages in a private temporary home and
  verified every receipt at commit `fbf3b94280`. OpenShell `0.0.106` could not establish a healthy
  Homebrew gateway for the separate live sandbox attempt, so no macOS sandbox image was created.
- Ubuntu 22.04.5 Arm64 on Brev completed the registered `sandbox-survival` OpenClaw target at commit
  `fbf3b94280` with OpenShell `0.0.106`. Install, onboarding, sandbox creation, live inference,
  persistent state, gateway restart, post-restart reconciliation, status, destroy, and cleanup
  passed in 244.82 seconds.
- The Brev run used the authenticated catalogue-listed model
  `nvidia/nvidia/nemotron-3-ultra`. It used no messaging environment value, credential, or live
  messaging-service test.
- The guardian and an independent audit found no remaining process, listener, container, service,
  package receipt, registry entry, temporary path, or credential trace. The preexisting
  `openshell-docker` network retained its pre-run semantic configuration and had no endpoint.

## Completion

Phase 11 Plan 01 is complete. Phases 1-10 remain unchanged as design history and do not establish
product support or authorize external package distribution.
