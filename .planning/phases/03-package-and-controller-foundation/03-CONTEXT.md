<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3: Package and Controller Foundation - Context

**Gathered:** 2026-08-21
**Status:** Ready after explicit runtime identity

<domain>
## Phase Boundary

Create the smallest secure package contract, local artifact installer, catalogue, exact receipts, and fixed controller client. Register standard OpenClaw, managed Hermes, and Deep Agents Code without changing their current execution paths. Later phases move runtime-native code and adapt the existing lifecycle only as each real runtime needs it. A locally installed compatible package is listable but is not normally selectable. This phase supports local artifacts only and does not split repositories or add live messaging qualification.

</domain>

<decisions>
## Implementation Decisions

### Shared contract and package unit
- **D-01:** packages/agent-runtime-contract owns the language-neutral JSON Schemas, generated TypeScript types, validators, hostile fixtures, and conformance entrypoint. Schema files define the wire contract.
- **D-02:** A V1 package is a bounded static archive rooted at agent-runtime-package.yaml with optional declarative policy, model compatibility, provenance, and README files. The descriptor is closed and data-only and declares exact identity, compatibility, images, services, state, settings, capabilities, credential requirements, and core-owned probe declarations. Trusted NemoClaw core and OpenShell code execute and interpret those probes; a package helper cannot assert product health or product state.
- **D-03:** Every controller-qualified runtime image exposes `/opt/nemoclaw/bin/runtime-control`. Phase 3 fixes only the executable path, protocol framing, deny-by-default version negotiation, request correlation, byte and depth bounds, deadlines, cancellation, and output handling. Phase 3 does not define a native operation set, effect mechanism, evidence model, lifecycle operation, process-supervision operation, or read-only helper operation. Later contract work may add only the mutation-capable `reconcile-native` and `prepare-native-state` operations, and only when both Deep Agents Code and managed Hermes prove the same need and semantics.
- **D-04:** Phase 3 installs explicit local .tar or .tar.gz artifacts only. PyPI, OCI package archives, registry search, and bare language-package discovery remain deferred.

### Release set, catalogue, and store
- **D-05:** The checked-in core-owned release set owns standard display labels, order, aliases, the OpenClaw default, exact package and image identities, the exact OpenShell release and capability cohort, the accepted driver and platform matrix, one immutable qualification-evidence reference, and one current support status: `supported`, `revoked`, or `superseded`. Descriptors cannot claim these fields. A support-status change is an ordinary reviewed NemoClaw commit and release; there is no mutable support store, generation, status head, or decision chain.
- **D-06:** A normal NemoClaw install ships the three standard descriptors and exact release-set receipts. All three entries are `supported` in Phase 3, image layers remain lazy, and each entry continues through its current trusted execution integration. A runtime changes to the controller path only in its extraction phase after real package tests pass.
- **D-07:** Core reads standard packages from the checked-in release set and user-installed packages from a separate per-user content-addressed store. The user store has one atomic installed-package index implemented in `store.ts`; it has no status index, compare-and-swap head, append-only decision log, generation, or state machine. Every index read verifies the referenced receipt and content digests.
- **D-08:** Successful ingestion records immutable transport-blob, canonical package-tree, descriptor, optional software-bill-of-materials, declared OCI index and platform identities, compatibility requirements, and protocol identities. Staging, receipt, and the single installed-package index commit are atomic. Repeated exact install is idempotent.
- **D-09:** NemoClaw never imports or executes package files on the host. Runtime code executes only inside the selected OpenShell sandbox image.
- **D-10:** Archive ingestion uses the reviewed direct `tar@7.5.21` dependency and its public APIs. NemoClaw supplies path, type, filter, mode, file-count, per-file, expanded-byte, nesting, root-shape, and digest validation around that library. It does not implement a tar parser. Validation rejects absolute or escaping paths, duplicate normalized paths, links, special files, invalid modes or names, resource-limit violations, unexpected roots, mutable image identities, and digest mismatch before commit.
- **D-11:** The public commands are `nemoclaw harness install LOCAL_ARTIFACT` and `nemoclaw harness list`. `nemoclaw agents list` delegates to the same catalogue and preserves its compatibility rendering.
- **D-12:** A local artifact that claims a standard package ID must match the exact release-set tuple. Divergent ID/version reuse or a standard-name collision fails; an identical tuple is an idempotent registration. A nonstandard compatible artifact is installed and listed but is not a normal onboarding choice. Normal selection derives only from `supported` entries in the checked-in release set.

### Controller protocol and lifecycle
- **D-13:** The controller channel uses one closed, size-bounded JSON negotiation request and response over the NemoClaw OpenShell client boundary. Frames bind a request nonce, package receipt, sandbox, and exact image identity. NemoClaw supplies the supported protocol-version allowlist, deadline, cancellation, and output bounds. Missing intersection, downgrade, mismatch, replay, extra frames, binary data, and late output fail closed. No Phase 3 frame contains a native operation, generation, intent digest, effect class, or evidence claim.
- **D-14:** Accepted responses contain no free text or credentials. Raw standard output, standard error, malformed frames, and native diagnostics are credential-bearing, held only in a bounded memory buffer, redacted for immediate display, and never persisted.
- **D-15:** The V1 descriptor can declare bounded static identity, images, services, state roots, credential requirements, policy requirements, resources, runtime settings, terminal or agent-gateway interaction shape, and data-only core probe declarations. It does not define generic production intent or native operation schemas in Phase 3. Trusted core and OpenShell execute and interpret product observations. Later shared controller work is limited to mutation-capable `reconcile-native` and `prepare-native-state`, and each operation is added only if both Deep Agents Code and managed Hermes prove the same contract.
- **D-16:** NemoClaw core retains the current product workflow, package selection, provider and policy decisions, product-state linkage, trusted product observations, rollback decisions, and qualification. OpenShell remains authoritative for sandbox lifecycle and durable sandbox state, compute dispatch, effective policy, provider and credential custody and rewrite, inference interception, and each admitted image entrypoint or direct-exec process. The pinned OpenShell release does not replace three current descendant behaviors, so `agents/langchain-deepagents-code/dcode-session-supervisor.py`, the descendant loop in `agents/hermes/start.sh`, and the descendant loop in `scripts/nemoclaw-start.sh` remain exact compatibility debt. Each may manage only descendants of its admitted process; none may call OpenShell, own sandbox lifecycle, become `runtime-control`, or become a public package contract. Later extraction moves these three wrappers with their owning runtime without changing them. Removal waits for an exact OpenShell pin that proves matching cleanup, restart, health, authenticated replacement, and final-release behavior through E2E. New OpenShell transport enters through the existing core-owned client; exact legacy exceptions remain ratcheted until their named migration phase.
- **D-17:** `AgentRuntimeReceiptV1` binds only exact package, descriptor, release-set, managed-image, OpenShell, driver, platform, and negotiated-protocol identities that the current path knows. Existing sandbox registry rows carry this receipt by optional digest reference. Current managed-image onboarding, the production rebuild preflight, and the production recreate path preserve and validate the reference. Legacy rows remain valid without it; Phase 3 adds no migration API.
- **D-18:** The foundation registers the three standard runtimes through one catalogue while preserving their current trusted execution integrations. Deep Agents Code and managed Hermes are the two real consumers that later prove the shared controller contract against the existing NemoClaw product workflow and OpenShell lifecycle. Protocol and security test doubles are fixtures only; they are not agent runtime implementations or lifecycle authorities.
- **D-19:** Foundation qualification uses the existing no-messaging journeys and deterministic messaging tests. It does not create a test-only live runtime or require a live messaging account.
- **D-20:** Missing packages, incompatible contracts, absent platform images, controller negotiation failure, and receipt mismatch stop with remediation. No path substitutes another package, version, image, controller, or runtime.
- **D-21:** The root CLI, OpenClaw plugin, shared contract, and three runtime package roots have unique accepted npm package identities in one root workspace graph and one root workspace lockfile. Existing `package-lock.json` files may remain only inside runtime-image subtrees that are not npm workspaces and reproduce an independently tested image dependency graph. Phase 3 does not create an empty `nemoclaw-runtime-support` workspace. Phase 4 may create that core-owned build-input artifact only when an exact inventory proves both Deep Agents Code and managed Hermes consume the same package-neutral payload in the same change; otherwise it stays absent. Developer setup is separate from deterministic clean packing, and every packed artifact has explicit shipped contents.
- **D-22:** A repository architecture check ratchets runtime-name executable branches, package-to-core imports, root imports of package source, host execution of package content, and direct OpenShell calls outside the one client boundary against the accepted Phase 1 baseline.
- **D-23:** Phase 3 does not implement generic effects, evidence provenance, helper observation, support revocation triggers, or runtime-native postconditions. Negotiation output is untrusted protocol data and is not persisted as runtime evidence. Product observations come from descriptor-declared probes executed and interpreted by trusted core and OpenShell code. Deep Agents Code and managed Hermes must both prove either of the two allowed mutation-capable operations before that operation becomes shared.

### Claude's Discretion
The executor may choose internal TypeScript module names. New shared runtime behavior must have Deep Agents Code and managed Hermes as current consumers and replace named current paths. Test fixtures cannot become a second runtime implementation.

</decisions>

<specifics>
## Specific Ideas

Keep the host contract direct: validated data in, validated data out, and one controller executable reached through OpenShell. The first installer need only handle an explicit local artifact. Standard descriptors can be bundled without downloading images. Use current runtime paths and the existing E2E registry for foundation regression evidence. Add `reconcile-native` or `prepare-native-state` only when Deep Agents Code and Hermes both provide a real consumer. Keep product observation in trusted core and OpenShell probes.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Accepted architecture and prior phases
- .planning/phases/01-scope-and-behavior-baseline/01-04-SUMMARY.md - Product acceptance and validation gate.
- proposals/agent-runtime-packages/DECISION-RECORD.md - Accepted package namespaces and supported surface.
- proposals/agent-runtime-packages/TECHNICAL-PLAN.md - Descriptor, receipt, controller, lifecycle, state, and security design.
- proposals/agent-runtime-packages/DISPOSITION-LEDGER.md - Core/package ownership and privileged-action classification.
- .planning/phases/02-explicit-runtime-identity/02-03-SUMMARY.md - Explicit runtime identity and unified onboarding state.
- .planning/PROJECT.md - Locked trust and compatibility constraints.
- .planning/REQUIREMENTS.md - Phase 3 contract, CLI, security, controller, and state requirements.

### Current discovery, CLI, and state
- src/lib/agent/defs.ts - Current manifest discovery and selection metadata to bridge into the catalogue.
- src/lib/agent/definition-types.ts - Closed runtime-specific types that later extraction phases replace.
- src/lib/agent/list-command.ts - agents list compatibility rendering.
- src/commands/agents/list.ts - Existing public list adapter.
- src/lib/cli/public-display-defaults.ts - Public command display registration.
- src/lib/state/state-root.ts - NemoClaw per-user state root.
- src/lib/state/registry/types.ts - Sandbox and workload receipt schema.
- src/lib/state/registry-normalization.ts - User-writable registry validation.

### Lifecycle and security
- src/lib/onboard/managed-startup/profile.ts - Current bounded, secret-rejecting startup intent.
- src/lib/onboard/managed-startup/image-runtime.ts - Current root and sandbox startup application boundary.
- src/lib/onboard/managed-startup/root-apply.ts - Current closed root-application contract.
- src/lib/onboard/managed-image/contract.ts - Current managed image identity.
- src/lib/onboard/sandbox-registration.ts - Current registry entry construction and commit path.
- src/lib/onboard/created-sandbox-finalization.ts - Current post-create registration path.
- src/lib/onboard/workload/rebuild.ts - Current managed-image rebuild handoff.
- src/lib/actions/sandbox/rebuild-preflight-target-phase.ts - Production rebuild preflight before destructive mutation.
- src/lib/actions/sandbox/rebuild-recreate-phase.ts - Production recreate and registry-preservation path.
- src/lib/adapters/openshell/client.ts - OpenShell command transport.
- nemoclaw/src/blueprint/ssrf.ts - Existing hostile URL and private-network validation patterns.

### Test ownership
- vitest.config.ts - Disjoint source, integration, package-contract, E2E-support, and live E2E projects.
- test/e2e/README.md - Typed target registry, evidence, retry, and live-boundary rules.
- test/e2e/registry/definitions/baseline.ts - Existing baseline target definitions.
- tools/e2e/target-catalogue.mts - Generated target catalogue.
- tools/e2e/workflow-plan.mts - Shared workflow planner.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Ajv and YAML parsers are already root dependencies. Phase 3 adds reviewed `tar@7.5.21` as a direct root dependency instead of implementing archive parsing.
- nemoclawStateRoot provides the correct per-user state-root boundary.
- Registry normalization and managed-image workload receipts provide the current durable state boundaries.
- `actions/sandbox/rebuild-*` and `onboard/workload/rebuild.ts` own the production rebuild and recreate path. `onboard/managed-workload/rebuild/**` is not the Phase 3 integration target.
- The E2E fixture layer supports fake OpenShell for deterministic tests and explicit opt-in live targets.

### Established Patterns
- New CLI logic belongs under src/lib and thin oclif adapters under src/commands.
- Source unit tests are co-located; compiled artifact assertions live only in test/package-contract.
- Package-provided text is untrusted and must not become terminal control or persisted diagnostics.
- State mutation uses adjacent temporary files, restrictive modes, atomic rename, and explicit cleanup.
- Live E2E asserts outcomes, state, receipts, redacted evidence, and cleanup rather than terminal progress wording.

### Integration Points
- Onboarding choices can read the new catalogue while standard runtimes continue through current definitions until their extraction phase.
- Local install writes only the per-user package store and its one installed-package index; it does not make a custom package normally selectable, create a sandbox, or pull an image.
- Phase 3 adds controller negotiation to `src/lib/adapters/openshell/client.ts`, but no current runtime uses it. Fake OpenShell transports exercise framing and hostile-output behavior only.
- New registry rows can reference the exact standard package receipt. The current managed-image registration and production rebuild/recreate path preserve that optional reference without replacing existing state owners.
- Phase 3 migrates only the audited OpenShell adapter findings named in Plan 03-06. Full OpenShell transport convergence remains Phase 10 work.

</code_context>

<deferred>
## Deferred Ideas

- PyPI and OCI package transports, signature trust roots, public search, activation, deactivation, pull, removal, multiple active versions, and normal selection of merely compatible local packages.
- Runtime-native extraction for Deep Agents Code, Hermes, and OpenClaw.
- Live Telegram, Discord, WhatsApp, or other messaging-service qualification.
- External repositories, independent publication, and release-set changes for externally published packages.

</deferred>

---
*Phase: 03-package-and-controller-foundation*
*Context gathered: 2026-08-21*
