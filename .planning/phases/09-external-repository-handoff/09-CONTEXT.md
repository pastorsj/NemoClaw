<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 9: External Repository Handoff - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

After a separate maintainer decision, convert the three package roots that passed the Phase 8 first-party in-tree release gate into external integrations in independently owned repositories. Preserve the package descriptor, controller protocol, package tests, and user experience. Switch the standard release set only after NemoClaw independently qualifies the external artifacts. Discussion 9909 acceptance alone does not authorize this phase.

</domain>

<decisions>
## Implementation Decisions

### Entry and rollback gates
- **D-01:** Do not create or consume external package repositories until Phase 8 records a qualified in-tree release that can serve as the rollback point.
- **D-02:** A maintainer decision must explicitly authorize converting each standard package from a first-party in-tree integration to an external integration and name each repository, owner, artifact transport, trust policy, retention, revocation, incident process, and validation evidence before handoff begins.

### Artifact and execution contract
- **D-03:** External repositories publish the same descriptor, fixed controller protocol, tests, and image behavior that passed in-tree; repository handoff does not redesign the contract.
- **D-04:** NemoClaw consumes exact package and platform-image identities with provenance and independently reruns core conformance before a reviewed release-set change can merge and ship.
- **D-05:** Package discovery remains explicit through the release set or `nemoclaw harness install`; a Python entry point or package-supplied host callback is prohibited.
- **D-08:** Repository handoff preserves the canonical Phase 8 package-content manifest and digest byte-for-byte. Repository-only CI and provenance envelope files are outside that manifest; any packaged source, descriptor, helper, test, lockfile, mode, or archive-byte difference is a new package release that must be qualified, not a handoff-equivalent artifact.
- **D-09:** The accepted external transport receives one NemoClaw-owned exact resolver, bounded fetcher, verifier, and content-addressed cache. Resolution executes no package code and leaves installed receipts and running workloads unchanged on offline, missing, corrupt, revoked, or partial input. Existing package-store and installer transactions own atomic registration.
- **D-10:** Immutable qualification evidence references and the checked-in static `supported`, `revoked`, or `superseded` status remain separate core-owned fields. Status changes use ordinary reviewed NemoClaw pull requests and releases. Non-supported entries fail closed for selection and package-dependent mutations without silently changing or deleting an existing sandbox.
- **D-11:** Handoff preserves exactly three package-local descendant compatibility wrappers: OpenClaw `nemoclaw-start.sh`, Hermes `start.sh`, and Deep Agents Code `dcode-session-supervisor.py`. OpenShell continues to own sandbox lifecycle and admitted entrypoint/direct-exec processes; the wrappers may manage only descendants and may not call OpenShell. Removing one requires a later accepted decision plus qualification against an exact OpenShell pin that proves equivalent cleanup, restart, health, authenticated replacement, and final-release behavior.

### Handoff sequence
- **D-06:** Hand off Deep Agents Code, then managed Hermes, then OpenClaw. Qualify and preserve rollback evidence after each handoff.
- **D-07:** Change the complete checked-in standard release set to external artifacts in one reviewed pull request only after all three external packages pass central qualification.

### Claude's Discretion
The executor may choose repository-local workflow filenames and reusable publication helpers. Local sibling checkout names should match `nemoclaw-deepagents-code`, `nemoclaw-hermes`, and `nemoclaw-openclaw` unless the accepted decision records different names.

</decisions>

<specifics>
## Specific Ideas

The repository split should feel like changing an artifact source, not starting a second migration. Package tests must run without access to the NemoClaw checkout.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Accepted architecture and package boundary
- `.planning/PROJECT.md` - Locked trust, compatibility, migration-order, and rollback constraints.
- `.planning/REQUIREMENTS.md` - `DIST-01` through `DIST-05`, `PKG-07`, `SEC-04`, and `CTL-05`.
- `proposals/agent-runtime-packages/README.md` - Package boundary, release-set model, and host-execution prohibition.
- `proposals/agent-runtime-packages/TECHNICAL-PLAN.md` - Artifact identity, controller, trust, release, and externalization details.

### In-tree qualification and publication
- `.planning/phases/08-in-tree-release-qualification/08-05-SUMMARY.md` - Required Phase 8 release evidence and exact rollback identity.
- `.github/workflows/managed-images.yaml` - Current managed-image build and publication authority.
- `.github/workflows/base-image.yaml` - Current base-image build authority.
- `test/e2e/live/managed-image-activation-e2e.test.ts` - Central three-runtime lifecycle qualification.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The Phase 3 contract package validates descriptors and controller messages.
- The Phase 8 package-isolation checks already prove that each package is independent of the NemoClaw checkout.
- The typed E2E target catalogue and workflow planner remain central NemoClaw release authorities.

### Established Patterns
- Managed-image workflows publish immutable multi-architecture images and evidence.
- Package-contract tests consume compiled artifacts instead of source-only imports.
- The release set binds public selection metadata to exact qualified artifacts.

### Integration Points
- External package publication provides exact immutable inputs to a reviewed change to the core-owned static release set.
- `nemoclaw harness install` consumes an accepted explicit artifact source without importing package code.
- Central E2E qualifies exact external package, image, OpenShell, and controller identities. Ubuntu owns the full no-messaging lifecycle for all three packages; the official staging Brev Launchable remains the baked default OpenClaw journey only.

</code_context>

<deferred>
## Deferred Ideas

- Additional public package registries remain deferred unless D-02 accepts them; Phase 9 implements only the one accepted transport.
- Package activation, removal, registry search, and multi-version selection remain deferred.
- Pi, NemoCUA, portable Hermes, and the Hermes tool gateway broker remain outside this handoff.

</deferred>

---
*Phase: 09-external-repository-handoff*
*Context gathered: 2026-08-21*
