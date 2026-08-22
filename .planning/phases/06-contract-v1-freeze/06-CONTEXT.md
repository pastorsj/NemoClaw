<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 6: Contract V1 Freeze - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Audit the package-local Deep Agents Code and managed Hermes pilot protocols, then freeze only their
demonstrated intersection as Contract V1. Terminal-only, gateway-only, and runtime-native payloads
stay package-internal. Phase 3 already froze controller framing and version negotiation; this phase
adds only the proven operation payloads and the shared SEC-04/CTL-05 safeguards needed by both
pilots.

This phase does not add a lifecycle API, resource journal, migration API, mutable release-status
mechanism, or generic native messaging protocol.

</domain>

<decisions>
## Implementation Decisions

- **D-01:** Every V1 operation and field must have deterministic positive use by both Deep Agents Code and
  managed Hermes. Anything with one positive consumer remains package-internal. A rejection path is
  not a second positive implementation.
- **D-02:** The Phase 3 request/response framing, nonce binding, identity binding, bounds, deadline,
  and version negotiation remain unchanged. Do not reinterpret Phase 3 as having frozen operations,
  effects, evidence, generation, or lifecycle behavior.
- **D-03:** Freeze a closed operation payload and generic error fields only for the audited
  intersection. Runtime-native configuration objects, terminal behavior, gateway behavior, MCP
  dialects, messaging render data, dashboard data, cron data, and restore formats remain internal.
- **D-04:** Phase 6 owns SEC-04. Contract V1 contains only `reconcile-native` and
  `prepare-native-state`, and both are unconditionally mutation-capable inside an existing core
  transaction. V1 has no helper read-only, observe, health, status, lifecycle, or process operation.
  Unexpected effects fail the current transaction and record bounded incident evidence; they do not
  mutate release status.
- **D-05:** Phase 6 owns CTL-05. A package execution claim and an independently produced
  NemoClaw/OpenShell observation are distinct closed records. The observation identifies producer,
  collection boundary, freshness, and limitation. A helper cannot present its own claim as an
  independent observation.
- **D-06:** The checked-in release set remains outside Contract V1 package output. Its only statuses
  are `supported`, `revoked`, and `superseded`, changed through an ordinary reviewed NemoClaw change
  and release. Qualification evidence is immutable. Contract schemas contain no package-authored
  support status, status transition, trigger, or mutable status mechanism.
- **D-07:** OpenShell is the sole lifecycle and canonical process supervisor. Contract V1 exposes no
  sandbox create/delete/recover operation, process start/stop/restart/supervise operation, command
  string, OpenShell callback, or host hook.
- **D-08:** Exercise the shared contract through current callers. Rebuild tests use
  `rebuild-pipeline.ts`, `rebuild-recreate-journal.ts`, and
  `sandbox-recreate-transaction.ts`, plus the current Deep Agents Code and Hermes callers. Do not create a
  conformance lifecycle state machine or use `onboard/managed-workload/rebuild/**` as the owner.
- **D-09:** Messaging stays core-owned through channel manifests, provider and credential intent,
  policy, registry, and host-forward planning. Hermes native render remains package-internal; Deep Agents Code
  explicitly rejects messaging. Contract V1 adds no shared native messaging operation.

### Claude's Discretion

Claude may choose exact schema filenames and generated type layout after the two-consumer matrix is
complete. Claude may remove a candidate field rather than generalize it. The closed protocol and
error vocabulary must remain language-neutral and bounded.

</decisions>

<specifics>
## Specific Ideas

- Start with an executable matrix whose rows name both positive pilot handlers and tests.
- Keep single-runtime behavior behind package-local dispatch after the freeze.
- Test hostile frames at the controller boundary and transaction failures at current production
  callers; do not model an alternate lifecycle.
- Keep release status tests in the core release-set suite, not helper conformance.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/phases/03-package-and-controller-foundation/03-CONTEXT.md`
- `packages/agent-runtime-contract/schemas/agent-runtime-package-v1.schema.json`
- `packages/agent-runtime-contract/schemas/runtime-control-v1.schema.json`
- `src/lib/agent-runtime-packages/controller-client.ts`
- `src/lib/agent-runtime-packages/controller-transport.ts`
- `src/lib/agent-runtime-packages/release-set.ts`
- `src/lib/actions/sandbox/rebuild-pipeline.ts`
- `src/lib/actions/sandbox/rebuild-recreate-journal.ts`
- `src/lib/onboard/sandbox-recreate-transaction.ts`
- `src/lib/messaging/AGENTS.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- Phase 3 provides the bounded framing, transport, and negotiation layer but intentionally contains
  no native operation body.
- The two pilot packages provide the only admissible positive evidence for V1 operation payloads.
- The current rebuild pipeline and recreate transaction already supply interruption, rollback, and
  publication boundaries.

### Established Patterns

- Core schemas reject unknown properties and command-bearing payloads.
- Package helpers translate native state; NemoClaw decides product workflow; OpenShell executes and
  supervises sandbox-local work.
- Release selection reads one static checked-in release set and has no mutable status store.

### Integration Points

- `controller-client.ts` is the sole core caller of the helper protocol.
- `rebuild-dcode-orchestrator.ts` and `rebuild-hermes-post-restore.ts` are current runtime-specific
  rebuild integration points.
- `src/lib/messaging/utils.ts` and channel manifests own supported-agent messaging gates.

</code_context>

<deferred>
## Deferred Ideas

- Any operation or field without two positive pilot consumers.
- Shared native messaging, dashboard, cron, pairing, Shields, or state-layout protocols.
- External repositories, remote package resolution, portable Hermes, and new runtimes.
- Official staging Brev Launchable evidence.

</deferred>
