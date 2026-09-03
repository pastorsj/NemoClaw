<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Research: Agent Runtime Contract

**Researched:** 2026-09-03
**Baseline:** Current `agent-runtime-composition-architecture` working tree after Phase 3 package
and Fabric implementation

## Finding

The package shape is established, but core is not agent-runtime agnostic yet. The four packages own
their images, startup, most native configuration, compatibility code, Fabric integration, and a
large deterministic test body. Core still contains native protocol knowledge and treats OpenClaw
as an implicit default. The next phase should finish that boundary; it should not redesign package
installation, OpenShell lifecycle, platform readiness, runtime providers, or serving.

`src/lib/agent-runtime/host-module.ts` proves the required security mechanism for one MCP
operation: fixed path, exact receipt, tree revalidation, byte bound, valid UTF-8, import-free VM,
disabled code generation, frozen input, and validated output. Extract that mechanism and migrate
MCP first. Grow the closed operation map only when a later package slice wires a real seam and its
test. Do not generalize it to callbacks or predeclare unused request types.

## Existing Foundation

- `src/lib/agent-runtime/` owns validated manifests, immutable package identity, installation,
  lifecycle primitives, and state primitives.
- `packages/nemoclaw-{hermes,openclaw,langchain-deepagents-code,pi}` use the same root package
  contract and responsibility directories.
- Package tests already use `config`, `host`, `runtime`, `compat`, `image`, `fabric`, and
  `integration` lanes.
- The package overlay rehearsal supports isolated package-only and exact-core composed tests.
- The typed E2E registry and workflow planner already provide the sole live-test authority.
- The generic Fabric runner selects package data without an agent-name branch.

These pieces should remain. The migration needs one typed adapter contract and loader, not another
package store, lifecycle, state machine, or test runner.

## Remaining Core Knowledge

### Implicit OpenClaw identity

`null` still means OpenClaw in onboarding, policy, messaging, upgrade, session RPC, passthrough,
and finalization paths. This makes every generic caller preserve an undocumented default. New
package-managed state must always carry an explicit definition and identity. Legacy translation
belongs in one migration file.

Representative sources include:

- `src/lib/onboard/sandbox-agent.ts`
- `src/lib/onboard/machine/handlers/finalization.ts`
- `src/lib/onboard/portable-retirement-authority.ts`
- `src/lib/actions/sandbox/sessions/gateway-rpc.ts`
- `src/lib/messaging/channels/policy.ts`
- `src/lib/policy/index.ts`

### Native configuration and managed startup

Core still selects native environment, shared-state behavior, configuration generation, image
runtime behavior, inference projection, protected-file handling, and recovery by agent ID. Fixed
configuration commands and typed plans must replace those switches.

Representative sources include:

- `src/lib/onboard/managed-startup/agent-environment.ts`
- `src/lib/onboard/managed-startup/shared-state-transaction.ts`
- `src/lib/onboard/managed-startup/image-runtime.ts`
- `src/lib/state/state-file-restore.ts`
- `src/lib/state/openclaw-config-restore-input.ts`

### Native CLI, pairing, gateway, and dashboard protocols

Core knows OpenClaw selector grammar, gateway RPC, device approval, dashboard tokens, Hermes
gateway behavior, and agent-specific readiness. Static ports and health checks belong in the
manifest. Native grammar and pairing belong in fixed package operations. Core retains execution,
timeouts, authentication, state, and redaction.

### MCP and messaging projection

MCP has a partial package boundary: the fixed package helper builds registration and removal
commands, while core still contains Hermes and OpenClaw translation branches. Messaging correctly
keeps the common channel manifest, credentials, and policy in core, but native projection and
startup behavior must move to each package. Messaging service live tests remain outside the
no-credential qualification scope.

### Optional runtime behavior

OpenClaw and Hermes still leak native assumptions into sessions, subagents, skills, cron, voice,
diagnostics, backup, and restore paths. Core should retain generic requested state and protected
transactions. A package owns native paths, grammar, merge rules, and process behavior. If only one
package consumes a feature, keep it package-owned rather than inventing a universal core concept.

### Assets and source-shape tests

Package-specific policies, model setup, scripts, fixtures, and E2E assertions still exist outside
package roots. Move the source and the detailed tests together. Core can retain data-only release
composition and generic black-box assertions, but not a duplicate native implementation.

## Quantitative Lower Bound

The focused OpenClaw audit found at least 41 dedicated production or artifact files outside
`packages/nemoclaw-openclaw`, totaling 6,425 lines. It also found 27 named source test files
(9,749 lines), 56 named E2E/support/manifest/tool files (13,522 lines), and seven other named root
test/support files (1,833 lines). That is roughly 90 obvious OpenClaw-specific test/support files
and 25,000 lines still outside the package. Mixed files add roughly 100 more production seams.

This is a lower bound, not a promise that every referenced line moves. Generic transaction and
security code stays in core after native branches are removed. Hermes, DCode, and Pi need the same
semantic classification before each move; raw string matches are not a reliable move count.

## Migration Sequence

1. Record the accepted host-helper trust boundary and freeze a source inventory.
2. Add the shared adapter boundary and one receipt-bound loader; define only MCP as the first
   concrete operation.
3. Make `AgentDefinition` and exact package identity mandatory for package-managed calls; isolate
   legacy null-to-OpenClaw translation.
4. Move Hermes native config, gateway, MCP, pairing, messaging, state, broker, and tests behind the
   contract.
5. Move OpenClaw native config, CLI, pairing, gateway, messaging, state, optional features, assets,
   and tests behind the same contract.
6. Close DCode and Pi gaps without adding operations they do not need.
7. Replace remaining ID switches with manifest data, typed operation presence, or generic state
   primitives. Delete duplicate core implementations and temporary bundled-source mappings.
8. Enforce source and test ownership gates, then run deterministic, composed, Mac, and Brev edge
   qualification.

Each package migration lands separately. A package cannot use its old core branch after its move;
otherwise tests can pass against the wrong implementation.

## Main Risks

| Risk | Control |
|---|---|
| A generic hook becomes arbitrary host execution. | Fixed paths, fixed exports, closed types, VM limits, receipt revalidation, and no manifest-selected code. |
| Native behavior moves but core silently keeps a fallback. | Delete the old implementation in the same package slice and add a source gate. |
| Package tests pass only inside the monorepo. | Package-only copy has no core source; composed lane names one exact core revision. |
| Contract work duplicates lifecycle or rollback. | Package returns bounded plans; core remains the only executor and transaction owner. |
| Live testing becomes a Cartesian matrix. | Contract tests cover semantics; live tests cover changed external edges only. |
| Backward compatibility keeps permanent OpenClaw knowledge everywhere. | One named migration owns the old null representation; all ordinary paths require explicit identity. |
| A package update forces a core release. | Package-owned native tests and stable typed outputs absorb upstream change; core changes only when the semantic operation changes. |

## Estimated Effort

The five independently reviewable slices total approximately 7–12 engineer-weeks. This is an
engineering range, not a calendar or single-execution promise:

| Slice | Estimate | Main uncertainty |
|---|---:|---|
| Contract, loader, explicit identity, and source gates | 1–2 weeks | Legacy null state and receipt-bound host trust |
| Hermes extraction | 2–3 weeks | Gateway, SQLite/cron state, broker, and messaging projection |
| OpenClaw extraction | 3–5 weeks | Pairing, gateway, messaging, optional features, and large test surface |
| DCode and Pi closure | 0.5–1 week | Confirming that no unnecessary operation is introduced |
| Deterministic and live edge qualification | 1–2 weeks | Docker/OpenShell environment reliability and image build time |

Hermes and OpenClaw package-native work can partly overlap after the contract lands. Identity,
fallback removal, and final core gates remain sequential.

## Stop Conditions

Stop and revise the contract if a proposed operation gives package code OpenShell clients,
filesystem-wide access, credential values, transaction objects, rollback control, network access,
or arbitrary lifecycle registration. Stop a package migration if the package-only test lane still
needs `src/lib` or a root native fixture.
