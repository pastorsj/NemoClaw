<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 5: Managed Hermes Pilot - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Move only the current managed Hermes image/runtime implementation into
`packages/nemoclaw-hermes`. Portable Hermes and the host tool-gateway broker remain with their
current owners. Preserve dashboard, API port, state volume, cron, MCP, messaging, and recovery
behavior without adding general host-resource or lifecycle abstractions.

NemoClaw retains product workflow and normalized intent. OpenShell retains sandbox lifecycle,
state-mount enforcement, effective policy, provider and credential custody, inference interception,
and canonical Hermes process supervision. The package helper is limited to Hermes-native
translation and reconciliation, and every invocation returns a mutation-capable executor claim.

</domain>

<decisions>
## Implementation Decisions

- **D-01:** Use `packages/nemoclaw-hermes/move-manifest.json` as the exact generated ledger for the
  managed Hermes move. Mark every portable and broker row `keep` with its current owner.
- **D-02:** Build and test the package outside the checkout with only packed declared dependencies.
  If Phase 4 created `nemoclaw-runtime-support`, Hermes must already consume the same exact shared
  image-build payload. Do not add Hermes-only content to it.
- **D-03:** Hermes pilot requests remain package-internal until Phase 6 identifies the exact overlap
  with Deep Agents Code. Package-local handlers may render or reconcile Hermes-native configuration,
  MCP, messaging, cron, dashboard, and recovery state; they do not own sandbox or process lifecycle.
  Every helper invocation is mutation-capable and returns only an executor claim.
- **D-04:** Preserve current dashboard/API declarations through `AgentDefinition.forward_ports`,
  `dashboard`, and `health_probe`, plus `src/lib/onboard/hermes-api-port.ts`,
  `src/lib/hermes-dashboard.ts`, and `src/lib/onboard/hermes-dashboard.ts`. Preserve state-volume
  behavior in `src/lib/onboard/managed-workload/hermes-state-volume.ts`. Do not add
  `named-services.ts`, a general named-resource API, a new receipt type, or a migration API.
- **D-05:** Core keeps channel manifests, provider selection, credential placeholders, policy
  compilation, registry persistence, host-forward intent, probe execution, and status
  interpretation. The Hermes package owns only native render, dependency installation, and
  data-only health declarations. Tests are deterministic and use no live messaging account,
  endpoint, or credential.
- **D-06:** OpenShell remains the sole sandbox lifecycle and canonical Hermes process supervisor.
  Reload or restart is a NemoClaw decision executed through OpenShell, never a helper action. Keep
  a current in-image descendant wrapper as named compatibility debt until OpenShell 0.0.106 parity
  proves it removable.
- **D-07:** The active rebuild remains owned by `rebuild-pipeline.ts`,
  `rebuild-recreate-journal.ts`, and `sandbox-recreate-transaction.ts`. Hermes-specific post-restore
  work remains in `rebuild-hermes-post-restore.ts`, `rebuild-post-restore-phase.ts`, and
  `rebuild-restore-phase.ts`. Do not create another lifecycle or journal.
- **D-08:** Every helper invocation is mutation-capable, and its claim cannot commit product state.
  Current descriptor probes or named trusted core/OpenShell operations provide product
  observations. Phase 6 is the only freeze point for shared SEC-04 and CTL-05 fields.
- **D-09:** Support status is read only from the checked-in release set and is exactly `supported`,
  `revoked`, or `superseded`. Only an ordinary reviewed NemoClaw change and release may change it;
  qualification evidence remains immutable.
- **D-10:** Extend the existing protected `hermes-e2e` job. It already runs `install.sh`, managed
  Hermes onboarding, direct and `inference.local` requests, gateway restart, and cleanup. Add exact
  package, descriptor, image, release-set, and OpenShell identity assertions at those boundaries.
  Keep onboarding free of messaging channels. `ubuntu-repo-cloud-hermes` remains declared target
  metadata but is not live evidence until `cloud-hermes` has a supported onboarding fixture and
  execution coverage metadata. Do not wire a duplicate onboarding journey for pilot parity. Do not
  create a generic Brev source-install lane or claim Phase 8 staging Launchable evidence.

### Claude's Discretion

Claude may choose package-local modules and split large Hermes files when the move manifest records
the ownership. Claude may not move portable Hermes, the broker, core messaging intent, OpenShell
authority, or narrow dashboard/port/volume ownership into a new general API.

</decisions>

<specifics>
## Specific Ideas

- Prove the managed-only boundary before moving detailed tests.
- Keep `nemohermes` and public selection behavior unchanged.
- Reuse the existing `hermes-e2e` Ubuntu job and its lifecycle phases. Add package identity
  assertions instead of another onboarding lane.
- Keep native messaging payloads package-internal even though Hermes is a positive consumer.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `proposals/agent-runtime-packages/HERMES-CANDIDATES.tsv`
- `agents/hermes/manifest.yaml`
- `agents/hermes/Dockerfile`
- `agents/hermes/Dockerfile.base`
- `src/lib/agent/definition-types.ts`
- `src/lib/onboard/hermes-api-port.ts`
- `src/lib/hermes-dashboard.ts`
- `src/lib/onboard/hermes-dashboard.ts`
- `src/lib/onboard/managed-workload/hermes-state-volume.ts`
- `src/lib/actions/sandbox/rebuild-pipeline.ts`
- `src/lib/actions/sandbox/rebuild-recreate-journal.ts`
- `src/lib/onboard/sandbox-recreate-transaction.ts`
- `src/lib/actions/sandbox/rebuild-hermes-post-restore.ts`
- `src/lib/messaging/AGENTS.md`
- `test/e2e/README.md`
- `test/e2e/live/hermes-e2e.test.ts`
- `test/e2e/live/hermes-e2e-phases.ts`
- `.github/workflows/e2e.yaml`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `agents/hermes/manifest.yaml` already declares `forward_ports`, `dashboard`, and `health_probe`.
- `hermes-api-port.ts` owns host API port allocation; `hermes-dashboard.ts` owns current dashboard
  configuration; `hermes-state-volume.ts` owns the `/sandbox/.hermes` Docker volume.
- `src/lib/messaging` already compiles manifest-first channel intent and keeps secrets out of plans.
- `hermes-e2e.test.ts` runs the current protected install, onboard, inference, restart, and cleanup
  journey without a live messaging account.

### Established Patterns

- Native messaging rendering belongs in the runtime package, while provider, policy, credential, and
  registry effects remain in the core applier.
- Existing Hermes rebuild recovery runs after the core recreate and restore phases.
- Detailed runtime tests may move with source while authority and package-contract tests stay central.

### Integration Points

- `src/lib/onboard/managed-startup/image-runtime.ts` currently selects Hermes configuration setup.
- `src/lib/actions/sandbox/mcp-bridge-adapter-hermes.ts` contains Hermes-native MCP translation.
- `src/lib/messaging/applier/build/messaging-build-applier.mts` contains the current native render
  branch to replace without moving core plan compilation.
- `test/e2e/registry/definitions/baseline.ts` declares `ubuntu-repo-cloud-hermes`, but the live driver
  does not support its `cloud-hermes` onboarding profile. Its `suiteIds` are metadata and do not run
  Hermes validation suites.
- `.github/workflows/e2e.yaml` owns the executable `hermes-e2e` job and its protected runner.

</code_context>

<deferred>
## Deferred Ideas

- Portable Hermes and the host tool-gateway broker.
- A general named-service, named-resource, or state-volume framework.
- A shared native messaging protocol.
- Live messaging accounts, public ingress, and official staging Launchable evidence.

</deferred>
