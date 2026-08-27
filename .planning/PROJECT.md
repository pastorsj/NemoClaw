<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Component Composition

## Objective

Define the smallest maintainable architecture that lets NemoClaw compose independently versioned
agent runtimes, runtime providers, and inference-serving backends without weakening NemoClaw or
OpenShell security and lifecycle authority.

The first implementation milestone keeps components under `packages/` in the NemoClaw repository.
Repository handoff and external distribution happen only after the in-tree contracts, ownership,
tests, and rollback behavior are stable.

This is a design and implementation candidate. It does not create a supported public NemoClaw SDK,
package registry, marketplace, runtime provider, serving backend, hardware profile, or NeMo Fabric
integration. The repository product scope gate applies before implementation or support claims.
A recorded decision must have status `Accept` and state reason, placement, accountable maintainer,
and validation plan for the exact proposal revision before Phase 2 begins.

## Phase 2 Implementation Decision

- **Status:** Proposed for local fork implementation and development evaluation.
- **Proposal revision:** `5802308d09bdb64dba62dd541e42ad6bb223ceb0`.
- **Decision owner:** Sam Pastoriza, owner of the local fork branch.
- **Reason:** Prove the package contract and unchanged user workflow before requesting upstream
  product activation or external package distribution.
- **Placement:** Build the foundation in NemoClaw core first. Keep harness assets in-tree until
  Phase 3 establishes self-contained package roots and package-owned tests.
- **Initial standard harnesses:** OpenClaw, Hermes, and LangChain Deep Agents Code.
- **Candidate harnesses:** Pi and NemoCUA retain their existing qualification gates and do not gain
  fabricated package identities.
- **Discovery:** Phase 2 exposes only reviewed artifacts bundled with the exact NemoClaw checkout.
  It does not discover PyPI, npm, URL, global, or remote packages.
- **Trust boundary:** Installed packages contain validated data plus sandbox or image-build assets.
  NemoClaw does not import or execute package-authored callbacks in its credential-bearing host
  process.
- **Compatibility and lifecycle:** Existing aliases, flags, defaults, onboarding, strict backup,
  recovery, and OpenShell lifecycle ownership remain available. Exact package identity is durable
  and drift stops before the next mutation.
- **Validation:** Deterministic tests precede isolated no-messaging macOS and operator-supplied Brev
  development runs. Exact staging Launchable evidence remains owned by the release workflow and is
  not implied by local development results.
- **Transitional limitation:** The Phase 2 digest covers the copied adapter and asset bundle. It
  does not claim complete agent-runtime provenance while host behavior remains statically linked.
- **Rollback:** Revert the local task commits and retain the current repository agent paths as the
  authority. Do not mutate a remote branch or external package repository.
- **Product boundary:** Registration, installation, conformance, and development evidence do not
  activate or support a NemoClaw product surface. Any upstream support claim requires a separate
  accepted NVIDIA/NemoClaw product decision.

## Core Value

A contributor can understand where one integration belongs, implement it through a clear typed
contract, test it with the owning package, and let NemoClaw validate and compose it without learning
the internal implementation of every other component.

## Primary Decision

NemoClaw should use one language-neutral distribution envelope and distinct typed contracts. It
should not use one universal executable plugin callback.

The initial component kinds are:

1. **Agent runtime** — an installable harness package selected through `nemoclaw harness`.
2. **Runtime provider** — trusted host-side execution integration using the existing
   `RuntimeProviderBundle` contract.
3. **Serving runtime** — recipes, declarative readiness requirements, and typed materialization,
   lifecycle, preparation, and topology adapters using the existing serving catalogue.

Operating system and hardware are observed platform facts and qualification profiles. They are not
packages. A privileged host preparer is a separate candidate component only when it contains real,
independently owned host mutation, such as DGX Station preparation.

NeMo Fabric is not one of the three composition axes. Its candidate first role is package
validation inside an already-created OpenShell sandbox; the pilot decides whether it earns any
ongoing NemoClaw capability.

## NemoClaw's Role

NemoClaw remains the trusted composition and product control plane. It owns:

- CLI and installer behavior
- safe package ingestion and exact receipts
- compatibility resolution and an immutable onboarding selection receipt
- user selection, credentials, policy intent, and OpenShell registration
- state transactions, rollback, recovery, and release qualification
- support activation and revocation decisions

OpenShell remains the isolation and enforcement plane. Component packages own only their native
implementation behind their specific contract.

## Constraints

- Preserve `nemoclaw harness install` and `nemoclaw harness list` for agent runtime packages.
- Preserve existing `nemoclaw agents list`, `--agent`, `NEMOCLAW_AGENT`, aliases, and onboarding
  behavior during migration.
- Keep file names to one or two precise words, with a third only when it materially improves the
  name. Use descriptive function and class names.
- Use the same responsibility-based structure across packages, but do not create empty directories.
- Do not load arbitrary package code into the credential-bearing NemoClaw host process. In the
  first version, installed agent packages contain only data and sandbox or image-build code.
  Runtime-provider and serving host implementations remain statically linked and explicitly
  registered when NemoClaw is built.
- Registration, installation, activation, qualification, and support are separate states.
- Only agent packages are runtime-installable in the first version. Runtime-provider and serving
  host code can be independently owned source packages, but it remains statically included and
  explicitly registered in a reviewed NemoClaw build.
- Do not create another lifecycle engine, OpenShell client, serving catalogue, platform matrix, or
  E2E registry.
- Messaging-service live tests remain excluded.
- Keep commits local. Do not push.

## Baseline

The active branch is reconciled through exact `origin/main` commit
`d0d5120cc6d574a5575b322b79b7cd49ca7c269d`. Phase 1 originally recorded its historical evidence
at `705372dab8d4d28c0daf058aec1579ffc482db4c`; Phase 2 re-audited the intervening durable-authority,
Windows MXC, messaging, test-runtime, and E2E command-boundary changes. The earlier agent-package
migration is preserved at
`backup/agent-runtime-package-migration-pre-origin-main-20260827` and will be used as a behavioral
prototype, not merged mechanically.

## Success

This project is successful when:

- each supported component has one clear owner and typed contract;
- the in-tree package layout reads as a workflow;
- a new harness can be added without named-agent branches in generic core orchestration;
- a new runtime or serving backend reuses the current contract for that component kind;
- unsupported combinations fail before external mutation and existing lifecycle code consumes the
  resulting selection receipt;
- exact package and qualification identities survive install, onboard, update, rebuild, and
  rollback;
- package tests, contract tests, core composition tests, and focused live qualification provide
  enough evidence without a full Cartesian matrix;
- the engineering team can move a qualified in-tree package to its own repository without changing
  its package tree or behavior.
