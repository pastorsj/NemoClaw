---
phase: 02
slug: agent-package-foundation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-27
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|---|---|
| **Framework** | Disjoint Vitest projects, repository checks, docs build, installer process tests, and bounded manual development journeys |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | The focused non-watch command in the active plan task |
| **Full deterministic command** | `npm run test:projects:check && npm run typecheck:cli && npm run checks:repository && npm run docs && npm test && npm run test:e2e-phases:check` |
| **Compiled contract command** | `npm run test:package` |
| **E2E support command** | `npx vitest run --project e2e-support` |
| **Expected focused feedback** | Less than 60 seconds for one focused source test on the development host |

## Sampling Rate

- **After every task:** Run the task's focused non-watch command once after the final task edit.
- **After every wave:** Run every affected Vitest project and CLI type checking.
- **After docs or compiled-surface changes:** Run `npm run docs` and `npm run test:package`.
- **After installer changes:** Run the named integration and installer-integration process tests.
- **Before live development work:** Run the full deterministic command and E2E metadata checks.
- **After deterministic sign-off:** Run the isolated no-messaging Mac and operator Brev journeys.

## Plan Verification Map

| Plan | Wave | Primary requirement | Secure behavior | Test type | Automated command or gate |
|---:|---:|---|---|---|---|
| 02-01 | 1 | GOV-01 | Exact committed proposal has an accepted product decision before production work | authority gate | Verify the accepted record, proposal commit, and clean proposal paths exactly as Plan 01 specifies |
| 02-02 | 2 | PKG-01, PKG-02, PKG-04 | Closed data envelope and hostile-tree boundary execute no package code | unit | `npx vitest run --project cli src/lib/harness/package-manifest.test.ts src/lib/harness/package-tree.test.ts` |
| 02-03 | 3 | PKG-03, PKG-03A | Global immutable store publishes object, receipt, and pointer safely and is gateway-port invariant | unit | `npx vitest run --project cli src/lib/state/state-root.test.ts src/lib/harness/package-receipt.test.ts src/lib/harness/package-store.test.ts src/lib/harness/package-install.test.ts` |
| 02-04 | 4 | PKG-04A, PKG-05 | Only reviewed bundles and declared transitional shared inputs enter built and packed artifacts | unit/contract | `npx vitest run --project cli src/lib/harness/bundled-source.test.ts src/lib/harness/package-catalog.test.ts && npm run test:package` |
| 02-05 | 5 | UX-02 | Installed and available inventory remains separate and list output is bounded | unit | `npx vitest run --project cli src/lib/harness/package-list.test.ts src/commands/harness/list.test.ts` |
| 02-06 | 6 | UX-02, TEST-03 | Public install uses one transaction; docs, metadata, and compiled dispatch agree | unit/docs/contract | `npx vitest run --project cli src/lib/harness/package-prompt.test.ts src/commands/harness/install.test.ts && npm run docs && npm run test:package` |
| 02-07 | 6 | UX-01 | `agents list` remains compatible and shows installed standard packages only | unit | `npx vitest run --project cli src/lib/agent/list-command.test.ts src/commands/agents/list.test.ts` |
| 02-08 | 4 | COMP-04, COMP-04A | Session owns exact identity and four-field migration audit data; checkpoint v5 carries identity only | unit | `npx vitest run --project cli src/lib/harness/package-identity.test.ts src/lib/state/onboard-session.test.ts src/lib/state/onboard-session-normalization.test.ts src/lib/state/onboard-checkpoint.test.ts src/lib/state/onboard-checkpoint-migrate.test.ts src/lib/onboard/checkpoint-resume-guard.test.ts` |
| 02-09 | 5 | COMP-04, COMP-04A | Registry, route, and pending policy schemas preserve valid authority and reject malformed present data | unit/security | `npx vitest run --project cli src/lib/state/registry-normalization.test.ts src/lib/state/registry-route-reservation.test.ts src/lib/state/registry-route-reservation-security.test.ts` |
| 02-10 | 6 | AGENT-01 | Repository and package definitions use one explicit-root builder while OpenClaw keeps its null sentinel | unit | `npx vitest run --project cli src/lib/agent/definition-loader.test.ts src/lib/agent/defs.test.ts src/lib/onboard/sandbox-agent.test.ts` |
| 02-11 | 7 | AGENT-01, AGENT-04 | Package-derived image provenance and build context use the receipt-verified root | unit | `npx vitest run --project cli src/lib/agent/base-image.test.ts src/lib/onboard/sandbox-create/orchestration.test.ts` |
| 02-12 | 7 | UX-03 | Zero, one, many, non-interactive, and candidate selection use private explicit roots | unit | `npx vitest run --project cli src/lib/onboard/package-selection.test.ts src/lib/onboard/agent-selection.test.ts src/lib/actions/sandbox/pi-candidate-lifecycle.test.ts` |
| 02-13 | 8 | COMP-04, COMP-04A | Read-only authority proof precedes portable recovery; fresh save or owner-scoped legacy commit follows it beneath the same writer lock | unit/order | `npx vitest run --project cli src/lib/state/harness-migration.test.ts src/lib/onboard/session-bootstrap.test.ts src/lib/onboard/package-ordering.test.ts` |
| 02-14 | 9 | UX-03, COMP-04 | Resume uses the recorded digest and refuses conflicts before every current mutation backstop | unit/order | `npx vitest run --project cli src/lib/onboard/session-bootstrap.test.ts src/lib/onboard/runtime-control-flow.test.ts src/lib/onboard/portable-resume-lock-boundary.test.ts src/lib/onboard/agent-resume-state.test.ts src/lib/onboard/package-resume.test.ts src/lib/onboard/agent-selection.test.ts src/lib/actions/sandbox/pi-candidate-lifecycle.test.ts` |
| 02-15 | 10 | COMP-03, COMP-04A | Route, create-only reservation, pending policy, provider, and create boundaries require matching package and policy authority | unit/security | `npx vitest run --project cli src/lib/state/registry-route-reservation.test.ts src/lib/state/registry-create-only-reservation.test.ts src/lib/onboard/machine/handlers/provider-inference.test.ts src/lib/onboard/sandbox-create/orchestration.test.ts src/lib/onboard/sandbox-create/policy-creation-receipt.test.ts` |
| 02-16 | 11 | COMP-04A | Recreate and checkpoint recovery preserve the original identity through strict v5 persistence | unit/recovery | `npx vitest run --project cli src/lib/onboard/sandbox-recreate-transaction.test.ts src/lib/onboard/onboard-recreate-journal.test.ts src/lib/onboard/checkpoint-record.test.ts src/lib/onboard/checkpoint-replay.test.ts src/lib/state/onboard-checkpoint.test.ts` |
| 02-17 | 12 | COMP-04B | Final registration and every public post-create cancellation/failure path preserve exact recovery-only package evidence while same-name onboarding stays blocked | unit/integration/recovery | Run the focused CLI command and `npx vitest run --project integration test/onboarding/onboard-fresh-create-identity.test.ts` from Plan 17 |
| 02-18 | 13 | UX-01, COMP-04, COMP-04B | Installer reconciliation converges each independent legacy owner and retained record before strict backup or OpenShell mutation without cross-owner adoption | unit/integration/process | Run the focused CLI, integration, and installer-integration commands in Plan 18 |
| 02-19 | 14 | COMP-04 | Backup publishes exact manifest identity; restore and clone validate pinned source and target authority before destructive work | unit/lifecycle | Run the focused maintenance, manifest, backup-authority, restore-authority, and snapshot lifecycle commands in Plan 19 |
| 02-20 | 15 | COMP-04 | Prepared recovery verifies authority twice; explicit effective-agent identity preserves OpenClaw credential-family behavior | unit/recovery | Run the focused prepared-recovery, resume-config, target-image, and target-runtime commands in Plan 20 |
| 02-21 | 16 | COMP-04 | Every downstream rebuild consumer uses one preflight-pinned definition while preserving current messaging-provider authority | unit/recovery | Run the focused flow-helper, post-restore, messaging, GPU, and DCode commands in Plan 21 |
| 02-22 | 17 | TEST-04 | Sanitized host PATH works, and existing typed base targets install through the public CLI and assert receipt/session/registry equality | e2e-support | `npx vitest run --project e2e-support test/e2e/support/e2e-fixture-context.test.ts test/e2e/support/harness-package.test.ts test/e2e/support/e2e-phase-onboarding.test.ts test/e2e/support/e2e-phase-state-validation.test.ts && npm run test:e2e-phases:check` |
| 02-23 | 18 | TEST-03, TEST-06, TEST-07 | Full deterministic checks precede bounded no-messaging Mac and Brev evidence | aggregate/manual | Run the exact deterministic and manual commands in Plan 23 and record their evidence without retries or overclaiming |

## Wave 0 Requirements

Existing Vitest, installer-integration, package-contract, E2E-support, type-check, docs, and
repository-check infrastructure covers this phase. Each implementation task creates or extends its
named test before production behavior is complete. Phase 2 moves no harness-native test; Phase 3
owns package-local test configuration, exactly-once aggregate membership, and physical test moves.

## Manual-Only Verifications

| Behavior | Requirement | Why manual | Test instructions |
|---|---|---|---|
| Accepted product decision | GOV-01 | Only an accountable maintainer can accept a supported product surface | Verify `Accept`, accountable owner, exact committed proposal revision, lifecycle, trust, compatibility, validation, and rollback fields. |
| macOS no-messaging journey | TEST-06 | Requires the operator-designated Mac, Docker/OpenShell login, and isolated state | Follow Plan 23 Task 2; do not use a broad uninstall or cleanup script; label the result manual development evidence, not release evidence. |
| Linux/Brev no-messaging journey | TEST-04, TEST-06 | Requires the operator-provided instance, OpenShell/Docker, and approved inference access | Follow Plan 23 Task 3; use exact names and redacted evidence; label the result operator-supplied manual development evidence, not staging Launchable or release evidence. |

## Validation Sign-Off

- [ ] Every task has a focused automated command or explicit human authority gate.
- [ ] No three implementation tasks occur without automated feedback.
- [ ] Package or identity failure proves the next external mutation was not called.
- [ ] Source tests use private explicit bundle/store roots, not real HOME or `dist/harnesses`.
- [ ] New diagnostics are redacted and assert stable outcomes rather than terminal decoration.
- [ ] `npm run test:projects:check` reports disjoint, exhaustive membership.
- [ ] The existing typed E2E registry and planner remain the sole central live authority.
- [ ] No credentialed messaging test, watch flag, unbounded retry, or broad workflow rerun is added.
- [ ] Package-managed claims exclude qualified Pi and NemoCUA candidate authority.
- [ ] Development Mac/Brev evidence is never represented as authenticated release evidence.
- [ ] `nyquist_compliant: true` remains accurate after execution edits.

**Approval:** Pending Phase 2 product decision and execution
