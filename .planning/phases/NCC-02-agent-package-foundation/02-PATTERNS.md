<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Patterns: Agent Package Foundation

**Mapped:** 2026-08-27

## Target File Story

`src/lib/harness/` tells the package workflow without containing a catch-all registry:

```text
package-types.ts      shared envelope, identity, receipt, and inventory types
package-manifest.ts   bounded parsing and cross-file identity validation
package-tree.ts       hostile filesystem validation, copy, and deterministic digest
bundled-source.ts     temporary reviewed source-to-artifact mapping
package-receipt.ts    strict digest-addressed receipt and active-pointer records
package-store.ts      immutable objects and verified reads
package-install.ts    one install transaction used by CLI and installer
package-catalog.ts    reviewed available artifacts and installed inventory
package-list.ts       stable text and machine inventory rendering
package-prompt.ts     interactive uninstalled-package choice
package-identity.ts   strict durable identity normalization and comparison
```

One state service owns legacy standard-harness migration instead of putting migration branches in
the installer and onboarding separately:

```text
src/lib/state/harness-migration.ts   idempotent session and registry owner migration
```

The command layer stays thin:

```text
src/commands/harness.ts
src/commands/harness/list.ts
src/commands/harness/install.ts
```

Agent construction also has one named home rather than being copied into the package parser:

```text
src/lib/agent/definition-loader.ts   build AgentDefinition from validated manifest data and an explicit package root
```

## Existing Patterns to Reuse

### Oclif topic and subcommands

- `src/commands/agents.ts` is the closest topic-command pattern.
- `src/commands/agents/list.ts` is the closest read-only leaf command.
- `src/commands/credentials/add.ts` and `src/commands/inference/set.ts` show parsed mutation commands.
- `src/lib/cli/public-display-defaults.ts` owns stable public display metadata.

New commands should extend `NemoClawCommand`, declare an exact `static id`, call `this.parse()`, and
delegate behavior to `src/lib/harness/`. They should not read the filesystem store directly.

Keep discovery, help display, and process dispatch distinct. Oclif metadata and global route tokens
own the `harness` topic. `COMMANDS` is a display projection and contains the `harness:list` and
`harness:install` leaves, not an extra root-topic row. Unit tests cover command behavior; package-
contract tests spawn the built launcher/controlled `nemoclaw` shim for both leaves. Public command
headings and usage also belong in `docs/reference/commands.mdx` because the package-contract lane
checks CLI/documentation parity.

### Bounded, no-follow filesystem reads

- `src/lib/adapters/fs/regular-file.ts` owns regular-file opening without following links.
- `src/lib/onboard/custom-build-context.ts` has path-containment and ignored-path handling.
- `src/lib/state/state-root.ts` owns the NemoClaw state-root convention.
- `src/lib/state/registry/persistence.ts` and `src/lib/state/registry/lock.ts` demonstrate durable
  state writes and cross-process ownership.

The package implementation should reuse these primitives where their guarantees match. It must not
copy private versions into a new monolith.

Where UID ownership is available, mutable input and all state/store destinations require the
current effective UID. A non-root process may read root-owned bundled/reviewed input only when the
entire no-follow path is non-writable by group/other. Every unrelated UID remains rejected, and
root ownership never bypasses mode, ancestor, type, containment, or race checks.

### Manifest data contract

- `src/lib/agent/manifest-readers.ts` provides typed field readers and YAML parsing.
- `src/lib/agent/definition-types.ts` is the stable result type.
- `src/lib/agent/defs.ts` shows derived accessors and existing alias/candidate behavior.

`package-manifest.ts` should validate the package envelope, then call the existing manifest readers
and return validated envelope/manifest data. It must not build `AgentDefinition`. In Plan 02-10,
extract `buildAgentDefinition` into `src/lib/agent/definition-loader.ts`; both the repository loader
and the receipt-verified installed-package path call that one function with an explicit package
root. The resulting `AgentDefinition` carries that root so derived legacy paths, base-image
resolution, Docker builds, and sandbox build-context staging all use the selected package bytes.
There is no `Plugin`, `Adapter`, or callback superclass and no second definition implementation.

OpenClaw's current `agent === null` value is a compatibility sentinel used by existing branches. Do
not replace it globally with a definition object. Carry the receipt-verified effective
`AgentDefinition` and optional package identity as separate authority while preserving the sentinel
where current behavior depends on it. `src/lib/onboard/sandbox-agent.ts` must accept that pinned
definition instead of loading a new one by name.

The transitional bundled artifacts intentionally preserve a package-root-shaped version of the
current local path layout, such as `agents/<id>/manifest.yaml`. After installed-package selection,
code must not fall back to repository `ROOT` for a missing Dockerfile, local `COPY`/`ADD` source,
policy, plugin, or start script. A missing declared package asset is a package validation/runtime
error. Phase 3 can simplify that shape after each harness owns its source tree.

Current Hermes and LangChain Deep Agents Code Dockerfiles copy `nemoclaw-blueprint/`. Their Phase 2
bundle declarations may copy that exact reviewed shared/mixed dependency and must include it in the
digest. This is a temporary disclosed dependency, not proof of self-containment; arbitrary sibling
harness roots and undeclared checkout content remain forbidden.

### Interactive choices

- `src/lib/onboard/agent-selection.ts` renders a numbered menu and preserves OpenClaw ordering.
- `src/lib/onboard/prompt-helpers.ts` owns numbered-menu parsing and exit behavior.

`package-prompt.ts` should return an ID or exit result. It should not install anything itself.

### Session lock and state normalization

- `src/lib/state/onboard-session.ts` owns `Session`, normalization, save/update, and the writer lock.
- `src/lib/state/onboard-checkpoint-migrate.ts` derives compatible checkpoints from legacy sessions.
- `src/lib/state/registry-normalization.ts` preserves readable legacy registry rows.
- `src/lib/onboard/session-bootstrap.ts` is the correct place to bind fresh/resumed intent while the
  current lock is held.

Add one strict `HarnessPackageIdentity` parser in `package-identity.ts` and reuse it from all three
state normalizers. Do not let each state file accept a different shape.

Add one strict `HarnessPackageMigration` parser beside it. The optional record is secret-free audit
metadata with schema version 1, source `legacy-current-bundle`, prior agent value, and migration
time. It belongs only on owning Session and SandboxEntry state and never changes identity equality,
the package receipt, or compatibility. Malformed present identity is corruption, not legacy state.

`src/lib/state/harness-migration.ts` is the only legacy standard-agent migration service. Direct
resume prepares the exact reviewed mapping read-only, lets portable retirement recover the old
Session/registry bytes, and then commits inside the recovered operation. Installer reconciliation
has no portable wrapper and commits before backup. Commit order is: hold the onboarding writer
lock; install and verify the prepared current object; re-read its exact receipt;
compare-and-swap only the same owner's optional session; then update only that owner's registry row
under the registry lock. A session and row are peers only when `session.sandboxName` equals the row
name; standalone sessions and all other rows are independent owners. A retry after any partial
write must converge without changing that owner's migration record or package identity, and no
identity or `migratedAt` may cross owner groups. Pi and NemoCUA do not enter this service.

### Recovery authorities

- `src/lib/onboard/onboard-recreate-journal.ts` fingerprints replacement intent.
- `src/lib/state/registry/route-reservation.ts` protects pre-create route authority.
- `src/lib/state/registry/pending-policy-verification.ts` protects verified create state.
- `src/lib/onboard/cancel-rollback.ts` deliberately preserves some incomplete created sandboxes.
- `src/lib/actions/sandbox/rebuild-resume-config.ts` resolves recreate authority before deletion.
- `src/lib/actions/sandbox/snapshot.ts` and `snapshot/restore-authority.ts` own public restore and
  clone mutation authority.
- `src/lib/actions/sandbox/snapshot/backup-authority.ts` owns the final backup publication fence.
- `src/lib/actions/sandbox/rebuild-prepared-recovery.ts` owns the last pre-deletion recovery check.
- `src/lib/state/sandbox.ts` owns the persisted `RebuildManifest` contract.

Package identity must be an input to these existing authorities. It must not create a parallel
package recovery transaction. Snapshot restore compares source and target identity before forced
destination deletion or Shields mutation; clones inherit source identity. Backup receives the
already pinned definition. Rebuild resolves that definition once, persists identity in the
manifest, revalidates at preflight and immediately before deletion, and carries it through target
configuration, flow helpers, post-restore, messaging, GPU opt-out, and DCode preflight. Qualified Pi
and NemoCUA retain their existing backup, resume, and rebuild authority without fabricated identity.

### Immutable receipt lookup

Use content identity as the lookup key:

```text
objects/sha256/<digest>/
receipts/<id>/sha256/<digest>.json
active/<id>.json
```

The pointer contains validated ID and digest, so active and pinned reads derive one exact receipt
without a receipt-ID index or directory scan. An exact reinstall verifies and reuses existing
object/receipt bytes; it does not replace original installation time or reviewed source identity.
The store rejects a second digest for the same package kind, harness ID, package version, and
contract version. Authors must increase the adapter package version when package bytes change.

The store root is always the gateway-independent base state directory
`~/.nemoclaw/harnesses/`. Add a named base-state helper to `state-root.ts`; do not call the existing
gateway-port-scoped sandbox-state resolver. Service boundaries accept explicit roots so tests use
private temporary directories, and tests prove `NEMOCLAW_GATEWAY_PORT` cannot split inventory.

### Installer planning boundary

- `src/commands/internal/installer/plan.ts` is the shell-to-TypeScript command pattern.
- `src/lib/actions/installer/plan.ts` owns pure environment and probe decisions.
- `scripts/install.sh` already prepares a CLI before pre-upgrade backup.

Add stateful package reconciliation in the focused `harness-reconcile.ts` service and hidden
`reconcile-harnesses.ts` command. Keep the existing installer planner pure. The shell invokes the
hidden command after CLI preparation and before conditional backup. It does not inspect registry or
session files independently.

### Test placement

- New `src/lib/harness/*.test.ts` files belong to the existing `cli` project.
- New command tests remain co-located under `src/commands/`.
- Real installer process assertions belong under `test/installer-integration/` or the established
  `test/install/` lane selected by `vitest.config.ts`.
- Compiled/published command and real process-dispatch assertions belong under
  `test/package-contract/`; packed-file assertions use
  `npm pack --dry-run --ignore-scripts --json` so package lifecycle scripts cannot run.
- E2E catalogue and planner behavior belongs under the current `e2e-support` project.

The existing typed onboarding fixture installs the reviewed harness before a standard
package-managed target calls `onboard`, then asserts the exact receipt, Session, and final registry
identity agree. Put focused support in a small fixture file such as `harness-package.ts`; extend the
current typed target metadata only when needed. Do not add another registry, workflow list, or
manual live runner.

## Naming Guidance

Use names that explain the operation:

- `parseHarnessPackageManifest`
- `buildAgentDefinition`
- `validateHarnessPackageTree`
- `copyVerifiedPackageTree`
- `installBundledHarnessPackage`
- `readInstalledHarnessPackage`
- `listHarnessPackageInventory`
- `resolvePinnedHarnessPackage`
- `assertMatchingHarnessIdentity`

Avoid ambiguous names such as `render`, `apply`, `inspect`, `manager`, `plugin`, or `registry` when a
more specific operation exists. Avoid a file named `package-registry.ts`; catalogue, store, receipt,
and installation are separate responsibilities.

## Patterns Not to Reuse

- The preserved branch's monolithic `src/lib/harness/package-registry.ts`.
- Its arbitrary CommonJS package runtime loader.
- Repository-directory presence as installed or supported authority.
- A receipt ID that must be discovered after an active pointer advances; derive immutable receipts
  from validated ID plus digest.
- Repository `ROOT` as a fallback after an installed package root has been selected.
- Replacing OpenClaw's null compatibility sentinel instead of carrying a separate effective
  definition.
- Assigning package identity or current-bundle migration provenance to Pi or NemoCUA candidate
  state.
- Shell parsing of human-readable CLI output.
- A second onboarding receipt, state machine, lifecycle, package catalogue, or E2E registry.
- Package deletion before every durable reference owner is proven.
