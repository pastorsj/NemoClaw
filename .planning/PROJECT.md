<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Agent Runtime Package Migration

## What This Is

This project moves the integration layer for OpenClaw, Hermes, and LangChain Deep Agents Code into independently buildable agent runtime packages. NemoClaw core will discover, install, select, and operate those packages through one data contract and one fixed in-sandbox helper protocol.

The first milestone keeps all packages under `packages/` in this repository as first-party integrations. A later gated milestone may convert each unchanged package to an external integration in an independently released repository; Discussion 9909 acceptance alone does not authorize that ownership change.

## Core Value

Existing NemoClaw users retain the same onboarding and sandbox lifecycle while runtime-native implementation leaves NemoClaw core.

## Requirements

### Validated

- ✓ `nemoclaw onboard` currently provisions OpenClaw, NemoClaw-managed Hermes, and LangChain Deep Agents Code.
- ✓ OpenShell owns sandbox lifecycle, credential projection, and network-policy enforcement.
- ✓ Current agent manifests already provide a partial data model for runtime identity, services, state, inference, and MCP support.
- ✓ The central E2E system already qualifies all three managed images through real lifecycle operations.

### Active

- [ ] Put the shared contract and three standard agent runtime packages under `packages/`; add a private runtime-support workspace only if a fresh image-build inventory proves one exact package-neutral payload with at least two current package consumers.
- [ ] Add `nemoclaw harness install` and `nemoclaw harness list` without changing existing onboarding behavior.
- [ ] Replace runtime-specific host execution with a fixed, closed `runtime-control` protocol inside each sandbox image.
- [ ] Give the root CLI, OpenClaw plugin, shared contract, and runtime packages unique identities in one npm workspace graph with deterministic clean-package contents.
- [ ] Keep one NemoClaw-owned OpenShell client boundary while OpenShell remains authoritative for sandbox lifecycle and durable state, compute dispatch, effective policy, provider and credential custody, inference interception, and every admitted image entrypoint or direct sandbox execution.
- [ ] Keep immutable qualification evidence distinct from the checked-in support status, and distinguish package execution claims from independently observed postconditions.
- [ ] Make every package independently buildable and testable outside the NemoClaw checkout.
- [ ] Qualify the in-tree package release before moving any package to an external repository.
- [ ] Pin independently published package and image identities through a core-owned release set.
- [ ] Run the no-messaging OpenClaw install, onboard, inference, restart reconciliation, receipt, and cleanup journey on a real Apple silicon macOS host with Docker Desktop or Colima, and run the protected default-OpenClaw staging Launchable journey on Brev before release qualification.

### Out of Scope

- Live Telegram, Discord, Slack, WeChat, WhatsApp, Microsoft Teams, or Google Chat account testing is excluded because credentials and accounts are unavailable for this migration.
- Messaging channels do not become a separate plugin system in this project.
- LangChain Deep Agents Code does not gain messaging-channel support without a real inbound and outbound runtime bridge.
- Portable Hermes and the Hermes tool gateway broker remain separate lifecycle designs.
- Pi and NemoCUA do not shape the base package contract. The accepted Pi trust-boundary decision does not authorize Pi packaging, support, or standard release-set inclusion; those changes and NemoCUA still require separate accepted decisions.
- A bare `pip install` does not trigger ambient discovery or import Python package code into the NemoClaw host process.
- Package activation, removal, registry search, and multi-version user controls are not added without an accepted user requirement.
- The in-tree milestone does not rename current images or split the existing managed-image publication cohort.

## Context

The current implementation is partly data-driven but still executes extensive runtime-native behavior in the host CLI. OpenClaw is represented as `null` in important onboarding paths. Managed startup selects runtime-specific configuration generators. MCP and messaging use closed runtime unions and runtime-name switches. Registry state also contains runtime-specific fields.

The audited change surface is recorded under `proposals/agent-runtime-packages/`. The proposal reconciles the package design with NVIDIA/NemoClaw Discussion 9909. The discussion uses different command and staging-directory language; the accepted decision must resolve those differences before Phase 2 begins.

## Measured Scope

The refreshed inventory at revision `a5486894c45140259d822625e74d1ccdfce807ee` identifies 627 standard-runtime rows and 229,099 nonblank lines: 210 production files and 76,096 lines, 410 detailed test files and 130,532 lines, and seven dependency locks and 22,471 lines across OpenClaw, NemoClaw-managed Hermes, and LangChain Deep Agents Code. The complete audit contains 692 rows and 254,731 lines after retaining the separately deferred Hermes Portable, Hermes tool broker, Pi, and NemoCUA workstreams so they cannot move into a standard package by accident. Every row has a `move`, `split`, `keep`, or `delete` disposition in the Phase 1 ledger.

These are whole-file change-surface bounds, not estimates that every line will move or be rewritten. Shared core files overlap runtime families and require symbol-level disposition during Phase 1. The roadmap therefore uses 50 dependency-ordered plans and evidence gates rather than a false line-for-line implementation estimate.

## Constraints

- **Product scope**: Characterization and inventory evidence may be prepared before acceptance. A maintainer must record `Accept`, reason and placement, an accountable maintainer, and the validation plan before Phase 2 or package implementation begins. The record must bind the exact proposal revision under review.
- **Compatibility**: OpenClaw remains the default. Existing menu labels, order, prompts, flags, environment variables, aliases, compatibility executables, and resulting sandbox behavior remain unchanged during the in-tree migration.
- **Trust boundary**: NemoClaw must not import or execute package-supplied code in the host CLI. Package executable logic runs only inside the OpenShell sandbox.
- **Authority**: NemoClaw core owns product workflow, package selection, generic plan compilation, logical provider selection, required-policy compilation, host routes and ports, product-state linkage, rollback decisions, and release qualification. OpenShell owns sandbox lifecycle and durable state, compute dispatch, effective policy enforcement, provider and credential custody and rewrite, inference interception, and every admitted image entrypoint or direct sandbox execution. OpenShell `0.0.106` does not reproduce the current Deep Agents Code session cleanup wrapper or the OpenClaw and Hermes descendant restart loops, so those three exact wrappers move unchanged as package-internal compatibility debt with explicit later-pin removal gates; they are not part of `runtime-control` and cannot call OpenShell or own sandbox lifecycle.
- **Identity**: Rebuild, restore, and update operations use exact package, descriptor, image, platform, OpenShell, driver, capability-cohort, and controller-protocol receipts. Unknown identity fails closed.
- **Evidence**: A helper's report about its own mutation is executor-claimed evidence. Product state records the producer and observation limit and requires an independent postcondition wherever the pinned OpenShell and runtime boundary can provide one.
- **Support status**: Historical qualification evidence remains immutable. A reviewed NemoClaw release-set change can mark an exact tuple supported, revoked, or superseded without rewriting that history. Existing sandboxes are never silently replaced.
- **Testing**: New deterministic tests mock external services. Live E2E is reserved for Docker, OpenShell, image, process, state, and release boundaries. Release qualification requires the real Apple silicon macOS OpenClaw journey on Docker Desktop or Colima, including restart reconciliation, and the protected default-OpenClaw staging Launchable journey on Brev; the optional-state macOS catalogue target alone is not sufficient.
- **Migration order**: Deep Agents Code and managed Hermes are the two real contract consumers. Deep Agents Code moves first. Contract V1 freezes from both consumers before OpenClaw moves.
- **Simplicity**: Reuse the current catalogue, lifecycle, state, OpenShell client, test registry, and release machinery. Keep single-runtime behavior package-internal. A shared abstraction needs two current consumers, one named superseded path, and fewer architecture findings after the change.
- **Commit discipline**: Work on the fork-tracked migration branch. Finish each independently
  valuable plan with its focused tests, then create a signed Conventional Commit with the DCO
  sign-off. Keep commits local until the user explicitly authorizes a push. Do not mix unrelated
  phases or rewrite published history.
- **Repository split**: External repositories consume the same package roots, descriptors, controllers, and tests that passed the in-tree release gate.

## Key Decisions

| Decision | Rationale | Outcome |
|---|---|---|
| Use `packages/` as the first extraction boundary | It permits incremental review and preserves one release transaction before cross-repository coordination begins. | — Pending |
| Use `nemoclaw harness install` as the public command | It matches the requested user vocabulary while internal types retain the accurate `agent runtime package` term. | — Pending |
| Use a data-only descriptor plus fixed in-sandbox helper | It supports different runtime implementations without loading third-party callbacks into the host CLI or creating another process supervisor. | — Pending |
| Prepare unique npm package identities and deterministic workspace packaging first | The root CLI and OpenClaw plugin currently share a package name, developer setup is coupled to packaging, and later package independence needs a clean contents contract. | — Pending |
| Register standard packages automatically | Existing users must not run an extra command or download every unselected sandbox image. | — Pending |
| Separate execution claims, independent observations, and support status | A package cannot prove its own mutation independently, and later security findings must block future use through a reviewed release-set change without altering historical qualification evidence. | — Pending |
| Split messaging across the existing authorities | NemoClaw retains channel manifests, enrollment, logical bindings, registry state, host forwarding, and status and health probe hooks; OpenShell retains credential custody and effective policy; packages own native rendering and data-only health declarations. | — Pending |
| Preserve current image names and cohort for the in-tree milestone | It separates code ownership migration from release-topology migration. | — Pending |
| Use the in-tree qualified release as the externalization rollback point | A separate maintainer decision must authorize conversion from first-party to external ownership, and the repository split must not introduce a simultaneous contract redesign. | — Pending |

## Evolution

After each phase, update validated requirements, active blockers, and decisions with the phase verification result. Do not broaden supported scope from technical conformance alone.

---
*Last updated: 2026-08-22 after local commit and final architecture audit*
