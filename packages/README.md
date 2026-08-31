<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent runtime packages

This directory contains the in-tree agent runtime package implementation for NemoClaw.
The implementation is a product-scope candidate, not an approved support or distribution policy.
The registry discovers packages through data-only manifests and installation receipts.
Onboarding and lifecycle commands can run package-owned helpers after receipt verification.

Run these commands to inspect or install a package:

```bash
nemoclaw harness list
nemoclaw harness install
nemoclaw harness install <id>
```

Installation copies a bundled package to `~/.nemoclaw/harnesses`.
The bare install command presents packages that are available to install.
`nemoclaw harness list` separates installed packages from packages that remain available.
`nemoclaw agents list` and onboarding expose only installed agent runtime packages.
Onboarding stops before configuration begins when no package is installed.
Onboarding selects one installed agent runtime automatically and presents a picker when multiple
agent runtimes are installed.

## Package contract

The common interface is deliberately small. NemoClaw discovers package metadata and a data-only
manifest, builds the package images, starts the declared runtime, and invokes one fixed native
configuration command. The package owns native translation, while core validates and coordinates
the product transaction around it.

Each package must use the directory name `packages/nemoclaw-<id>`.
Its `package.json` must contain these fields:

```json
{
  "name": "@scope/nemoclaw-<id>",
  "version": "1.2.3",
  "nemoclaw": { "harnessManifest": "manifest.yaml" }
}
```

The package name can be scoped or unscoped, but its basename must be `nemoclaw-<id>`.
The manifest must be `manifest.yaml` at the package root. The package directory, package-name
basename, and manifest `name` must use the same ID.
The registry rejects symbolic links, and normal discovery rejects invalid package metadata.
A refresh can replace an older receipt-managed package when its tracked content matches its receipt.
Receipt tracking ignores entries named `.git`, `.DS_Store`, `node_modules`, and `__pycache__`.
Discovery reads package data without importing a package module.
Package-owned host helpers must not load executable code from receipt-ignored paths.
The registry rejects credential-shaped build-context paths before installation.

Treat each installed agent runtime package as trusted code.
Package-owned helpers can receive NemoClaw-held credentials and use the current user's Docker or OpenShell control.
The receipt detects tracked path, type, content, and executable-bit changes after installation.
It does not authenticate the package publisher or validate package behavior.

Every agent runtime package must include the agent manifest named by
`nemoclaw.harnessManifest` and these files:

- `manifest.yaml` declares runtime identity, configuration paths, state, ports, and capabilities.
- `Dockerfile.base` builds the sandbox base image.
- `Dockerfile` builds the agent runtime image.
- `start.sh` starts the agent runtime in the sandbox.
- `policy-additions.yaml` defines the agent runtime's baseline network policy.

The bundled examples also include `README.md` at the package root. The registry does not execute or
require that documentation, so adding it does not change installation compatibility.

The registry requires each file to be a non-empty regular file and requires `start.sh` to be
executable. Packages can also include these optional paths:

- `policies/permissive.yaml` optionally defines the agent runtime's Shields down policy.
- `policies/presets/` optionally contains policy presets available only to this agent runtime.
- `provider-profiles/` optionally contains package-owned OpenShell provider profiles.
- `model-specific-setup/` optionally contains compatibility manifests for this agent runtime.
- `plugin/` optionally contains an agent runtime plugin.

Use these responsibility directories when the package needs them:

- `config/` contains build-time native configuration code.
- `runtime/` contains commands and helpers that run inside the sandbox.
- `host/` contains receipt-verified transition helpers that NemoClaw core still executes.
- `compat/` contains patches and workarounds bound to an upstream agent runtime version.
- `checks/` contains package-owned build and behavior checks.

A package that participates in managed startup must provide an executable
`runtime/generate-config.sh`. Its image installs that file as the root-owned,
non-symbolic-link command `/usr/local/lib/nemoclaw/generate-config` with mode `0555`.
The command translates NemoClaw's managed startup environment into the agent runtime's native
configuration. NemoClaw core invokes the fixed command path and does not select the native
generator by agent ID.

Shared directory names describe shared responsibilities. Packages do not need empty directories or
identical internal files. File names use the shortest one- or two-word name that states the
responsibility; use a third word only when removing it makes the name ambiguous.

Keep each bundled `start.sh` at or below 1,000 lines so it can read as a workflow, and move a
cohesive implementation behind a descriptive module when it has an independent responsibility.
Generated locks and inventories, version-bound source patches, and atomic security or rollback
protocols can remain large when splitting them would separate validation from mutation. Name that
debt in the package README instead of hiding it behind generic helper files.

A complete package reads in this order:

```text
nemoclaw-<id>/
├── README.md              package workflow and compatibility debt
├── package.json           package identity and manifest location
├── manifest.yaml          data-only runtime capabilities and paths
├── Dockerfile.base        pinned upstream dependency layer
├── Dockerfile             NemoClaw runtime image assembly
├── start.sh               sandbox process entry point
├── policy-additions.yaml  baseline network policy
├── config/                native configuration translation
├── runtime/               commands and guards used inside the sandbox
├── host/                  bounded receipt-verified transition helpers
├── compat/                version-bound upstream adaptations
├── plugin/                native plugin code, when the runtime supports it
└── checks/                package-owned build and behavior checks
```

Only the root contract is universal. A package adds a responsibility directory when it has that
responsibility; it does not add empty folders to resemble another package.

## Package tests

Each package root exposes the same contributor commands:

| Command | Scope |
| --- | --- |
| `npm run test:package` | Runs tests that need only the package checkout. |
| `npm run test:nemoclaw` | Runs package-owned tests that need an exact NemoClaw checkout. |
| `npm test` | Runs both test lanes. |
| `npm run test:watch` | Watches checkout-independent TypeScript tests. |
| `npm run typecheck` | Type-checks package `.ts` and `.mts` source plus TypeScript tests. |

The test commands do not install dependencies. Install each package's development dependencies
from its package-root lock before running a command:

```bash
npm --prefix packages/nemoclaw-openclaw ci --ignore-scripts
npm --prefix packages/nemoclaw-hermes ci --ignore-scripts
npm --prefix packages/nemoclaw-langchain-deepagents-code ci --ignore-scripts
```

OpenClaw also has a nested plugin lock. Install both OpenClaw locks before running its complete
test command:

```bash
npm --prefix packages/nemoclaw-openclaw ci --ignore-scripts
npm --prefix packages/nemoclaw-openclaw/plugin ci --ignore-scripts
npm --prefix packages/nemoclaw-openclaw test
```

The exact-NemoClaw lane uses the package inside a checkout at an immutable commit SHA or release
tag. It can use recorded core production or test support that the package-only lane cannot use.
Neither lane runs during `nemoclaw harness install`, and an agent manifest does not declare a test
command.

### In-tree overlay rehearsal

`scripts/packages/checkout.mts` rehearses the two lanes without changing the source checkout. The
package-only mode copies one package authoring tree into a private temporary workspace, omits local
dependencies and build output, installs its package-owned locks with lifecycle scripts disabled,
and runs only `test:package`. For OpenClaw, those locks are the package-root lock and the nested
plugin lock. The copied package has no NemoClaw `src/lib` or root test helpers around it, and every
command receives a temporary home and a credential-free allowlisted environment.
This contributor rehearsal runs reviewed package candidates. It narrows their environment and
working tree, but it is not a sandbox for untrusted code.

Run the package-only rehearsal from the NemoClaw root:

```bash
PACKAGE_ID=openclaw

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts package-only \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID"
```

Composed mode requires both a local NemoClaw checkout and its exact 40-character commit SHA. It
archives that commit, overlays only the matching candidate package, installs the core, package, and
OpenClaw nested-plugin locks with lifecycle scripts disabled, builds required artifacts, and runs
the complete package command, which includes `test:package` and `test:nemoclaw`. It then uses the
CLI built in that temporary checkout to install the bundled package by ID, list it, and verify its
receipt in the temporary home.

```bash
PACKAGE_ID=openclaw
NEMOCLAW_CHECKOUT="$(pwd)"
NEMOCLAW_COMMIT="$(git -C "$NEMOCLAW_CHECKOUT" rev-parse HEAD)"

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts composed \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID" \
  --nemoclaw-checkout "$NEMOCLAW_CHECKOUT" \
  --nemoclaw-commit "$NEMOCLAW_COMMIT"
```

A future package repository keeps `npm ci --ignore-scripts` and `npm run test:package` as its local
lane. Its composed lane can call this script from an exact NemoClaw checkout and pass the package
repository as `--candidate`. This is an in-tree overlay rehearsal. It does not prove external
artifact installation or distribution, and it does not add an install-by-path command. If a locked
dependency cannot install while lifecycle scripts are disabled, stop and make that dependency an
explicit security decision instead of enabling scripts in this workflow.

Organize TypeScript tests by the package workflow:

```text
tests/
├── config/       native configuration generation
├── runtime/      startup, wrappers, guards, and in-sandbox helpers
├── host/         receipt-verified host adapters
├── compat/       version-bound upstream patches
├── image/        Dockerfiles, build inputs, and image layout
├── integration/  package archive and composed NemoClaw boundaries
├── fixtures/     inert package-owned test inputs
└── helpers/      package-owned test support
```

Create only the directories that the package uses. The responsibility directory supplies context
for each test file name.

Two language-native test locations remain outside this tree:

- OpenClaw plugin tests stay beside their TypeScript source under `plugin/src/**/*.test.ts`.
- Hermes plugin tests stay beside their Python source under `plugin/test_*.py` and use
  `python3 -m unittest`.

NemoClaw root tests retain command, package installation, orchestration, security, state, and E2E
coverage. Package commands own detailed deterministic agent runtime behavior. Package test source,
fixtures, helpers, configuration, and development locks are authoring files, not installed runtime
files.

## Core and package boundaries

NemoClaw core owns the product workflow: command parsing, package discovery and receipts,
onboarding, credential collection and selection, OpenShell registration, policy requests, rollback
decisions, and persisted product state. OpenShell owns credential custody and delivery, sandbox
lifecycle, and enforcement authority. The package owns the agent runtime translation: its image,
native configuration, process startup, native plugin, runtime guards, compatibility patches, and
build checks.

The `host/` directory is a transition boundary, not a general plugin callback API. Core loads only
named helpers from a receipt-verified package and retains the authorization, transaction, and
rollback decision around each call. A package cannot register arbitrary host execution.

Managed MCP mutation uses one fixed helper, `host/mcp-adapter.cts`. An installed package that
declares MCP bridge support exports `buildMcpRegistrationCommand(request)` and
`buildMcpRemovalCommand(request)` from that file. The request carries the validated server URL,
opaque OpenShell credential placeholders, current managed entries, and the applicable mutation
flags. A builder returns either one non-empty shell command or one non-empty argument vector.
NemoClaw verifies the exact package receipt and module shape before calling either function, then
keeps command execution, runtime inspection, credential custody, policy mutation, transaction
ordering, rollback, and redacted diagnostics in core. The manifest cannot choose another module
path or callback name.

Package-owned sandboxes use this helper. Legacy registry rows continue through their existing core
translation until the ordinary package-migration boundary records exact package authority, so the
transition does not change their lifecycle behavior.

MCP adapters remain package-specific because the current runtimes have different command,
mutation, reload, and rollback behavior. Messaging keeps the existing common manifest pipeline in
core while each package retains its runtime-specific configuration and startup implementation.
Those boundaries can become smaller after two packages prove the same safer in-sandbox operation;
this migration does not invent that operation in advance.

The remaining named integration points are intentionally narrow:

| Core boundary | Why core still owns it | Package-owned side |
| --- | --- | --- |
| Managed startup profile and environment | Selects credential material, validates the committed profile, and authorizes root or sandbox actions. | Generates the runtime's native configuration through the fixed command. |
| Image qualification and managed identity | Decides whether an image is acceptable for the requested runtime and inference route. | Supplies receipt-verified probes and native identity rules from `host/`. |
| Native configuration and provider routing | Selects the requested inference and provider state, holds credentials, and validates protected mutations. | Supplies native configuration grammar, identity, route, and tool gateway translations from `host/`. |
| MCP reconciliation | Owns requested product state, authorization, transaction order, rollback, and redacted diagnostics. | Supplies native inspect, apply, reload, status, and removal translations from `host/`. |
| Messaging configuration | Owns the shared channel manifest, credentials, policy, and onboarding workflow. | Implements the agent runtime's native configuration and startup behavior for each supported channel. |
| Backup, restore, pairing, and configuration sealing | Mutates protected OpenShell or NemoClaw state and therefore remains in the trusted product workflow. | Supplies native grammar, merge, approval, and guard behavior from `host/` or `runtime/`. |
| Dashboard, ports, and process lifecycle | Coordinates OpenShell resources and persisted sandbox state. | Declares static capabilities in `manifest.yaml` and implements startup in `start.sh`. |

Package-specific helpers, lockfiles, patches, schemas, and runtime plugins belong with these files.
Package commands own detailed deterministic tests. NemoClaw root projects retain core integration
and E2E coverage for the in-tree packages.

## Add a bundled package

1. Add `packages/nemoclaw-<id>` with `README.md`, valid package metadata, and a data-only manifest.
2. Add the two image definitions, startup entry point, and baseline policy at the package root.
3. Put native configuration translation in `config/` and expose it through the executable
   `runtime/generate-config.sh` command when the package uses managed startup.
4. Add only the responsibility directories the integration needs. Keep upstream-version changes in
   `compat/`, not mixed into configuration or startup code.
5. Add package-owned image checks in `checks/`. Add detailed deterministic tests under `tests/`
   and run them through the package commands.
6. Add or extend one registered live E2E target for the agent runtime and exercise install,
   onboarding, inference, lifecycle reconciliation, status, and cleanup.

The registry discovers the package without a new command option or catalogue entry. Full managed
startup remains a closed, typed contract for the agent runtimes NemoClaw ships. A new package that
needs managed startup, MCP, messaging, dashboard, pairing, or another specialized lifecycle must
add the corresponding explicit core integration and tests.
External package download and repository ownership are outside this in-tree migration.
