<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 10: Transition Cleanup and Continuous Compatibility - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete bounded state migration, remove transition code whose compatibility window has ended, and add release gates that detect NemoClaw, OpenShell, agent-runtime, inference-provider, and messaging-render drift. Finish with evidence that core contains generic authority rather than runtime-native execution.

</domain>

<decisions>
## Implementation Decisions

### State and compatibility readers
- **D-01:** Migrate a legacy registry or snapshot to an exact package receipt only when checked-in evidence proves the identity; otherwise retain a bounded legacy record or fail with remediation instead of guessing.
- **D-02:** Package availability, sandbox deletion, snapshot retention, and durable-state deletion remain separate lifecycle decisions.
- **D-07:** Existing registry, session, checkpoint, and snapshot owners call the pure `resolveLegacyPackageReceipt` function created in Phase 8 only for exact legacy identity mapping. They retain their schema normalization and persistence boundaries. External artifact resolution is not legacy migration, and Phase 10 adds no second identity mapper.

### Core cleanup
- **D-03:** Remove a compatibility reader or transition field only after its accepted support window ends and previous-release fixtures prove that removal is permitted.
- **D-04:** Runtime names may remain only in release-set data, bounded migrations, public presentation, qualification fixtures, and explicitly reviewed compatibility shims. Runtime-native imports or executable dispatch remain prohibited in core.

### Continuous qualification
- **D-05:** Compatibility gates bind exact NemoClaw, OpenShell, package, image, controller-protocol, inference-provider, deterministic messaging-render, and suite identities before a static release-set pull request can merge and ship. The release matrix remains: full no-messaging Ubuntu lifecycle for all three packages, deterministic WSL, six native amd64/arm64 image cells, the real Apple silicon macOS OpenClaw journey on Docker Desktop or Colima, and the official staging Brev Launchable's baked default OpenClaw journey. There is no generic Brev source-install lane or all-three Brev claim.
- **D-06:** A failed fetch, verification, qualification, update, or status check blocks merge or release, leaves prior installed receipts and running workloads unchanged, and emits credential-free evidence.
- **D-08:** Immutable qualification evidence references and static `supported`, `revoked`, or `superseded` status remain separate in the checked-in release set. Only `supported` entries allow selection or package-dependent mutation. A non-supported entry never silently selects a replacement or stops, migrates, or deletes an existing sandbox; core-owned diagnosis and explicit cleanup remain available.
- **D-09:** Executor claims cannot establish their own postconditions. Compatibility and support-status review consume separately produced core or OpenShell observations with producer, method, subject, time, and limitations. Contract V1 has only mutation-capable `reconcile-native` and `prepare-native-state`; it has no read-only helper operation or before/after enforcement scheme. An unknown operation or mutation outside either declared scope fails qualification without rewriting qualification evidence or static support status.
- **D-10:** Preserve exactly three package-local descendant compatibility wrappers—OpenClaw `nemoclaw-start.sh`, Hermes `start.sh`, and Deep Agents Code `dcode-session-supervisor.py`. OpenShell owns sandbox lifecycle and admitted entrypoint/direct-exec processes. The wrappers may manage only descendants, may not call OpenShell, and remain until a later accepted decision qualifies an exact OpenShell pin for equivalent cleanup, restart, health, authenticated replacement, and final-release behavior.

### Claude's Discretion
The executor may choose the internal compatibility-report format and workflow fan-out, provided one typed planner remains the source of truth and evidence stays redacted.

</decisions>

<specifics>
## Specific Ideas

The architectural completion check should measure remaining runtime-name references and require each reference to match an approved category instead of claiming that core contains no runtime names at all. It should also enforce one explicit three-wrapper exception instead of introducing a generic supervisor abstraction.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### State and lifecycle authority
- `.planning/PROJECT.md` - Core authority, identity, compatibility, and rollback constraints.
- `.planning/REQUIREMENTS.md` - COMP requirements plus `PKG-07`, `SEC-04`, and `CTL-05`.
- `src/lib/state/registry/types.ts` - Sandbox and agent-runtime receipt model.
- `src/lib/state/registry/rebuild-authority.ts` - Exact rebuild authority.
- `src/lib/onboard/sandbox-recreate-transaction.ts`, `src/lib/actions/sandbox/rebuild-pipeline.ts`, and `src/lib/actions/sandbox/rebuild-recreate-journal.ts` - Production recreate, rebuild, authority-transfer, and rollback invariants.

### Qualification and boundary enforcement
- `tools/e2e/target-catalogue.mts` - Central E2E target source.
- `tools/e2e/workflow-plan.mts` - Shared workflow planning boundary.
- `.github/workflows/e2e.yaml` - Current central live qualification workflow.
- `.github/workflows/managed-images.yaml` - Current managed-image publication workflow.
- `scripts/checks/run.mts` - Repository check registration.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Registry persistence already validates state before writes.
- The production sandbox recreate and rebuild journal already separate preparation, replacement, readiness, restore, authority publication, retirement, and rollback.
- The typed E2E planner already centralizes target and suite selection.

### Established Patterns
- Compatibility readers are bounded and covered by previous-release fixtures.
- Repository checks enforce structural trust boundaries without using user-visible runtime output.
- Release workflows retain exact artifact evidence and redacted diagnostics.

### Integration Points
- The pure legacy receipt resolver feeds existing state owners; static support status gates selection and package-dependent mutation.
- Boundary checks run through `npm run checks:repository`.
- Compatibility results gate ordinary reviewed release-set changes; rollback is a reviewed revert or follow-up release.

</code_context>

<deferred>
## Deferred Ideas

- New agent runtimes and advanced Hermes authorities require new accepted phases.
- Live messaging-service qualification remains deferred.
- Removing compatibility behavior before its accepted window ends is prohibited.

</deferred>

---
*Phase: 10-transition-cleanup-and-continuous-compatibility*
*Context gathered: 2026-08-21*
