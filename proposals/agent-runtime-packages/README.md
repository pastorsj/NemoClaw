<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Packages: Engineering Proposal

> **Status:** Exploratory design for engineering review. This proposal is not accepted product
> behavior, a public SDK, or a support commitment. Characterization and inventory evidence may be
> prepared before acceptance. Phase 2 and package implementation remain blocked until maintainers
> record Accept, reason and placement, one accountable maintainer, and the validation plan, bound to
> the exact proposal revision.
>
> **Inventory audit:** `c7af3734b9933b2380d7d7e919d625da89096c23`
>
> **Source refresh:** `a5486894c45140259d822625e74d1ccdfce807ee`
>
> **Detailed artifacts:** [Technical plan](TECHNICAL-PLAN.md),
> [RFC reconciliation](RFC-RECONCILIATION.md),
> [ownership](OWNERSHIP.md), [validation plan](VALIDATION-PLAN.md),
> [decision record](DECISION-RECORD.md),
> [integration inventory](RUNTIME-INVENTORY.md), and the candidate lists for
> [OpenClaw](OPENCLAW-CANDIDATES.tsv), [Hermes](HERMES-CANDIDATES.tsv), and
> [terminal agents](TERMINAL-CANDIDATES.tsv).

## Decision requested

Approve an in-tree migration that moves the three standard agent runtime integrations into
self-contained packages without changing the current NemoClaw experience.

The first implementation should create these roots:

```text
packages/
├── agent-runtime-contract/
├── nemoclaw-openclaw/
├── nemoclaw-hermes/
└── nemoclaw-deepagents-code/
```

Phase 4 inventories the exact package-neutral files copied into at least Deep Agents Code and
managed Hermes images. Add `packages/nemoclaw-runtime-support` only if that inventory proves one
shared payload with two current consumers and existing deterministic packing cannot supply it.
Otherwise, do not create the workspace.

The three standard support-catalog entries remain OpenClaw, Hermes, and LangChain Deep Agents Code.
OpenClaw remains first and default. The migration preserves:

- the current onboarding menu labels, order, prompts, and defaults;
- `nemoclaw onboard`, `nemoclaw agents list`, `--agent`, and `NEMOCLAW_AGENT`;
- the `nemohermes` and `nemo-deepagents` compatibility launchers;
- existing aliases and accepted legacy state, including records where `null` means OpenClaw; and
- the resulting sandbox, policy, credential, inference, state, and lifecycle behavior.

The package boundary must be proved and qualified in this repository before any package moves to a
separate repository. The qualified in-tree release is the rollback point for later repository
handoff.

## Recommendation

Use one explicit public install command for a local artifact:

```text
nemoclaw harness install <local-artifact>
nemoclaw harness list
nemoclaw agents list
nemoclaw onboard
```

`harness` is the compatibility command namespace requested for the public CLI. New internal code and
documents use **agent runtime** for OpenClaw, Hermes, and LangChain Deep Agents Code. The word
**plugin** remains reserved for code loaded by an agent runtime, such as the existing OpenClaw
plugin.

A normal NemoClaw install registers exact support-catalog descriptors for all three standard
packages. It does not eagerly download every platform image. Onboarding materializes only the image
selected for the current host and agent runtime.

`nemoclaw agents list` becomes a compatibility view over the same catalogue used by
`nemoclaw harness list`; it is not a second registry. Standard entries receive their familiar names,
order, aliases, and default only from the core-owned release set.

`nemoclaw harness install <local-artifact>` validates and stores one exact artifact in a
content-addressed package store. In the first release, locally registered compatible packages are
list-only. A descriptor, successful install, or passing conformance test does not make a package
supported or normally selectable. Only an exact, checked-in release-set entry whose core-owned
status is `supported` can do that.

PyPI, Open Container Initiative (OCI) sources, repository search, package activation, package
removal, and multi-version selection are later decisions. A bare package-manager install never
causes ambient discovery and NemoClaw never imports package code into its host process.

## Common interface

The package interface has three small parts.

1. A schema-validated, data-only descriptor declares exact package and agent runtime identity,
   contract compatibility, platform images, named services, native state, bounded settings,
   capabilities, and required policy. Reading it executes no package code.
2. A fixed `/opt/nemoclaw/bin/runtime-control` executable exists inside each package image. It accepts
   closed, bounded requests for runtime-native configuration and reconciliation. It is
   not a resident service, supervisor, sandbox lifecycle API, OpenShell client, or host callback.
3. A conformance kit verifies the descriptor, packed contents, image, helper protocol, executor
   claims, trusted observations, and the user journeys implied by declared capabilities.

```text
release set + user choice
          │
          ▼
NemoClaw compiles product intent
          │ one core-owned client boundary
          ▼
OpenShell owns sandbox lifecycle, policy, credentials, and admitted execution
          │ bounded in-sandbox request
          ▼
runtime-control performs one admitted native reconciliation, then exits
```

The helper's response is an executor-claimed result. It becomes an independently observed
postcondition only when a separate observer produces that evidence. Receipts record the evidence
producer and any observation limit. A helper cannot establish support, product authority, or durable
OpenShell state by reporting success.

For V1, invoking package-supplied helper code is always treated as mutation-capable. Read-only
product observations use descriptor-declared probes that trusted NemoClaw or OpenShell code executes
without running the helper. Contract V1 rejects read-only helper operations. A later contract may
consider one only after a named trusted restriction is implemented and qualified; a package
declaration or self-produced digest is not enough.

## Ownership boundary

NemoClaw core owns:

- the product workflow, package selection, support catalogue, and release set;
- generic plan compilation and logical provider selection;
- required-policy compilation and named host routes and ports;
- product-state linkage, rollback decisions, and compatibility migration;
- package ingestion, exact receipts, checked-in support status, and central qualification; and
- one client boundary for all OpenShell operations.

OpenShell owns:

- sandbox lifecycle and durable sandbox state;
- compute dispatch and the effective policy;
- provider and credential custody, binding, and rewrite;
- inference interception;
- supervision of the admitted image entrypoint and sandbox-local process execution; and
- authoritative observations that its pinned release exposes.

Each agent runtime package owns:

- its descriptor, exact image inputs, dependency pins, and shipped-content contract;
- runtime-native configuration, bounded reconciliation, and data-only probe declarations inside its
  image;
- upstream patches, native wrappers, agent-loaded plugins, and compatibility rules;
- its native state schema and migrations; and
- package unit, image, conformance, and runtime-specific integration tests.

The package may declare required access. It cannot widen policy, choose a compute driver, hold an
upstream credential, call OpenShell or a host container engine, supervise the admitted entrypoint,
or publish NemoClaw product state.

One pinned-version exception preserves behavior without broadening the helper contract. OpenShell
`0.0.106` starts and waits for the admitted entrypoint once but does not reproduce the current Deep
Agents Code session cleanup wrapper or the OpenClaw and Hermes descendant restart loops. Those
three existing wrappers move unchanged as package-local compatibility entrypoints. They are not
`runtime-control`, cannot call OpenShell or own sandbox lifecycle, and must be removed after a later
exact OpenShell pin proves the matching cleanup, signal forwarding, restart, health, authenticated
replacement, and final-release behavior through the affected lifecycle E2E matrix.

Messaging stays split at the existing product boundary for V1. NemoClaw keeps channel manifests,
enrollment, logical credential references, required policy, registry state, host forwarding, and
the hooks that execute and interpret status and health probes. OpenShell keeps credentials and
enforcement. A package implements only its runtime-native channel configuration and data-only health
declarations. Hermes Discord provider profiles and endpoint bindings therefore remain core-owned.
Live Telegram, Discord, WhatsApp, and other messaging-account tests are not required for this
migration; deterministic channel tests remain required.

## Why package in-tree first

The current integrations are coupled across `agents/`, `src/lib/`, `scripts/`, `nemoclaw/`, the
blueprint, tests, and release workflows. Moving source and changing distribution at the same time
would combine behavior migration with a new supply-chain and ownership boundary.

The in-tree sequence keeps one repository, one pull request graph, one release set, and one rollback
point while the contract is proved. npm workspaces give every source package a unique identity and
local linking without requiring each workspace to publish through npm. Image-specific lockfiles stay
separate when their build graph must remain independent.

Every package must also pass a deterministic clean-pack test. Developer setup, CLI linking, Git-hook
installation, and package creation are separate operations. The packed file list, modes, digests,
and install result are explicit and tested from the generated archive.

After all three packages pass the complete in-tree release matrix, maintainers can decide whether a
package remains first-party in NemoClaw or becomes an external integration. That later decision must
name repository ownership, trust policy, artifact transport, namespace policy, retention,
revocation, supersession, incident response, and cross-repository qualification. Moving a package
unchanged is then mechanical; it is not part of the initial extraction.

## Current size and refreshed constraints

The inventory audit classified whole files, not lines that can all move unchanged.

| Runtime or deferred workstream | Audited production files / lines | Detailed test files / lines | Dependency-lock files / lines | Main shared-core pressure |
|---|---:|---:|---:|---|
| OpenClaw | 101 / 37,368 | 151 / 56,170 | 6 / 18,920 | Default identity, startup, pairing, Shields, state, MCP, messaging |
| NemoClaw-managed Hermes | 83 / 26,756 | 198 / 53,419 | — | Startup, ports, recovery, MCP, messaging, state |
| LangChain Deep Agents Code | 26 / 11,972 | 61 / 20,943 | 1 / 3,551 | Terminal flow, inference, MCP, probes, rebuild |
| Deferred Hermes Portable and tool broker | 26 / 12,708 | 27 / 9,625 | — | Separate compute, lifecycle, credential, and broker authorities |
| Deferred Pi | 8 / 1,337 | — | 1 / 1,888 | Candidate authority only; packaging deferred |
| Deferred NemoCUA | 3 / 74 | — | — | External prepared image; packaging deferred |

The three standard package commitments account for 627 rows and 229,099 nonblank lines. The full
audit accounts for 692 rows and 254,731 lines. These are whole-file review bounds; the disposition
ledger marks 359 rows `move`, 234 `split`, 98 `keep`, and one `delete`. That delete removes the
OpenClaw plugin's nested workspace lock only after the root workspace lock proves an exact
replacement.

The source refresh at `a5486894c451` adds constraints that the migration must preserve:

- Hermes Discord now requires core-owned provider profiles and exact policy endpoint bindings.
- Replacement and rebuild must wait for affirmative OpenShell lifecycle release before republishing
  provider authority.
- Portable Hermes full-uninstall authority and Amazon Bedrock adapter lifecycle cleanup remain core
  lifecycle work outside the managed Hermes package.
- Pi's accepted candidate trust-boundary check does not authorize Pi packaging or support.
- macOS validation must cover Homebrew formula-reuse trust, and rebuild validation must preserve the
  five-minute OpenClaw doctor timeout.
- `tar` `7.5.21` is part of package and managed-image shipped-content verification, not only a root
  dependency pin.

These are behavior constraints, not reasons to move credential, lifecycle, or provider authority
into a package.

## Delivery sequence

1. **Characterize current behavior, then obtain acceptance.** Record selection, aliases, persisted
   state, every audited candidate, and exact architecture budgets without changing product behavior.
   Then record the product decision, placement, accountable maintainer, owners, and validation plan.
   Discussion 9909 is still Proposed and has no accepted answer.
2. **Make runtime identity explicit.** Preserve legacy `null` OpenClaw reads, but write explicit
   identities and fail closed on unknown recorded identities.
3. **Build the package foundation under `packages/`.** Add unique npm package identities, workspaces,
   the data-only contract, support catalogue, content-addressed local artifact install using the
   reviewed `tar` library, exact receipts, clean-pack tests, and the bounded non-supervising helper
   protocol.
4. **Move LangChain Deep Agents Code.** It proves terminal-agent behavior without moving the default
   first.
5. **Move managed Hermes.** It proves an agent runtime that runs an agent gateway, including native
   dashboard, MCP, channel rendering, state, and recovery behavior. Portable Hermes and the tool
   gateway broker stay out of this package.
6. **Freeze the common contract.** Keep only behavior proven by both representative runtimes and
   remove their core name-based executable dispatch.
7. **Move OpenClaw.** Relocate its runtime assets and existing OpenClaw plugin under the package root
   while preserving OpenClaw as the first and default selection.
8. **Qualify one complete in-tree release.** Run deterministic, package, exact-image, Ubuntu, macOS,
   WSL, multi-architecture, and Brev tests without live messaging accounts. Preserve prior-release
   upgrade and rollback.
9. **Decide externalization separately.** Only after the in-tree release qualifies may maintainers
   authorize external repositories or PyPI or OCI transport.
10. **Maintain continuous compatibility.** Required compatibility checks and maintainer review
    protect each checked-in release-set update.

Pi, NemoCUA, portable Hermes, the Hermes tool gateway broker, package activation, package removal,
registry search, and live messaging qualification are not commitments in this sequence.

## Level of effort

These ranges are decision estimates, not additive commitments.

| Outcome | Estimate |
|---|---:|
| Decision packet, behavior baseline, and ownership classification | 3–5 engineer-weeks |
| Package foundation and two representative in-tree pilots | 30–45 engineer-weeks |
| Extract and qualify the three standard managed runtimes in-tree | 58–91 engineer-weeks |
| Later external distribution and continuous cross-repository qualification | 12–24 engineer-weeks after the in-tree release |

The original full-surface estimate of 70–110 engineer-weeks included Pi, NemoCUA, portable Hermes,
the Hermes broker, public transport, and cleanup controls that are now deferred. The first supported
milestone is narrower: three standard in-tree packages with no user-experience change.

## Acceptance bar

The in-tree migration is complete only when:

- the three standard entries come from one exact support catalogue and normal installation does not
  preload every image;
- current labels, order, default, prompts, flags, environment input, launchers, persisted-state
  behavior, and sandbox results remain compatible;
- `nemoclaw harness install <local-artifact>` is atomic, idempotent, content-addressed, and executes
  no package code on the host;
- a compatible local package remains list-only unless a separate support decision admits it;
- runtime-control operations are bounded, non-supervising, and mutation-capable; their output is
  always an executor claim, and separate core or OpenShell evidence supplies independent observations;
- no package can call OpenShell, a compute backend, or a host container engine, and core uses one
  OpenShell client boundary;
- OpenShell remains authoritative for lifecycle, state, policy, credentials, inference
  interception, and canonical supervision;
- all three packages pass deterministic tests, the accepted no-messaging Ubuntu lifecycle, and
  exact multi-architecture image qualification; the Apple silicon macOS OpenClaw journey on Docker
  Desktop or Colima passes install, onboard, inference, restart reconciliation, receipt, and cleanup;
  and WSL checks and the official staging Brev default-OpenClaw journey pass on the required exact
  package, image, OpenShell, driver, and capability identities; and
- upgrade, rebuild, restore, recovery, revocation, supersession, and rollback leave the last proven
  state authoritative on failure.

Repository handoff is not part of that acceptance bar. The qualified in-tree release must exist
first.
