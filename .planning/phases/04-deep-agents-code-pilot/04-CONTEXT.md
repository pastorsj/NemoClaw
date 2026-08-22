<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4: Deep Agents Code Pilot - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Move the managed LangChain Deep Agents Code implementation into
`packages/nemoclaw-deepagents-code` and prove that package-native configuration and reconciliation can
run through the Phase 3 controller framing. This phase preserves the current terminal behavior and
the current NemoClaw/OpenShell authority split.

NemoClaw still owns selection, normalized product intent, rebuild sequencing, registry publication,
rollback decisions, and the checked-in standard release set. OpenShell remains the only sandbox
lifecycle and canonical process supervisor. Deep Agents Code continues to reject messaging before
policy, provider, credential, registry, or rebuild mutation.

</domain>

<decisions>
## Implementation Decisions

- **D-01:** Use `packages/nemoclaw-deepagents-code/move-manifest.json` as the exact, generated move
  ledger. Every moved source and test has one source, destination, current consumer, and disposition.
  Cut over all listed consumers before deleting the old source root.
- **D-02:** The package builds and tests from a copied directory with only its declared packed
  dependencies. It must not read repository-root source.
- **D-03:** Create `packages/nemoclaw-runtime-support` only after an inventory proves the exact set
  of current image-build inputs copied by both the Deep Agents Code and managed Hermes Dockerfiles.
  Both consumers adopt it in this phase, and it contains only those shared checked-in inputs. It is
  not a lifecycle library, plugin API, host-ingestion mechanism, or place for runtime-specific code.
- **D-04:** Pilot native requests remain package-internal. They may translate normalized inference,
  configuration, MCP, approval, and native state reconciliation. Every helper invocation is
  mutation-capable and returns only an executor claim. They do not define Contract V1 operations;
  Phase 6 may freeze only fields and operations also demonstrated by managed Hermes.
- **D-05:** OpenShell alone creates, starts, stops, restarts, connects to, deletes, and recovers the
  sandbox and supervises the canonical `dcode` process. The package helper performs bounded native
  translation and reconciliation only and never calls OpenShell. Retain any current descendant
  wrapper as named compatibility debt until an OpenShell 0.0.106 parity test proves equivalent behavior.
- **D-06:** Keep the production rebuild workflow in
  `src/lib/actions/sandbox/rebuild-pipeline.ts`, its recreate journal in
  `src/lib/actions/sandbox/rebuild-recreate-journal.ts`, and transaction protection in
  `src/lib/onboard/sandbox-recreate-transaction.ts`. Deep Agents Code-specific callers remain
  `rebuild-dcode-orchestrator.ts`, `rebuild-dcode-preflight.ts`, `rebuild-dcode-target.ts`, and
  `prepared-dcode-rebuild.ts`. Do not add another lifecycle, journal, or migration API.
- **D-07:** Treat every helper request as mutation-capable and keep its claim distinct from product
  observations. Health, readiness, activity, process, service, and state observations use current
  descriptor-declared probes or named trusted core/OpenShell operations without package code. Phase
  6, not this phase, owns the shared SEC-04 effect and CTL-05 evidence contract.
- **D-08:** Release support comes only from the checked-in core release set. Its only statuses are
  `supported`, `revoked`, and `superseded`; a status change is an ordinary reviewed NemoClaw change
  and release. Package output and pilot execution cannot change status or rewrite immutable
  qualification evidence.
- **D-09:** Extend the existing protected `ubuntu-repo-cloud-langchain-deepagents-code` target in
  `test/e2e/registry/definitions/baseline.ts`. Do not create a generic Brev source-install lane.
  Phase 8 alone owns official staging Brev Launchable release evidence.

### Claude's Discretion

Claude may choose package-local module names and test grouping. Claude must preserve the current
image identity, command behavior, dependency pins, OpenShell ownership, and pre-mutation messaging
rejection.

</decisions>

<specifics>
## Specific Ideas

- Relocate source before redesigning native behavior.
- Derive the move manifest from the Phase 1 audited candidate ledger and a fresh consumer scan.
- Keep the Deep Agents Code live target no-messaging and reuse its current invalid-credential rebuild coverage.
- Treat helper output as untrusted package evidence; core decisions require current trusted facts.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `proposals/agent-runtime-packages/TERMINAL-CANDIDATES.tsv`
- `agents/langchain-deepagents-code/Dockerfile`
- `agents/langchain-deepagents-code/Dockerfile.base`
- `agents/langchain-deepagents-code/managed-dcode-runtime.py`
- `src/lib/actions/sandbox/rebuild-pipeline.ts`
- `src/lib/actions/sandbox/rebuild-recreate-journal.ts`
- `src/lib/onboard/sandbox-recreate-transaction.ts`
- `src/lib/actions/sandbox/rebuild-dcode-orchestrator.ts`
- `src/lib/actions/sandbox/rebuild-dcode-preflight.ts`
- `src/lib/actions/sandbox/rebuild-dcode-target.ts`
- `src/lib/onboard/prepared-dcode-rebuild.ts`
- `src/lib/messaging/AGENTS.md`
- `test/e2e/README.md`
- `test/e2e/registry/definitions/baseline.ts`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/lib/onboard/managed-startup/image-runtime.ts` is the current managed-image native setup
  dispatch point.
- `src/lib/actions/sandbox/dcode-activity-probe.ts` is a current core probe, while
  `src/lib/actions/sandbox/mcp-bridge-adapter-deepagents.ts` contains Deep Agents Code-native MCP translation.
- `test/e2e/registry/definitions/baseline.ts` already defines the protected Ubuntu Deep Agents Code target.

### Established Patterns

- The active rebuild path opens `rebuild-recreate-journal.ts`, which delegates transaction state to
  `sandbox-recreate-transaction.ts`.
- Channel manifests are the source of truth for messaging availability. Deep Agents Code has no supported
  channel and must fail before mutation.
- Root package-contract tests may validate packed artifacts without importing package source.

### Integration Points

- `src/lib/agent/defs.ts` and `src/lib/agent/base-image.ts` currently resolve the runtime and image
  build context.
- `.github/workflows/base-image.yaml`, `.github/workflows/managed-images.yaml`, and
  `.github/workflows/e2e.yaml` are the exact current workflow consumers to audit during cutover.
- `test/e2e/live/registry-targets.test.ts` executes the typed target selected from the registry.

</code_context>

<deferred>
## Deferred Ideas

- Deep Agents Code messaging or an inbound bridge.
- A shared native operation contract before Phase 6 has two-consumer evidence.
- External package publication and remote installation.
- Official staging Brev Launchable release evidence.

</deferred>
