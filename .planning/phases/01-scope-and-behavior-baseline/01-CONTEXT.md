<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 1: Scope and Behavior Baseline - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning; supported implementation remains blocked until Plan 01-04 records maintainer acceptance.

<domain>
## Phase Boundary

Turn the existing agent runtime package proposal into an accept-or-revise product decision, freeze the current user-visible and persisted-state behavior, and classify every audited extraction candidate. This phase produces decision evidence and characterization tests only. It does not add package discovery, change onboarding, move runtime code, or create a supported plugin surface.

</domain>

<decisions>
## Proposed Implementation Choices

### Product and placement
- **D-01:** Characterization and inventory evidence may be prepared before acceptance because they change no product behavior. Before Phase 2 or package implementation, a maintainer must record Accept, reason and placement, an accountable maintainer, and a validation plan; a draft discussion or passing tests do not pass the gate.
- **D-02:** The first implementation places self-contained agent runtime package roots under packages/ in the NemoClaw repository. Moving unchanged package units to independent repositories is a later gated phase.
- **D-03:** The public installation surface is nemoclaw harness install. Existing nemoclaw agents list remains available during migration and later delegates to the package catalogue.

### Compatibility and availability
- **D-04:** Preserve the current onboarding choices, order, labels, prompts, default, command flags, environment variable, compatibility launchers, and resulting sandbox behavior. OpenClaw remains the default.
- **D-05:** The three standard packages are available to selection after a normal NemoClaw install through exact support-catalog entries, but normal installation does not preload every platform image. Contract compatibility or local registration alone does not confer support or normal selectability.
- **D-06:** NemoClaw core owns product workflow, package selection, generic plan compilation, logical provider selection, required-policy compilation, named host routes and ports, product-state linkage, rollback decisions, trusted product probes, and central qualification. OpenShell owns sandbox lifecycle and durable sandbox state, compute dispatch, effective policy, provider and credential custody and rewrite, inference interception, and every admitted image entrypoint or direct sandbox execution. Under OpenShell `0.0.106`, the three exact current descendant wrappers move unchanged as package-local compatibility debt; they remain outside `runtime-control`. Package helper behavior is limited to bounded mutation-capable native reconciliation inside the sandbox image.

### Audit and validation
- **D-07:** Every path in OPENCLAW-CANDIDATES.tsv, HERMES-CANDIDATES.tsv, and TERMINAL-CANDIDATES.tsv receives exactly one move, split, keep, or delete disposition, an owner, a target, and validation evidence.
- **D-08:** Preserve messaging behavior with deterministic tests, but do not require live Telegram, Discord, WhatsApp, or other messaging accounts in this migration.
- **D-09:** The accepted validation plan names deterministic tests, package conformance, lifecycle E2E, Ubuntu, macOS, WSL, linux/amd64, linux/arm64, and Brev evidence, with exact entry and release gates.
- **D-10:** The accepted ownership record names accountable owners for the shared contract, each standard package, security response, releases, compatibility, state migration, artifact retention, and E2E qualification.

### Sequencing and exclusions
- **D-11:** Prove and qualify the complete in-tree packages before any repository split. External artifact transports and independent repositories must not change the package contract.
- **D-12:** Pi, NemoCUA, portable Hermes, the Hermes tool gateway broker, package activation or removal, registry search, and live messaging qualification remain deferred.
- **D-13:** The decision packet contains a line-by-line reconciliation with Discussion 9909 and its two reviewer comments. It distinguishes the repository-member review from the second review, whose author association GitHub reports as `NONE`. It records aligned choices, requested divergences, unresolved request-changes, and the separate decision needed to convert first-party source to external integration source. The requested `nemoclaw harness install` spelling is public compatibility vocabulary only; new internal contracts use `agent runtime`, and `plugin` remains reserved for runtime-loaded plugins.
- **D-14:** The proposal pins the exact NemoClaw-supported OpenShell release and capability cohort, proposes a driver and platform matrix, and inventories each `RuntimeProviderBundle` facet as retain, converge, or remove with its consumer, one-client-boundary route, parity evidence, E2E gate, and removal condition. The same proposal revision records exact paths, symbols, owners, dispositions, and removal gates for runtime-name execution branches, cross-boundary imports, and direct OpenShell call sites. Phase 3 may add syntax fingerprints when it implements the repository check.

### Claude's Discretion
The executor may choose the table layout and test fixture organization for the baseline documents. Characterization assertions must describe observable behavior and durable state, not incidental prompt spacing, spinner frames, or timing output.

</decisions>

<specifics>
## Specific Ideas

The decision packet should be readable by an engineering lead without the inventory scripts open. It should distinguish the literal compatibility command namespace named harness from the project term agent runtime. It must also make the RFC review requests visible: unique package identities and workspaces, deterministic clean packaging and shipped contents, executor-claimed versus independently observed evidence, per-operation effect enforcement, and reviewed release-set support status separate from immutable qualification evidence. Baseline tests should intentionally preserve legacy null-means-OpenClaw records until Phase 2 migrates them.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Repository policy and accepted scope
- AGENTS.md - Product scope gate, test lanes, security boundary, and repository vocabulary.
- CONTRIBUTING.md - Contribution and validation requirements.
- WRITING.md - Required terminology and direct-writing rules.
- .planning/PROJECT.md - Core value and proposed trust boundary, compatibility, and migration sequence.
- .planning/REQUIREMENTS.md - Phase 1 governance, compatibility, and baseline requirements.
- .planning/ROADMAP.md - Phase order and success criteria.

### Proposal and inventory
- proposals/agent-runtime-packages/README.md - Current high-level proposal, including stale command and placement language to reconcile.
- proposals/agent-runtime-packages/TECHNICAL-PLAN.md - Detailed package, controller, lifecycle, state, and security design.
- proposals/agent-runtime-packages/RFC-RECONCILIATION.md - Planned comparison of the accepted design with Discussion 9909 and its review comments.
- proposals/agent-runtime-packages/RUNTIME-INVENTORY.md - Audited integration surfaces and measured scope.
- proposals/agent-runtime-packages/OPENCLAW-CANDIDATES.tsv - OpenClaw extraction candidates.
- proposals/agent-runtime-packages/HERMES-CANDIDATES.tsv - Hermes extraction candidates, including out-of-scope portable and broker rows.
- proposals/agent-runtime-packages/TERMINAL-CANDIDATES.tsv - Terminal-agent extraction candidates.
- proposals/agent-runtime-packages/ARCHITECTURE-BASELINE.json - Planned exact baseline for runtime dispatch, package imports, direct OpenShell calls, and RuntimeProviderBundle consumers.

### Current behavior
- src/lib/onboard/agent-selection.ts - Current menu order, interactive selection, and null OpenClaw representation.
- src/lib/agent/onboard.ts - Current flag, environment, session resolution, candidate gate, and policy selection.
- src/lib/agent/runtime.ts - Current registry and session runtime lookup and silent null behavior.
- src/lib/state/onboard-session.ts - Persisted onboarding identity and step state.
- src/lib/state/registry/types.ts - Persisted sandbox identity and runtime-specific fields.
- src/lib/agent/list-command.ts - Current list behavior.
- test/nemohermes-alias.test.ts - Hermes compatibility launcher contract.
- test/nemo-deepagents-alias.test.ts - Deep Agents Code compatibility launcher contract.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/lib/agent/defs.ts already owns trusted manifest discovery, canonical names, choices, and aliases.
- src/lib/onboard/agent-selection.test.ts and src/lib/agent/list-command.test.ts provide focused seams for menu and listing characterization.
- src/lib/onboard/agent-resume-state.test.ts, src/lib/state/onboard-session-normalization.test.ts, and src/lib/state/registry-normalization.test.ts exercise persisted-state behavior without external services.
- The typed E2E registry and workflow planner under test/e2e/ and tools/e2e/ already separate deterministic support tests from opt-in live runs.

### Established Patterns
- Source tests are co-located under src/ and run in the cli Vitest project.
- Root integration tests under test/ preserve launcher and compiled-command behavior.
- Security-sensitive state normalization fails or preserves invalid input explicitly rather than silently rewriting unrelated fields.
- Live messaging services are already separate behavior dimensions, not prerequisites for the central no-messaging lifecycle.

### Integration Points
- Agent selection flows through src/lib/onboard/agent-selection.ts into src/lib/onboard.ts.
- Compatibility inputs flow through --agent, NEMOCLAW_AGENT, nemohermes, and nemo-deepagents.
- Runtime identity is persisted in src/lib/state/onboard-session.ts and src/lib/state/registry/types.ts.
- Extraction candidates cross agents/, nemoclaw/, nemoclaw-blueprint/, src/lib/, scripts/, tests, and workflow files.
- OpenShell `0.0.106` is the repository-supported reference at this planning revision, but the decision record must derive and pin the exact current release, required capabilities, and accepted driver matrix from repository-owned sources rather than trusting prose.
- `src/lib/onboard/runtime-provider/contract.ts` and its consumers form a core-only compatibility seam. The disposition ledger must inventory it by facet without exposing it to packages or deleting behavior before supported OpenShell parity and E2E evidence exist.

</code_context>

<deferred>
## Deferred Ideas

- Executable package contract, catalogue, installer, and controller integration begin only after the acceptance checkpoint. Later phases adapt the existing NemoClaw product workflow and OpenShell lifecycle for each real runtime.
- Independent repositories and public PyPI or OCI transport are later phases.
- The accepted Pi trust-boundary decision does not authorize Pi packaging, support, or standard release-set inclusion. Those Pi changes, NemoCUA, portable Hermes, and the Hermes tool gateway broker need separate accepted decisions.
- Live messaging-service qualification waits for test accounts and an accepted credential-custody plan.

</deferred>

---
*Phase: 01-scope-and-behavior-baseline*
*Context gathered: 2026-08-21*
