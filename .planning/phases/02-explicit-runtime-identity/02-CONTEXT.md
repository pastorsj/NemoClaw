<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2: Explicit Runtime Identity - Context

**Gathered:** 2026-08-21
**Status:** Ready after Phase 1 maintainer acceptance

<domain>
## Phase Boundary

Replace the implicit null-means-OpenClaw convention in active selection, onboarding, session state, and sandbox registry state. Preserve legacy OpenClaw records through a bounded reader migration, keep the current user journey unchanged, and make unknown recorded identities stop with remediation. This phase does not introduce package descriptors, installation, controller behavior, or package-owned runtime code.

</domain>

<decisions>
## Implementation Decisions

### Identity and lookup
- **D-01:** Every active selection and trusted runtime lookup returns an explicit AgentDefinition, including OpenClaw. The canonical default identity is the string openclaw.
- **D-02:** A legacy absent or null runtime identity in a persisted onboard session or completed sandbox registry row is read as openclaw.
- **D-03:** New onboard session and completed sandbox registry writes always persist a nonempty canonical runtime identity; they never write null for OpenClaw.
- **D-04:** An explicit unknown identity from a flag, environment variable, session, or registry fails closed with source-specific remediation. It never falls back to OpenClaw or another runtime.

### Compatibility and onboarding flow
- **D-05:** Menu order, labels, prompts, default, aliases, flags, environment behavior, and sandbox behavior remain unchanged while the internal identity becomes explicit.
- **D-06:** The onboarding state machine uses one `runtime_setup` execution state for all three standard runtimes. Legacy `openclaw` and `agent_setup` state and step labels are read-only migration inputs across session machine snapshots, durable checkpoints, step maps, completion and failure pointers, and recovery receipts.
- **D-07:** The OpenClaw default, standard aliases, and display metadata remain core-owned data rather than null semantics.
- **D-08:** OpenClaw-specific policy selection and runtime-native behavior remain in their current owners during this phase; identity unification must not transfer security authority.

### Migration safety
- **D-09:** Session schema V1 has an explicit V2 reader and writer. Machine snapshot V1 has an explicit V2 reader and writer. Durable checkpoint V4 has an explicit V5 reader and writer. Legacy translation happens once at the owning normalization boundary, preserves unrelated fields, performs no write during read, and writes V2 or V5 only on the next authorized save. A future version or unknown explicit identity is a typed error and must not be converted to missing state or a new session.
- **D-10:** Phase 1 characterization tests are updated only where the intentional representation changes. They continue to protect the same observable user journey, all three resume paths, no-repeat effect history, and load/save error propagation.

### Claude's Discretion
The executor may choose the typed error class names and the internal explicit-identity helper API. Error messages must identify the source and remediation without revealing unrelated state paths or silently continuing.

</decisions>

<specifics>
## Specific Ideas

There should be one canonical identity helper rather than repeated x || openclaw expressions. Pending route-reservation registry rows that do not yet represent a sandbox may remain identity-free, but every completed or reusable sandbox row must be explicit.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Accepted decision and baseline
- .planning/phases/01-scope-and-behavior-baseline/01-04-SUMMARY.md - Required accepted product decision and validation gate.
- proposals/agent-runtime-packages/DECISION-RECORD.md - Exact accepted scope and accountable maintainer.
- .planning/phases/01-scope-and-behavior-baseline/01-02-SUMMARY.md - Characterization baseline.
- .planning/PROJECT.md - Compatibility and fail-closed constraints.
- .planning/REQUIREMENTS.md - UX-03 and STATE-01.

### Selection and runtime lookup
- src/lib/agent/defs.ts - Trusted manifest inventory, aliases, resolveAgentName, and current unknown-session fallback.
- src/lib/agent/onboard.ts - Current null OpenClaw resolveAgent behavior.
- src/lib/agent/runtime.ts - Current null OpenClaw and catch-to-null registry and session lookup.
- src/lib/onboard/agent-selection.ts - Current interactive OpenClaw-to-null conversion.

### Persisted state and machine flow
- src/lib/state/onboard-session.ts - Session schema, create, normalize, load, and save boundaries.
- src/lib/state/onboard-checkpoint-types.ts - Current durable checkpoint schema version and persisted state shape.
- src/lib/state/onboard-checkpoint.ts - Checkpoint parsing, legacy normalization, and V4/V5 write boundary.
- src/lib/state/registry/types.ts - SandboxEntry runtime identity.
- src/lib/state/registry-normalization.ts - User-writable registry normalization.
- src/lib/onboard/sandbox-registry-metadata.ts - Reused sandbox metadata writes.
- src/lib/state/onboard-step-state.ts - Current null-based post-sandbox branch.
- src/lib/onboard/machine/handlers/agent-setup.ts - Separate OpenClaw and non-OpenClaw setup execution.
- src/lib/onboard/machine/final-flow-phases.ts - Separate final-flow branch selection.
- src/lib/onboard/machine/transitions.ts - Persisted machine-state transition graph.
- src/lib/onboard/machine/initial-flow-phases.ts - Current state list and initial phase composition.
- src/lib/onboard/machine/flow-sequence.ts - Current state-to-handler and step sequence registry.
- src/lib/onboard/machine/README.md - Active component guidance for state ownership and recovery.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- loadAgent("openclaw") already returns the repository-owned OpenClaw definition.
- resolveAgentNameAlias already canonicalizes current compatibility aliases against trusted manifests.
- Session and registry normalizers already centralize user-writable state parsing and unrelated-field preservation.
- The onboarding machine has transition, sequence, runtime, and trace tests for both existing branches.

### Established Patterns
- Candidate runtimes pass requireCandidateQualificationEnabled before use.
- Persisted identities are validated against trusted manifest inventory before becoming path components.
- Machine snapshot and durable checkpoint recovery use explicit versioned normalization rather than mutating files during read.
- Focused Vitest source tests can exercise all migration cases without OpenShell or external services.

### Integration Points
- src/lib/onboard.ts stores the selected agent and chooses the final-flow branch.
- src/lib/onboard/machine/handlers/sandbox.ts records the selected identity and returns the current branch.
- Sandbox lifecycle actions call getSessionAgent or getRegisteredAgent for health, connect, logs, restart, recovery, skills, and rebuild.
- Registry metadata writes flow through getSandboxAgentRegistryFields and createSandboxRegistryMetadataHelpers.

</code_context>

<deferred>
## Deferred Ideas

- Package IDs and installed receipt identities are added in Phase 3; this phase uses current canonical runtime names.
- Removing all legacy state labels waits until the migration window closes in Phase 10.
- Runtime-native OpenClaw, Hermes, and Deep Agents Code branches move only in their extraction phases.

</deferred>

---
*Phase: 02-explicit-runtime-identity*
*Context gathered: 2026-08-21*
