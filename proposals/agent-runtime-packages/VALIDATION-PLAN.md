<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Validation Plan

> **Status:** Proposed. The accountable validation and release owners are unassigned.

## Evidence identity

Every release-gating result must bind the tested NemoClaw commit, release-set digest, exact package
archive and tree digests, descriptor digest, OCI index and selected platform digest, OpenShell
version and capability cohort, driver and host platform, helper protocol, suite version, run and
attempt, evidence producer, observation limits, redaction result, and terminal cleanup. A package's
own test or helper result is a publisher or executor claim until a separate core, OpenShell, or
functional probe observes the asserted outcome.

## Gates

| Gate | Requirement and owner | Environment | Command or target | Entry condition | Accepted evidence | Failure action | Release effect |
|---|---|---|---|---|---|---|---|
| Scope and baseline | Product and compatibility owners — unassigned | Source checkout | Phase 1 characterization suites and inventory validators | Refreshed upstream revision | Current menu, aliases, legacy state, exact dispositions, and architecture baseline | Revise proposal or inventory | May run before acceptance; blocks Phase 2 and package work until accepted. |
| Package foundation | Contract, CLI, and security owners — unassigned | Ubuntu and macOS deterministic CI | `npm run test:fast`, `npm run test:integration`, `npm run test:package`, workspace build/typecheck/conformance | Accepted product decision | Hostile descriptor/archive fixtures, one root workspace lock, isolated runtime-image locks, packed-root install, unchanged catalogue and onboarding | Keep current integrations authoritative | Blocks runtime extraction. |
| Local artifact ingestion | CLI and security owners — unassigned | Temporary user state on Ubuntu, macOS, and WSL | Focused installer, archive, store, and CLI tests | Contract and reviewed `tar@7.5.21` dependency | Path, link, special-file, expansion, collision, digest, interruption, and idempotence outcomes | Commit no package record | Blocks `harness install`. |
| Deep Agents Code package | Package owner — unassigned | Source workspace envelope and packed consumer outside checkout; Ubuntu live lifecycle | Package build, typecheck, unit, conformance, build-input closure, package-contract, `ubuntu-repo-cloud-langchain-deepagents-code`, managed-image activation, the `mcp-bridge` Deep Agents shard, and the new snapshot variant | Foundation passes | `nemoclaw harness install` and installed-package discovery, onboard, inference turn, terminal connect, MCP, restart, snapshot/restore, successful and rejected rebuild, cleanup | Keep legacy Deep Agents Code path | Blocks first pilot completion. |
| Managed Hermes package | Package owner — unassigned | Source workspace envelope and packed consumer outside checkout; Ubuntu live lifecycle | Package build, typecheck, unit, conformance, build-input closure, deterministic messaging, `hermes-e2e`, managed-image activation, `rebuild-hermes`, and the new snapshot variant | Deep Agents Code pilot passes | `nemoclaw harness install` and installed-package discovery, managed startup, inference, dashboard/API, cron, MCP, native channel render, restart, snapshot/restore, rebuild, cleanup | Keep legacy managed Hermes path | Blocks Contract V1. |
| Contract V1 | Contract and security owners — unassigned | Deterministic package-contract and E2E-support lanes | Shared two-pilot conformance and hostile-input matrix | Both pilots pass through production lifecycle | Only `reconcile-native` and `prepare-native-state` remain if both pilots prove them; every helper invocation is mutation-capable; V1 has no read-only helper operation; timeouts, replay, redaction, unknown-operation rejection, out-of-scope mutation rejection, interruption, and rollback pass | Revise or reduce contract | Blocks OpenClaw extraction. |
| OpenClaw package | Package and plugin owners — unassigned | Source workspace envelope and packed consumer outside checkout; Ubuntu no-messaging lifecycle | Package/plugin build, unit, package-contract, build-input closure, deterministic messaging, `ubuntu-repo-cloud-openclaw`, `full-e2e`, managed-image activation, `rebuild-openclaw`, and `snapshot-commands` | Contract V1 frozen | `nemoclaw harness install` and installed-package discovery, default selection, pairing, Shields, MCP, native messaging, inference, restart, snapshot/restore, rebuild, cleanup | Keep legacy OpenClaw paths and default | Blocks in-tree release. |
| Deterministic release | Release and E2E owners — unassigned | Ubuntu 26.04, macOS, WSL | `npm test`, `npm run check`, package clean-pack tests, `CI / Platform Evidence` | All packages extracted | Same packed catalogue, package suites, state upgrade/rollback fixtures, explicit unsupported-host records | Block release-set change | Required but does not by itself publish `Release qualification`. |
| Revocation and supersession | Product, security, incident, and release owners — unassigned | Deterministic release-set fixtures on Ubuntu, macOS, and WSL; protected release workflow | Table-driven static release-set tests and one release rollback exercise | Exact qualified tuple and reviewed proposed status change with owner, trigger, effects, replacement, and rollback tuple | `supported`, `revoked`, and `superseded` fixtures preserve the immutable qualification reference; affected new selection, rebuild, restore, and recovery fail closed; running sandboxes are not silently replaced; the rollback tuple remains available | Block the release-set change and release; retain the last released rollback tuple | Required for the first support decision and each later revocation or supersession. |
| Real Apple silicon macOS | E2E owner — unassigned | User-controlled Apple silicon macOS host with Docker Desktop or Colima | `full-e2e.test.ts` through `tools/e2e/live-vitest-invocation.mts`, extended with exact package receipt checks | Exact candidate built; Homebrew/OpenShell access; inference key | Install, trusted Homebrew reuse, default onboard, inference, restart reconciliation, receipt, cleanup | Retain candidate; collect redacted diagnostics | Required release input; hosted optional-Docker target cannot satisfy it. |
| Multi-architecture images | Image and E2E owners — unassigned | Native `linux/amd64` and `linux/arm64` runners | Existing `managed-image-multiarch-startup` job extended for all three exact images | Exact image cohort published | Six package/architecture startup cells with index/platform digest, readiness, receipt, cleanup | Block release | Required release input. |
| Brev release journey | E2E and release owners — unassigned | Official staging Brev Launchable, CPU, baked candidate | `staging-brev-launchable` in the manual `.github/workflows/e2e.yaml` run | Maintainer authorizes run and cost; the exact candidate is on an `NVIDIA/NemoClaw` source branch or `main` | Default OpenClaw, hosted inference, exact candidate identity, no messaging, cleanup | Destroy instance and block release | Required release input. A generic Brev VM is not a release target. |
| Full release decision | Accountable maintainer — unassigned | Protected GitHub Actions | Full manual `.github/workflows/e2e.yaml` release qualification | Deterministic, macOS, lifecycle, multi-architecture, and Brev evidence agree | One redacted evidence set for the same candidate and rollback tuple | Reject or defer; do not release, and do not merge a still-open upstream candidate | Authorizes only the accepted in-tree release. |
| External handoff | Future owners — not authorized | Independent repositories plus central NemoClaw qualification | Exact package reproduction and proposed release-set pull request | Separate accepted external-integration decision | Canonical package tree unchanged; exact transport/provenance; central rerun | Keep in-tree or last released tuple | Later phase only. |
| Continuous update | Compatibility and release owners — unassigned | Package repositories and NemoClaw CI | Required package, provider, messaging-render, OpenShell, and release-set checks | Exact proposed tuple | All required checks and review on the release-set pull request | Block merge or release; retain rollback tuple | No custom promotion service or eligibility store. |

## Lifecycle assertions for each standard package

The central package journey covers package availability, onboard, one observable inference turn,
connect or gateway interaction, restart, snapshot, restore, rebuild, and cleanup. It asserts durable
outcomes rather than terminal wording. Upgrade fixtures cover legacy `null` OpenClaw state, explicit
runtime identities, prior package receipts, interrupted replacement, and rollback. Package
availability, sandbox deletion, snapshot retention, and durable-state deletion remain separate
decisions.

Current live coverage does not yet satisfy that complete matrix. Managed-image activation proves
onboard, inference, gateway restart, and cleanup for all three runtimes. It uses a test-only managed
image catalogue and records a managed-image workload receipt. It does not run `nemoclaw harness
install` or prove installed-package discovery. The current rebuild tests prove successful rebuild
for OpenClaw and Hermes. The `mcp-bridge` Deep Agents shard proves successful Deep Agents Code
rebuild and a post-rebuild tool call. The Deep Agents Code typed lifecycle separately proves that an
invalid credential stops rebuild before destructive work. The snapshot command test proves only the
OpenClaw snapshot and restore journey. The migration must add these missing semantic dimensions
through the existing E2E catalogue and workflow planner:

- `nemoclaw harness install`, `nemoclaw harness list`, and ordinary installed-package discovery for
  all three standard packages;
- managed Hermes snapshot and restore;
- Deep Agents Code snapshot and restore; and
- a cross-platform restart and reconciliation assertion in the existing macOS-capable `full-e2e`
  journey.

The snapshot cases may share or parameterize current lifecycle code. Release qualification reuses
the current Deep Agents Code MCP rebuild result. The changes must not create a second target
registry, workflow planner, or general-purpose full-lifecycle executor. `suiteIds` remain metadata
and cannot satisfy a lifecycle obligation without an executed result.

## macOS access requirements

The required Mac should provide Apple silicon, a current supported macOS version, Docker Desktop or
Colima with at least 4 vCPU, 16 GiB memory, and 40 GiB free disk for the OpenClaw image and sandbox,
Homebrew, Node.js 22.19 or the repository-pinned newer version, the repository checkout, OpenShell
installation access, and an `NVIDIA_INFERENCE_API_KEY`. The executor needs shell access and
permission to create and remove Docker images, OpenShell sandboxes, local state, and temporary
files. No messaging account or messaging credential is required.

## Brev access requirements

Release evidence uses the repository-owned staging Launchable job against a baked candidate. It
requires an authorized maintainer to dispatch the protected workflow, approve Brev cost, and make
the repository's inference secret available through the existing workflow. The plan does not add a
generic Brev source-install lane. The current trusted controller accepts an exact pre-merge
Launchable candidate only from a branch in `NVIDIA/NemoClaw`; it does not run that secret-bearing
job directly from a contributor fork. A maintainer must either mirror the exact commit to an
upstream candidate branch or run the exact merged `main` revision before release. A user-provided VM
cannot replace `staging-brev-launchable` or the full manual release qualification check.

## Messaging combinatorial gap

Live Telegram, Discord, Slack, WhatsApp, WeChat, Microsoft Teams, and Google Chat qualification is
excluded because accounts and credentials are unavailable. This does not remove existing
deterministic OpenClaw and Hermes enrollment, policy, credential-placeholder, native-render, health,
inactive-channel, rollback, and leak tests. Deep Agents Code continues to reject messaging before
mutation. Live messaging may be added only through a later accepted plan with account and credential
custody.
