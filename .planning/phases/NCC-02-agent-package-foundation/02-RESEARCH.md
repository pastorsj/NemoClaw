<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Research: Agent Package Foundation

**Researched:** 2026-08-27
**Source baseline:** `origin/main` at `d0d5120cc6d574a5575b322b79b7cd49ca7c269d`
**Research status:** Complete for planning; implementation still requires the product-scope decision

## Summary

The smallest useful Phase 2 is an agent-specific package boundary around the current
`AgentDefinition`, not a general plugin SDK. It adds a closed data envelope, hostile-tree
validation, immutable local storage, two public commands, and exact package identity in the current
onboarding transaction. It does not load package code on the host and does not change OpenShell's
authority.

The current tree cannot honestly produce fully independent package repositories in this phase.
OpenClaw still depends on root Dockerfiles, scripts, policy, and plugin paths; other harnesses still
have host behavior in core. A temporary build-time adapter can copy the complete reviewed local
asset subset into a package-root-shaped bundled artifact. Phase 2 then uses that installed root for
manifest-derived paths and image build context, so selection is not cosmetic, while host behavior
that remains statically linked into NemoClaw is still outside the package digest. The digest must
therefore not be described as complete runtime provenance. Phase 3 owns full self-containment and
the physical source/test move.

### Latest-main reconciliation

The final planning refresh rebased onto `d0d5120cc6`. The upstream durable-authority change added
an independent retained-sandbox recovery record and made post-create cancellation/failure
recovery-only: same-name resume, reuse, recreation, and fresh onboarding are intentionally blocked.
Phase 2 therefore binds package identity into that independent record and does not revive the older
resumable-cancellation behavior. Migration audit metadata remains only on owning Session and
SandboxEntry state.

The same refresh added inactive Windows MXC observation/onboarding. MXC remains a runtime-provider
and host-platform concern, not an agent package; Phase 2 preserves its inactive path through the
existing provider contracts and aggregate tests. It also bound revisioned messaging credentials to
canonical OpenShell providers. Plans 20 and 21 therefore replace OpenClaw null-sentinel decisions
with explicit effective-agent identity while preserving credential-family, provider-attachment,
inactive-preset, and exact custom-policy behavior in deterministic tests. The refreshed E2E
host-command regression exposes a sanitized-PATH failure in `ShellProbe`. Plan 22 repairs that
shared boundary before using `HostCliClient` for PATH-resolved `nemoclaw harness` commands, without
inheriting ambient secrets or importing CLI source.

## Current Code Evidence

### Agent discovery and loading

| Concern | Current owner | Consequence for Phase 2 |
|---|---|---|
| Available agent names | `listAgents()` in `src/lib/agent/defs.ts` scans `agents/*/manifest.yaml` | Separate reviewed availability from installed selectability. |
| Typed agent contract | `AgentDefinition` in `src/lib/agent/definition-types.ts` | Add package identity around this contract; do not replace it. |
| Manifest loading | `loadAgent()` in `src/lib/agent/defs.ts` builds definitions against static `AGENTS_DIR` and `ROOT` | Extract one root-parameterized definition builder; repository and receipt-verified package paths must both call it. |
| Image/build context | `src/lib/agent/base-image.ts` and sandbox-create orchestration default to repository `ROOT` | Carry the selected package root on `AgentDefinition` and use it for every package-derived image/build-context operation. |
| OpenClaw legacy assets | `_legacy_paths` in `agents/openclaw/manifest.yaml` | Keep a temporary build-time mapping and remove it in Phase 3. |
| Candidate gates | `src/lib/agent/candidate.ts` and CUA feature gates | Pi and NemoCUA cannot become ordinary available packages accidentally. |
| Compatibility list | `src/lib/agent/list-command.ts`, `src/commands/agents/list.ts` | Keep the command and text, but source entries from installed packages. |

`getAgentChoices()` currently puts OpenClaw first and skips malformed non-default manifests.
`resolveAgentName()` resolves flags, environment, session, then OpenClaw. Installed-only selection
must preserve ordering and aliases while removing repository-directory presence as activation
authority.

### Onboarding and durable state

| Boundary | Current owner | Required package behavior |
|---|---|---|
| User selection | `src/lib/onboard/agent-selection.ts` | Zero/one/many behavior comes from installed packages. |
| Writer lock and session | `src/lib/state/onboard-session.ts` | Commit exact identity before external mutation. |
| Session bootstrap | `src/lib/onboard/session-bootstrap.ts` | Legacy migration and resume validation happen inside the lock. |
| Checkpoint | `src/lib/state/onboard-checkpoint-types.ts` and migration helpers | Carry an optional normalized identity for old state and require it for new state. |
| Recreate | `src/lib/onboard/onboard-recreate-journal.ts` | Include identity in the target fingerprint and retry authority. |
| Route transaction | `src/lib/state/registry/route-reservation.ts` | Reject a retry whose package identity differs. |
| Policy boundary | `src/lib/state/registry/pending-policy-verification.ts` and registry types | Bind policy source to the same package identity. |
| Final registry | `src/lib/state/registry/types.ts` and registration code | Publish only when every earlier identity agrees. |
| Cancellation | `src/lib/onboard/cancel-rollback.ts` | Preserve created incomplete state and referenced bytes. |
| Snapshot restore/clone | `src/lib/actions/sandbox/snapshot.ts` and `snapshot/restore-authority.ts` | Validate source and target identity before forced destination deletion or Shields mutation; clones inherit source authority. |
| Backup authority | `src/lib/actions/sandbox/snapshot/backup-authority.ts` | Receive the already pinned definition and revalidate before publication rather than calling ambient `loadAgent()`. |
| Rebuild manifest | `src/lib/state/sandbox.ts` | Persist the exact package identity used by prepared recovery and restore. |
| Prepared rebuild deletion | `src/lib/actions/sandbox/rebuild-prepared-recovery.ts` | Compare manifest, registry, and pinned package at preflight and immediately before deletion. |
| Rebuild consumers | target config, flow helpers, post-restore, messaging, GPU opt-out, and DCode preflight | Resolve the definition once and carry it instead of reloading by agent name. |

The session already has a cross-process lock, schema normalization, checkpoint snapshots, and a
state machine. A second package transaction or cross-component receipt would duplicate authority.
The new field belongs in the existing session and must be propagated through the existing recovery
records.

### Installer and upgrade

`scripts/install.sh` currently prepares the CLI, defers OpenShell installation, backs up existing
sandboxes through `nemoclaw backup-all`, updates OpenShell, and then onboards. It also preserves
`NEMOCLAW_AGENT`, aliases, fresh installs, resume, and strict backup failures.

The safe insertion point is after the current/new NemoClaw CLI is available and before pre-upgrade
backup:

```text
prepare CLI
→ ask TypeScript for required current/resume/legacy harness identities
→ reconcile reviewed bundled objects and receipts
→ strict backup-all
→ update OpenShell
→ normal installed-harness selection and onboarding
```

Shell must not parse session or registry JSON, reproduce catalogue logic, or copy package trees.
That logic stays in a typed internal planner/service used by both the public command and installer.

### Existing test architecture

`vitest.config.ts` defines disjoint `cli`, `integration`, `installer-integration`,
`package-contract`, `plugin`, `e2e-support`, and `e2e-live` projects. Phase 2 adds TypeScript unit
tests beside new `src/` code, installer behavior to the existing installer projects, compiled
command checks to `test/package-contract`, and fixture/planner checks to `e2e-support`.

The existing typed E2E registry and shared workflow planner remain authoritative. Direct target
execution and a second registry are not acceptable. A local Mac or operator-supplied Brev run can
prove development behavior; exact staging Launchable retains release authority.

## Preserved Prototype Findings

The preserved branch contains useful behavior in `src/lib/harness/package-registry.ts` and
`src/commands/harness/*`, but the registry grew to roughly 1,389 lines and included a CommonJS host
runtime loader. Port behavior, not structure:

- Preserve bounded reads, no-follow file handling, stable digesting, atomic receipt writes, identity
  conflict checks, command names, and installed/available inventory.
- Replace the monolith with focused files under `src/lib/harness/`.
- Do not port arbitrary CommonJS loading or any package host callback.
- Do not mechanically merge the preserved branch; it conflicts heavily with current source and test
  architecture.

## Proposed Package Contract

### Envelope

Every reviewed artifact contains `nemoclaw-package.json` at its root:

```json
{
  "schemaVersion": 1,
  "kind": "agent-runtime",
  "id": "openclaw",
  "displayName": "OpenClaw",
  "packageVersion": "0.1.0",
  "contractVersion": 1,
  "manifest": "agents/openclaw/manifest.yaml"
}
```

The parser is closed: unknown keys, unknown versions, malformed IDs, unsafe paths, and an identity
mismatch between the envelope and manifest fail. The public contract contains no legacy source-map
fields and no executable host entry point. `packageVersion` is the independently managed SemVer of
the NemoClaw harness adapter. It is not the manifest's `expected_version`, which describes the
separately versioned upstream agent binary installed in the sandbox.

### Exact identity

The durable selection record is deliberately small and secret-free:

```ts
interface HarnessPackageIdentity {
  kind: "agent-runtime";
  id: string;
  packageVersion: string;
  contractVersion: 1;
  contentDigest: string;
}
```

Source identity, installation time, and future trust evidence belong in the installation receipt.
Credentials, executable objects, and ambient paths do not.

Within one store, `(kind, id, packageVersion, contractVersion)` binds to one content digest. Changed
package bytes require a new adapter package version, even when the upstream agent runtime version is
unchanged.

### Store

Keep storage agent-specific until a second component kind proves the same need. The production root
is the global base-state path `~/.nemoclaw/harnesses/`, not a gateway-port-scoped sandbox state path;
changing `NEMOCLAW_GATEWAY_PORT` must not change installed inventory:

```text
~/.nemoclaw/harnesses/
├── objects/
│   └── sha256/<digest>/
├── active/
│   └── <id>.json
├── receipts/
│   └── <id>/sha256/<digest>.json
└── staging/
```

Installation order is validate source, copy to a private stage, verify copied bytes, publish the
immutable object, write the immutable receipt, then replace the active pointer atomically. Every
read verifies pointer, receipt, envelope, and object digest. Failure leaves the previous pointer
usable. An active pointer contains only schema, ID, and digest; active and pinned reads derive the
receipt address directly without scanning. Reinstalling exact content verifies and reuses the
existing receipt rather than changing its first installation time or source identity. Phase 2
retains all objects and receipts indefinitely.

### Reviewed bundled catalogue

Only OpenClaw, Hermes, and LangChain Deep Agents Code are proposed as ordinary available packages.
A build-time adapter creates their reviewed artifacts from the current source layout. The adapter is
the only named-harness mapping added to core, is marked for deletion in Phase 3, and does not appear
in the public envelope. Its explicit destination map recreates the minimal root-shaped layout used
by each current manifest, local Dockerfile `COPY`/`ADD`, start script, policy, and plugin path.
Plans 02-10 and 02-11 pass the receipt-verified installed object root through `AgentDefinition` and
use that root as the image build context; they must not fall back to the checkout root after package
selection.
This makes the bundled artifact operational without claiming that the still-core host orchestration
or remote upstream downloads are package-owned.

The catalogue represents these different states separately:

- available in the current reviewed NemoClaw build;
- installed as a verified immutable object;
- selected for a new session;
- active for one sandbox;
- qualified and supported by a release set.

Installation alone does not imply the later states.

The current Hermes and LangChain Deep Agents Code Dockerfiles copy all of
`nemoclaw-blueprint/`. Phase 2 therefore permits that exact reviewed shared/mixed tree in their
transitional artifacts, includes it in each package digest, and records it in the source mapping.
This is a disclosed temporary build dependency, not package self-containment. Arbitrary sibling
harness roots and undeclared repository content remain excluded; Phase 3 narrows or moves the shared
input when canonical package roots become authoritative.

## Package Tree Threat Analysis

The source and destination are filesystem trust boundaries. Validation must reject or bound:

- absolute paths, `..`, empty components, NULs, alternate separators, case-folded duplicates, and
  ambiguous Unicode path forms;
- symbolic links, hard links, sockets, devices, FIFOs, sparse files, and unknown types;
- ownership by any UID other than the current effective UID, except root-owned read-only reviewed
  input accepted by a non-root process only when every checked ancestor is also safe; group/world-
  writable files, unsafe executable modes, and unsafe ancestors are rejected regardless of owner;
- too many entries, excessive depth, path length, metadata size, file size, or total bytes;
- source changes between inspection and copy, including inode, device, mode, size, timestamps, and
  replacement of the source or state root;
- digest, envelope, receipt, active-pointer, and object identity disagreements;
- control characters in display metadata and credential-shaped fields in durable records.

The content digest includes normalized relative path, entry type, executable mode, byte length, and
bytes in deterministic order. Validation or installation never imports a module, runs npm/pip, runs
an install script, evaluates a template, or invokes package code.

## Onboarding Rules

### Fresh runs

1. For a standard package-managed run, resolve only installed, verified, selectable packages.
2. Apply zero/one/multiple and interactive/non-interactive selection rules.
3. Resolve the exact object behind the active pointer.
4. Build `AgentDefinition` through the one shared builder using the installed object's manifest and
   package root, and route package-derived paths and image context through that root.
5. Under the existing writer lock, write agent ID and package identity together.
6. Re-read and verify the object and session identity before each existing mutation boundary that
   can be resumed independently.

### Resume and recovery

- For package-managed state, the session digest wins over the active pointer.
- A new `--agent` or environment value must match the recorded ID; it cannot change a resume.
- Missing or damaged pinned bytes stop before mutation; no OpenClaw fallback is permitted.
- Recreate fingerprint, route reservation, pending policy verification, and final registration carry
  the exact same identity.
- Policy input is read from the receipt-verified object and its digest is checked again at the
  pending verified-create boundary.
- Cancellation or failure after create retains the incomplete sandbox, recovery-only Session,
  registry row, independent retained record, and package object. The retained record carries exact
  package identity only; same-name onboarding remains blocked.
- Qualified Pi and NemoCUA resume, backup, and rebuild through their existing gated authority and do
  not receive package identity.

### Legacy state

Old session and registry files remain parseable because the new fields are optional during
normalization. Before an old package-managed record drives backup, rebuild, or resume, one shared
`harness-migration.ts` service runs beneath the onboarding writer lock. Direct onboarding prepares
the mapping without durable writes, allows portable retirement to recover the original owner bytes,
and commits inside the recovered operation. Installer reconciliation commits before backup because
it has no portable-retirement wrapper. The commit order is:

```text
use prepared legacy-agent mapping
→ install/verify reviewed current object under the package lock
→ re-read the exact object and receipt
→ compare-and-swap the same owner's optional Session
→ update that owner's matching SandboxEntry under the registry lock
```

An owner group contains a Session and registry row only when `session.sandboxName` equals the row
name. A standalone Session and every other registry row are independent owners; different owners
may retain different valid package identities and migration times. Session and `SandboxEntry`
owners receive the exact `harnessPackage` plus an optional closed,
secret-free `harnessPackageMigration` record with schema version 1, source
`legacy-current-bundle`, prior agent value, and migration time. The migration record is audit
metadata, not part of package identity or the installation receipt. Every partial-crash ordering is
idempotent and converges on retry. Direct resume and installer reconciliation call the same service;
malformed present identity never enters legacy migration. The mapping records current provenance;
it does not invent which old bytes created the sandbox. Pi and NemoCUA retain their existing gated
candidate authority and receive neither package identity nor migration metadata.

Installer reconciliation additionally associates each retained-sandbox recovery record with only
its same-name registry owner. A legacy retained record gains identity only after that registry owner
is exact; it never receives migration audit metadata. An orphaned, malformed, or mismatched record
stops the installer before backup rather than following the active pointer.

## Plan Decomposition

| Plan | Capability | Why separate |
|---|---|---|
| 02-01 | Product decision | Repository policy forbids implementation without it. |
| 02-02 | Envelope and hostile-tree validation | Returns validated envelope/manifest data; it does not duplicate agent-definition construction. |
| 02-03 | Exact receipts, immutable store, install transaction | Establishes one exact reusable service. |
| 02-04 | Reviewed bundle and catalogue | Keeps temporary named source mapping out of commands and storage. |
| 02-05 | Inventory and `harness list` | Read-only UX over the completed catalogue. |
| 02-06 | `harness install`, prompt, docs, compiled dispatch | One public mutation command and its user-visible contract. |
| 02-07 | `agents list` compatibility | Keeps the existing compatibility command separate from the new package command. |
| 02-08 | Session identity and checkpoint schema | Adds strict optional identity, migration audit metadata, and the explicit v4-to-v5 checkpoint migration. |
| 02-09 | Registry and pending-state schema | Adds the same optional fields to current route and policy owners. |
| 02-10 | Agent definition authority | Extracts one root-parameterized builder while preserving OpenClaw's `agent === null` compatibility sentinel. |
| 02-11 | Package-root image context | Removes checkout-root authority from package-derived image and build operations. |
| 02-12 | Installed-package selection | Proves zero, one, many, non-interactive, and explicitly qualified candidate behavior with private fixtures. |
| 02-13 | Writer-lock binding and legacy migration | Proves package authority read-only, runs portable recovery over old owner bytes, then commits fresh or migrated identity inside the recovered operation. |
| 02-14 | Resume conflict and pointer stability | Stops drift before any resume mutation and keeps candidate authority intact. |
| 02-15 | Route, policy, and create propagation | Carries identity through the pre-create mutation boundaries. |
| 02-16 | Recreate and checkpoint propagation | Makes resumable recovery records identity-aware. |
| 02-17 | Registration and recovery-only cancellation | Publishes exact final identity and binds the independent retained record without enabling same-name onboarding. |
| 02-18 | Installer reconciliation | Converges legacy owners before strict backup and preserves fresh installer behavior. |
| 02-19 | Snapshot manifest, backup, restore, and clone | Persists exact manifest identity before restore consumes it and verifies pinned package authority before lifecycle mutation. |
| 02-20 | Prepared rebuild recovery and target context | Revalidates manifest, registry, object, and definition authority before deletion and carries one target authority forward. |
| 02-21 | Downstream rebuild consumers | Carries one pinned definition through every later rebuild stage. |
| 02-22 | Typed E2E package fixture | Repairs the sanitized host PATH boundary, installs the target package, and proves receipt/session/registry equality through the existing planner. |
| 02-23 | Qualification | Aggregates deterministic and bounded Mac/Brev development evidence. |

## Validation Architecture

### Deterministic lanes

| Behavior | Lane | Evidence |
|---|---|---|
| Envelope parsing and negative fixtures | `cli` | Focused co-located TypeScript tests. |
| Hostile tree, digest, store, failure injection | `cli` | Temporary roots with no-follow checks and concurrent replacement fixtures. |
| Command metadata and direct behavior | `cli` | Oclif leaf-command tests plus display metadata tests. |
| Built and packed command/artifact presence | `package-contract` | Compile first; spawn the built launcher/controlled `nemoclaw` shim for dispatch and inspect `npm pack --dry-run --ignore-scripts --json`. |
| Session, checkpoint, registry, route, policy, recreate | `cli` | Existing state and onboarding test helpers. |
| Real `install.sh` process behavior | `installer-integration` | Spawn installer with isolated HOME and mocked external tools. |
| E2E package fixture/planner changes | `e2e-support` | Existing typed onboarding fixture installs the reviewed package and asserts receipt/session/final-registry equality without a second registry. |

Every task has a focused command. Every wave ends with the affected projects. The phase ends with
`npm test`, CLI type checking, repository checks, and package-contract coverage.

### Live lanes

Live validation is limited to behavior that needs real process, filesystem, OpenShell, Docker, or
sandbox boundaries:

- macOS development journey: empty list, no-harness stop, install OpenClaw, automatic selection,
  install Hermes, interactive picker, and a normal no-messaging lifecycle;
- Linux/Brev development journey: install, complete one no-messaging sandbox, run inference,
  backup, and rebuild, then use a separate final sandbox to prove recovery-only post-create
  cancellation and same-name refusal. The existing typed resume target and deterministic tests
  prove ordinary resumable-session and active-pointer-advancement invariants because Phase 2
  exposes one reviewed version of each bundled harness;
- exact staging Launchable remains the release lane and is not replaced by either development run.

Do not add a live target if the existing target catalogue can express the missing behavior. Do not
add live Telegram, Discord, WhatsApp, WeChat, or other messaging credentials.

### Failure evidence

Tests assert state, receipts, object digests, mutation call counts, and redacted diagnostics rather
than prompt layout, spinner frames, timing, or incidental output. Package and identity failures must
show the exact boundary that stopped and must prove that the next external mutation was not called.

## Execution Risks

| Risk | Mitigation |
|---|---|
| Transitional package is mistaken for full runtime provenance | State the limitation in the accepted decision, receipts, and docs; finish self-containment in Phase 3. |
| Installed manifest still builds from checkout bytes | Carry one validated package root through `AgentDefinition`, base-image resolution, and sandbox build orchestration; reject missing local dependencies instead of falling back to repository `ROOT`. |
| OpenClaw null sentinel changes established branches | Keep `agent === null` for compatibility while carrying a separate exact effective definition and package authority. |
| Package parser becomes an executable plugin API | Closed data schema; no entry point or callback field; negative tests. |
| State identity is added only at final registration | Schema plan precedes orchestration; propagation invariant covers every intermediate authority. |
| Resume follows a newer pointer | Session identity is authoritative and store reads accept an explicit digest. |
| Installer duplicates package logic | Shell calls stable machine-facing TypeScript behavior. |
| Legacy migration silently changes harness or only updates one owner | One shared idempotent service, deterministic lock order, current-bundle audit provenance, session CAS, locked registry updates, and partial-crash convergence tests. |
| Candidate state is forced into the package contract | Qualify exact-identity statements as package-managed and preserve Pi/NemoCUA gates without fabricated identity. |
| Manual runs are mistaken for automated E2E | Wire exact package installation and identity assertions into the existing typed fixture; label Mac/Brev source-overlay journeys as development evidence only. |
| Object deletion breaks recovery | No package GC in Phase 2. |
| Test plan duplicates central E2E | Use the current typed registry and planner only. |

## Open Gate

The technical plan is complete, but `GOV-01` is not. Plan 02-01 is therefore a blocking human
decision. If the accepted decision requires complete package-owned runtime provenance in Phase 2,
the phase must be re-planned to pull the first full harness extraction forward rather than labeling
the transitional artifact as self-contained.
