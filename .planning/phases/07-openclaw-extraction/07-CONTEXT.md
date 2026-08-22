<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 7: OpenClaw Extraction - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Move OpenClaw image assets, agent-native runtime code, the NemoClaw OpenClaw plugin, and detailed
tests into `packages/nemoclaw-openclaw` after Contract V1 freezes. Preserve OpenClaw as the default
standard runtime and keep current public image names, commands, prompts, aliases, onboarding, and
managed-image cohort behavior.

NemoClaw owns selection, normalized product intent, product transactions, policy and provider
planning, credential references, host-forward intent, registry linkage, rollback, and qualification.
OpenShell remains the only sandbox lifecycle and canonical OpenClaw process supervisor. The package
owns bounded OpenClaw-native translation and reconciliation; every helper invocation is
mutation-capable and returns only an executor claim.

</domain>

<decisions>
## Implementation Decisions

### Package boundary

- **D-01:** Use `packages/nemoclaw-openclaw/move-manifest.json` as the exact generated source/test
  move ledger. Use `packages/nemoclaw-openclaw/openclaw-plugin/move-manifest.json` for the plugin.
- **D-02:** Move the six `.cts` modules currently imported by core from `nemoclaw/src/shared` into one
  exact core-owned directory before moving the plugin. Keep plugin-only `object-record.ts` with the
  plugin.
- **D-03:** The image package and plugin each retain their distinct accepted npm identity and build
  from their package-owned location.

### Runtime control and authority

- **D-04:** OpenClaw uses the shared Phase 6 Contract V1 operations only where it implements the
  frozen semantics. Pairing, Shields translation, plugin restore, OpenClaw-native MCP, messaging,
  and other OpenClaw-only payloads remain package-internal.
- **D-05:** OpenShell alone creates, starts, stops, restarts, connects to, deletes, and recovers the
  sandbox and supervises the canonical OpenClaw process. The helper cannot call OpenShell or expose
  another lifecycle API. Retain any current in-image descendant wrapper as named compatibility debt
  until an OpenShell 0.0.106 parity test proves equivalent behavior.
- **D-06:** The current rebuild stays in `rebuild-pipeline.ts`, `rebuild-recreate-journal.ts`, and
  `sandbox-recreate-transaction.ts`. OpenClaw-native backup, doctor, restore, and post-restore
  translation may move behind the helper, but NemoClaw keeps sequencing, publication, and rollback.
- **D-07:** Consume the Phase 6 SEC-04 and CTL-05 contract. OpenClaw implements only
  `reconcile-native` and `prepare-native-state` as shared operations, treats every helper result as
  a claim, and uses current descriptor probes or named trusted core/OpenShell operations for product
  observations. Phase 7 does not redefine shared effect or evidence fields.
- **D-08:** Core keeps normalized messaging manifests, provider and credential intent, policy,
  registry persistence, host-forward intent, probe execution, and status interpretation. The
  package owns native render, reviewed plugin installation data, and data-only health declarations.
  Keep this split package-local; do not add a shared native messaging protocol during extraction.
  Tests use no live messaging service.

### Tests and release behavior

- **D-09:** Keep OpenClaw the checked-in release-set default while its exact entry status is
  `supported`. The only statuses are `supported`, `revoked`, and `superseded`; changes use an
  ordinary reviewed NemoClaw change and release. Package output cannot alter status or immutable
  qualification evidence.
- **D-10:** Move detailed native and plugin tests with their source. Keep package-contract,
  authority-boundary, release-set, and central E2E tests in core.
- **D-11:** Extend `ubuntu-repo-cloud-openclaw` in the current protected E2E registry for pilot
  parity. Do not create a generic Brev source-install lane or claim official staging Launchable
  evidence; Phase 8 owns that release gate.

### Claude's Discretion

Claude may choose package-local module names and test grouping. Claude must use the frozen V1
intersection for shared behavior, keep single-runtime behavior internal, and preserve current public
contracts.

</decisions>

<specifics>
## Specific Ideas

- Move core-shared `.cts` modules first, image inputs second, and the plugin third.
- Relocate source without redesigning OpenClaw behavior.
- Keep all process reload/restart decisions in NemoClaw and execute them through OpenShell.
- Use deterministic messaging fixtures and the existing no-messaging Ubuntu baseline target.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/phases/06-contract-v1-freeze/06-CONTEXT.md`
- `proposals/agent-runtime-packages/OPENCLAW-CANDIDATES.tsv`
- `agents/openclaw/manifest.yaml`
- `nemoclaw/package.json`
- `src/lib/onboard/managed-startup/image-runtime.ts`
- `src/lib/actions/sandbox/rebuild-pipeline.ts`
- `src/lib/actions/sandbox/rebuild-recreate-journal.ts`
- `src/lib/onboard/sandbox-recreate-transaction.ts`
- `src/lib/actions/sandbox/rebuild-backup-phase.ts`
- `src/lib/actions/sandbox/rebuild-post-restore-phase.ts`
- `src/lib/messaging/AGENTS.md`
- `test/e2e/README.md`
- `test/e2e/registry/definitions/baseline.ts`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `agents/openclaw/manifest.yaml` already declares current runtime identity and package inputs.
- `src/lib/onboard/managed-startup/image-runtime.ts` owns current generator selection and seal
  sequencing.
- `test/e2e/registry/definitions/baseline.ts` already defines the no-messaging Ubuntu OpenClaw
  baseline target.

### Established Patterns

- `src/lib/messaging` compiles normalized channel plans; the build applier contains the native
  OpenClaw rendering branch that moves behind the package boundary.
- `rebuild-backup-phase.ts` and `rebuild-post-restore-phase.ts` contain current OpenClaw-specific
  native checks within the core-owned rebuild pipeline.
- Package-contract tests validate packed artifacts; detailed native tests may move with source.

### Integration Points

- Root package scripts, `vitest.config.ts`, and exact `.github/actions/ci-*` consumers currently
  point at `nemoclaw/` and must be enumerated in the plugin move manifest before cutover.
- `src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts`,
  `src/lib/messaging/applier/build/messaging-build-applier.mts`, and
  `src/lib/actions/inference-set.ts` contain current OpenClaw-native translation.
- `.github/workflows/base-image.yaml`, `.github/workflows/managed-images.yaml`, and
  `.github/workflows/e2e.yaml` are the exact workflow owners affected by the image path move.

</code_context>

<deferred>
## Deferred Ideas

- Moving the package to another repository or resolving remote packages.
- A shared native messaging, pairing, Shields, or plugin administration protocol.
- Live messaging-service accounts.
- Official staging Brev Launchable release evidence, owned by Phase 8.

</deferred>
