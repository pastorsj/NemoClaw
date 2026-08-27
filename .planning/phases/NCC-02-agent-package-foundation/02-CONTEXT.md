<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2: Agent Package Foundation — Context

**Gathered:** 2026-08-27
**Status:** Ready for planning; implementation blocked on the product-scope gate
**Source:** Architecture discussion and Phase 1 evidence

<domain>

## Phase Boundary

Phase 2 makes reviewed, bundled agent packages installable through
`nemoclaw harness list/install` and makes the installed package identity authoritative during
onboarding and recovery. It does not move harness-native source or tests to their final package
roots. It does not introduce external package discovery, arbitrary host callbacks, a marketplace,
runtime-provider packages, serving packages, a cross-component receipt, or package deletion.

This phase must preserve the current install and sandbox experience. The visible change is that a
user explicitly installs one or more harnesses before selecting one for onboarding.

</domain>

<decisions>

## Implementation Decisions

### Product scope

- **D-01:** No production implementation begins until a recorded decision has status `Accept` and
  names the exact proposal revision, reason, repository placement, accountable maintainer, initial
  supported harnesses, trust and compatibility policy, validation environments, and rollback.
- **D-02:** The proposed standard bundled catalogue contains OpenClaw, Hermes, and LangChain Deep
  Agents Code. Pi and NemoCUA keep their existing candidate gates and do not become ordinary
  installed harnesses without a separate accepted decision.

### Public workflow

- **D-03:** The public package commands are `nemoclaw harness list` and
  `nemoclaw harness install [id]`. The shell installer delegates to the same TypeScript install
  transaction instead of maintaining another catalogue or copy path.
- **D-04:** Phase 2 discovers reviewed artifacts bundled with the current NemoClaw build only.
  Local archives, URLs, PyPI entry points, npm discovery, global module paths, and remote registries
  remain deferred.
- **D-05:** Each artifact uses one closed, language-neutral `nemoclaw-package.json` envelope and is
  installed into the gateway-independent `~/.nemoclaw/harnesses/` immutable store with an exact
  digest-addressed receipt and one atomic active pointer per harness. The store is not generalized
  to other component kinds in this phase, and `NEMOCLAW_GATEWAY_PORT` never changes its inventory.

### Transitional package boundary

- **D-06:** A focused build-time adapter assembles reviewed bundled artifacts from the current
  scattered source layout. The digest identifies the installed package selection and copied asset
  bytes; it does not claim that all statically linked NemoClaw host behavior is package-owned.
  Current Hermes and LangChain Deep Agents Code Dockerfiles copy the shared
  `nemoclaw-blueprint/` tree, so the transitional mapping may include that exact reviewed
  shared/mixed dependency and must digest and label it honestly. Phase 3 replaces this adapter with
  self-contained package authoring roots, narrows the shared dependency, and removes legacy path
  mappings.
- **D-07:** Installed packages contribute validated data plus sandbox and image-build assets. Core
  never imports a package module, invokes an install hook, or accepts a generic executable callback.
  NemoClaw keeps credentials, policy authorization, state, transactions, recovery, and OpenShell
  lifecycle authority.

### Selection and durable identity

- **D-08:** The regular package-managed onboarding path with zero installed harnesses stops with
  install guidance before session, registry, runtime, or external mutation; the writer lock may be
  created and released. One is selected automatically. Multiple interactive harnesses use the
  existing numbered picker. Multiple non-interactive harnesses select OpenClaw only when it is
  installed; otherwise `--agent` is required. An explicit uninstalled standard harness prints
  `nemoclaw harness install <id>` guidance. Explicit Pi and NemoCUA invocations retain their current
  qualification gates and do not acquire fabricated package identity.
- **D-09:** Acquire the existing onboarding writer lock through
  `beginPortableOnboardRetirementEntry`, then select and resolve the exact package while that lock is
  held but before `.run()` performs portable-retirement recovery and before
  `prepareOnboardSessionValidated` creates or mutates session state. The first durable session write
  contains package ID, package version, contract version, and content digest. It occurs before trace,
  credential, route, policy, serving, OpenShell, checkpoint, registry, or sandbox mutation, and the
  same identity is carried through recreate state, route reservation, pending policy verification,
  checkpoints, and final registry. An empty installed set may create and release only the ephemeral
  writer lock; it creates no session or registry state and makes no external runtime call.
- **D-10:** Resume uses the session-pinned digest, never a newer active pointer. A different
  `--agent` on a package-managed resume must match the recorded package or fail before mutation.
  Cancellation or failure after sandbox creation preserves the incomplete sandbox, recovery-only
  session, registry state, independent retained-sandbox recovery record, and package bytes. The
  retained record carries exact package identity but no owner-only migration audit metadata;
  same-name resume, reuse, recreation, and fresh onboarding remain blocked exactly as on current
  main. Qualified Pi and NemoCUA state continues through its existing gated authority without a
  package identity.
- **D-11:** Upgrade resolves current, resumed, and legacy package-managed sandbox identities before
  strict backup and before OpenShell changes. Direct onboarding first prepares the exact reviewed
  mapping without changing owner state, lets portable retirement recover the old durable bytes, and
  commits migration inside the recovered operation. The installer has no portable wrapper and may
  commit before backup. Both call one shared migration service under the onboarding writer lock and
  a deterministic lock order: map the legacy agent, install and verify the reviewed current object,
  re-read it, compare-and-swap the same owner's optional session, and update only that owner's
  registry row under the registry lock. A session pairs with a registry row only when its
  `sandboxName` matches the row name; every other row is an independent owner. Legacy `agent: null`
  maps once to the bundled OpenClaw package; legacy
  named standard rows map once to the corresponding bundled package. Session and registry owners
  record a strict, secret-free `legacy-current-bundle` migration provenance entry that states the
  prior agent value and migration time without claiming which historical bytes created the sandbox.
  Repeated execution converges after every partial-crash boundary. Pi and NemoCUA rows remain on
  their existing candidate path and are never migrated to invented package identity.
- **D-12:** Core or OpenShell updates never silently advance a session or existing sandbox to a new
  package. Advancement is an explicit install and affects only future fresh selection until an
  accepted upgrade operation records a new identity.

### Code and validation shape

- **D-13:** Package lifecycle code lives in `src/lib/harness/` as focused files named for their
  responsibility. Files use one or two words when sufficient; functions use up to four descriptive
  words. Do not restore the prior monolithic `package-registry.ts`.
- **D-14:** Tests remain in existing Vitest projects in Phase 2. Deterministic package, state,
  installer, and E2E-support tests precede one no-messaging macOS journey and one no-messaging
  Linux/Brev development journey. The existing typed onboarding fixture installs the exact reviewed
  package before standard package-managed targets and asserts receipt, session, and final registry
  identity equality. The central typed E2E registry remains the sole automated live-test authority.
  Manual development runs add no runner or registry, and a source-overlay Brev run is not release
  evidence.

### Claude's Discretion

- Exact private function decomposition inside the named files, provided responsibilities stay
  focused and no production file becomes a new catch-all.
- Exact bounded limits for package metadata, individual files, entry count, depth, and total bytes,
  provided the limits are constants, tested at their boundaries, and large enough for the reviewed
  bundled artifacts.
- Whether stable machine output uses the existing `--json` convention or an internal
  installer command, provided shell code does not parse human-readable output.

</decisions>

<canonical_refs>

## Canonical References

### Repository and product rules

- `AGENTS.md` — Product scope gate, test ownership, E2E authority, and contribution rules.
- `WRITING.md` — Names and user-visible text.
- `.planning/PROJECT.md` — Accepted architecture goals and exclusions.
- `.planning/REQUIREMENTS.md` — Requirement definitions and phase traceability.
- `.planning/ROADMAP.md` — Phase boundary, ordering, and completion criteria.
- `.planning/phases/01-composition-architecture/01-RESEARCH.md` — Current code map, preserved
  migration audit, effort, and package boundary evidence.

### Current implementation boundaries

- `src/lib/agent/defs.ts` — Repository-scanned agent catalogue, current `AgentDefinition` loader,
  aliases, candidate gates, defaults, and `_legacy_paths`.
- `src/lib/agent/definition-types.ts` — Typed contract that packages extend rather than replace.
- `src/lib/onboard/agent-selection.ts` — Current picker and non-interactive behavior.
- `src/lib/state/onboard-session.ts` — Durable session and writer lock.
- `src/lib/state/onboard-checkpoint-types.ts` — Recovery checkpoint schema.
- `src/lib/state/registry/types.ts` — Route, pending policy, and final sandbox state.
- `src/lib/onboard/onboard-recreate-journal.ts` — Recreate intent and fingerprint.
- `src/lib/onboard/cancel-rollback.ts` — Current incomplete-sandbox preservation behavior.
- `scripts/install.sh` — CLI preparation, pre-upgrade backup, OpenShell update, and onboarding.
- `vitest.config.ts` — Existing disjoint test projects.
- `test/e2e/README.md` — Central live-test selection and authoring rules.

</canonical_refs>

<specifics>

## Specific Workflow

The short demonstration after this phase is:

```text
nemoclaw harness list
nemoclaw onboard
nemoclaw harness install openclaw
nemoclaw harness list
nemoclaw onboard
nemoclaw harness install hermes
nemoclaw onboard
```

Expected behavior:

1. The first list shows no installed harnesses and the reviewed available catalogue.
2. The first onboarding run stops before any external mutation and prints both supported next
   actions: install now or leave and run `nemoclaw harness install`.
3. Installing OpenClaw makes it the sole selectable harness, so onboarding selects it automatically.
4. Installing Hermes adds a second installed option, so an interactive onboarding run shows the
   picker.
5. No package install runs authoring tests or arbitrary package code on the user's host.

</specifics>

<deferred>

## Deferred Ideas

- Moving production harness source and native tests into canonical package roots: Phase 3.
- Package-local test aggregation and exactly-once membership: first task of Phase 3, before any test
  move.
- External repositories, PyPI/npm distribution, signing, provenance, revocation, and remote
  discovery: Phase 8 after in-tree qualification.
- Runtime-provider, serving-runtime, host-preparer, messaging-channel, or observability packages.
- Package removal or garbage collection. Phase 2 retains immutable objects indefinitely.
- A cross-component selection receipt. The existing onboarding session owns the only new identity.

</deferred>

<scope_fence>

## Scope Fence

Reject implementation that creates a universal plugin callback, imports package code on the host,
adds a second lifecycle or E2E registry, silently updates existing sandboxes, promotes candidate
harnesses, adds external discovery, moves harness-specific tests, or claims complete runtime
provenance for the transitional bundled artifact.

</scope_fence>

---

*Phase: NCC-02-agent-package-foundation*
*Context gathered: 2026-08-27*
