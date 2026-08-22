<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 8: In-Tree Release Qualification - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Qualify one complete NemoClaw release that consumes the contract and all three standard packages from `packages/`. The qualified release is the rollback point for the later repository handoff.

This phase proves package independence, exact image and package identity, npm and installer behavior, previous-release migration, rollback, retention, the complete no-messaging lifecycle for all three packages on Ubuntu, both Linux image architectures, the real Apple silicon macOS OpenClaw journey on Docker Desktop or Colima, deterministic WSL behavior, and the official staging Brev Launchable's baked default OpenClaw journey. It does not change image names, split the managed-image publication cohort, resolve external packages, add a generic Brev source-install lane, or require messaging-service accounts.

</domain>

<decisions>
## Implementation Decisions

### Package and artifact qualification

- **D-01:** Each standard package must build, type-check, test, and run conformance after a test copies its package tree outside the NemoClaw checkout.
- **D-02:** Build exact `linux/amd64` and `linux/arm64` images from package-root build contexts. Preserve current public image names and the current all-agent cohort.
- **D-03:** Bind release evidence to the core revision, release-set digest, package-tree and descriptor digests, exact OCI index and platform digests, OpenShell version, controller protocol, and test-suite version.
- **D-13:** Preserve unique identities for the root CLI, OpenClaw TUI plugin, shared contract, and runtime packages in one explicit workspace graph. Build publish contents deterministically from declared package inputs, independently of root development setup.

### Installer and compatibility

- **D-04:** The normal NemoClaw install registers all standard package descriptors and receipts without preloading every sandbox image or requiring an extra command.
- **D-05:** Preserve `nemoclaw`, `nemohermes`, `nemo-deepagents`, `nemoclaw agents list`, `--agent`, and `NEMOCLAW_AGENT` behavior in the packed npm artifact and installer.
- **D-18:** Release qualification must also execute `nemoclaw harness install` against each exact
  reviewed standard-package archive, list the installed packages, and onboard through ordinary
  installed-package discovery. Current live tests do not exercise that public boundary. A test-only
  managed-image catalogue or workload receipt cannot satisfy it.

### State and rollback

- **D-06:** Previous-release sessions, registry entries, and snapshots must migrate to exact package receipts when identity is provable. Unknown identity must fail closed.
- **D-07:** A failed staged replacement must keep the previous exact sandbox authoritative and compensate replacement policy, credential, port, state, and registry contributions.
- **D-08:** Package availability, sandbox deletion, snapshot retention, and durable-state deletion remain separate lifecycle decisions with explicit reference checks.
- **D-14:** Add one pure legacy-evidence-to-receipt resolver. Existing session, registry, checkpoint, and snapshot owners keep parsing and persistence responsibility and call the resolver only for exact identity mapping. Preserve immutable qualification evidence references separately from the static release-set support status.

### E2E and platform evidence

- **D-09:** Core owns one release obligation for install, onboard, inference, restart, snapshot and
  restore, rebuild, and cleanup across OpenClaw, managed Hermes, and LangChain Deep Agents Code.
  Managed-image activation already proves onboard, inference, restart, and cleanup for all three
  runtimes, but it selects a test-only catalogue and does not install or discover a runtime package.
  Existing live tests prove successful rebuild for OpenClaw and Hermes. The `mcp-bridge` Deep Agents
  shard proves successful Deep Agents Code rebuild and a post-rebuild tool call. The typed Deep
  Agents lifecycle separately proves invalid-credential rejection before destructive work.
  `snapshot-commands` proves snapshot and restore for OpenClaw. Add only public package install and
  discovery for all three packages plus Hermes and Deep Agents Code snapshot/restore variants.
  Aggregate those executed results for release. Do not add another registry, planner, or
  general-purpose lifecycle executor.
- **D-10:** Run the full no-messaging lifecycle for all three packages on Ubuntu, deterministic Windows Subsystem for Linux (WSL) evidence, exact multi-architecture image startup, the real Apple silicon macOS no-messaging OpenClaw install, onboard, inference, restart reconciliation, exact receipt, and cleanup journey on Docker Desktop or Colima, and the official staging Brev Launchable's baked default OpenClaw CPU hosted-inference journey. Do not add a generic Brev source-install lane or claim that Brev qualifies Hermes or Deep Agents Code. The existing optional-state macOS target is supporting compatibility evidence, not a substitute for the live macOS journey.
- **D-11:** Do not select live messaging-service targets. Retain deterministic messaging tests and onboard with no messaging channel selected.
- **D-12:** A protected release workflow, not a package, chooses targets, jobs, runners,
  credentials, and release qualification. `suiteIds` remain reporting metadata and cannot establish
  an executed lifecycle result. The existing trusted controller runs an exact pre-merge Launchable
  candidate only from an `NVIDIA/NemoClaw` source branch. A fork commit must be mirrored unchanged
  by a maintainer or qualified from merged `main`; do not weaken that trust gate.
- **D-15:** The core-owned `release/agent-runtime-packages.json` is the one static standard release set. Ordinary reviewed pull requests change exact package, image, OpenShell, qualification-reference, or support-status fields. Ordinary PR CI gates merge; protected exact-candidate evidence and maintainer review gate release. No second release-state system is introduced.
- **D-16:** Contract V1 has exactly two helper operations, `reconcile-native` and `prepare-native-state`, and both are declared mutation-capable. It has no read-only helper operation and no before/after enforcement scheme. Helper results remain executor claims; core or OpenShell-owned probes establish product postconditions. An unknown operation or mutation outside either operation's declared scope fails qualification without altering immutable evidence or static support status; any status change is an ordinary reviewed pull request.
- **D-17:** OpenShell owns sandbox lifecycle and each admitted image entrypoint or direct exec process. Preserve exactly the existing OpenClaw `nemoclaw-start.sh`, Hermes `start.sh`, and Deep Agents Code `dcode-session-supervisor.py` package-local descendant compatibility wrappers until a later exact OpenShell pin proves equivalent cleanup, restart, health, authenticated replacement, and final-release behavior. These wrappers may manage only descendants of their admitted process and may not call OpenShell or own sandbox lifecycle.

### Claude's Discretion

Claude may divide package-local test commands by language and may add typed evidence helpers. Claude must not create a second runtime catalogue, workflow matrix, or managed-image cohort record.

</decisions>

<specifics>
## Specific Ideas

- Reuse the typed target definitions, `tools/e2e/target-catalogue.mts`, the existing free-standing
  jobs, and `tools/e2e/workflow-plan.mts`. Do not duplicate target selection in package descriptors.
- Extend managed-image activation to run `nemoclaw harness install`, list all three installed
  packages, and onboard through ordinary package discovery. Keep the exact publication catalogue
  only as expected image evidence. Do not pass it through `--temp-managed-runtime` as the package
  selection source for this release obligation.
- Reuse the current `mcp-bridge` Deep Agents shard for successful Deep Agents Code rebuild. Preserve
  the typed invalid-credential lifecycle as a separate failed-rebuild safety result.
- Add only Hermes and Deep Agents Code variants of the shared snapshot create, list, restore, state,
  and cleanup sequence. Keep OpenClaw pairing, clone, Shields, and canonical-file checks in the
  existing OpenClaw case.
- Use the existing `staging-brev-launchable` job only for its baked default OpenClaw user journey. The all-three-package lifecycle remains in the central Ubuntu qualification, and no generic Brev source-install lane is reintroduced.
- Run the existing `full-e2e` lifecycle on the user-provided Apple silicon macOS host with Docker Desktop or Colima through
  `tools/e2e/live-vitest-invocation.mts` with `test/e2e/live/full-e2e.test.ts`. Set
  `E2E_TARGET_ID=macos-docker-full-e2e` and a test-owned `E2E_ARTIFACT_DIR`; do not add a second
  registry entry. Extend the macOS branch with a cross-platform restart and reconciliation
  assertion because it currently omits the Linux-only gateway-stop and recovery step. Bind its
  redacted artifacts to the exact reviewed release-set revision. Do not treat the optional-state
  hosted macOS target as live lifecycle evidence.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project and release requirements

- `.planning/PROJECT.md` — In-tree milestone and rollback-point decisions.
- `.planning/REQUIREMENTS.md` — `REL-01`, `REL-02`, `REL-03`, `STATE-03`, `TEST-04`, `TEST-05`, `PKG-06`, `PKG-07`, `SEC-04`, and `CTL-05`.
- `.planning/ROADMAP.md` — Phase goal, plan list, dependencies, and success criteria.
- `proposals/agent-runtime-packages/TECHNICAL-PLAN.md` sections 8, 10, and 11 — Image trust, test ownership, E2E, and migration gates.

### Repository rules and E2E design

- `AGENTS.md` — Test-project, E2E, product-scope, and contribution gates.
- `WRITING.md` — Required language for code, tests, plans, and reports.
- `test/e2e/README.md` — Typed target, workflow, platform, retry, and release-qualification ownership.
- `test/e2e/docs/README.md` — E2E documentation and evidence rules.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `vitest.config.ts` already separates CLI, integration, installer-integration, package-contract, plugin, E2E-support, and live-E2E projects.
- `.github/workflows/base-image.yaml` and `.github/workflows/managed-images.yaml` already publish two architectures and one all-agent cohort.
- `test/e2e/registry/definitions/baseline.ts` owns the typed baseline targets.
  `tools/e2e/target-catalogue.mts` owns the successful OpenClaw and Hermes rebuild tests and the
  OpenClaw snapshot test. The `mcp-bridge` Deep Agents shard owns successful Deep Agents Code
  rebuild. The Deep Agents Code baseline owns invalid-credential rejection before destructive
  rebuild work. Hermes and Deep Agents Code do not have public snapshot/restore variants.
- `test/e2e/live/managed-image-activation-e2e.test.ts` qualifies all three real runtimes with exact
  images, turns, restart, and cleanup. It currently uses a test-only catalogue and records a
  managed-image workload receipt. It does not run `nemoclaw harness install` or prove
  installed-package discovery.
- `.github/workflows/platform-vitest-main.yaml` already provides supporting deterministic Ubuntu, macOS, and WSL evidence. Release qualification uses its deterministic WSL boundary and separately requires the full Ubuntu lifecycle and executed Apple silicon macOS OpenClaw lifecycle on Docker Desktop or Colima.
- `.github/workflows/e2e.yaml` already owns protected multi-architecture startup and `staging-brev-launchable`.

### Established Patterns

- `test/package-contract/**` is the only non-live project that imports compiled artifacts.
- Installer tests under the `installer-integration` Vitest project spawn the real `scripts/install.sh` process.
- Live E2E retries are prohibited unless a checked-in narrow policy proves idempotence and records attempt evidence.
- Current managed-image contracts use `ghcr.io/nvidia/nemoclaw/openclaw-sandbox`, `ghcr.io/nvidia/nemoclaw/hermes-sandbox`, and `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox`.

### Integration Points

- `package.json` publishes `agents/*`, `nemoclaw/`, the root Dockerfile, and compatibility executables. Its file list and scripts must use `packages/`.
- `scripts/install.sh` contains standard runtime aliases, OpenClaw pre-extraction, compatibility executable selection, and shipped-runtime checks.
- `src/lib/state/registry/types.ts`, session/checkpoint/snapshot normalizers, `src/lib/onboard/sandbox-recreate-transaction.ts`, `src/lib/actions/sandbox/rebuild-pipeline.ts`, the rebuild recreate journal, and uninstall code own migration, rollback, and retention evidence.
- `tools/e2e/workflow-plan.mts` remains the one planner for typed targets, catalogue targets, and
  free-standing jobs in `.github/workflows/e2e.yaml`. `.github/workflows/managed-images.yaml` keeps
  the existing managed-image activation owner. The release evidence aggregator binds its executed
  artifact to the same revision and release-set digest without creating another selection registry.

</code_context>

<deferred>
## Deferred Ideas

- External package repositories and transport resolution belong to Phase 9.
- Mutable user activation, package removal commands, registry search, and multi-version controls remain deferred.
- Live messaging-service qualification remains deferred until accounts and credential custody are available.
- Pi, NemoCUA, portable Hermes, and the Hermes tool gateway broker are not release-set additions in this phase.

</deferred>

---

*Phase: 08-in-tree-release-qualification*
*Context gathered: 2026-08-21*
