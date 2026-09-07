<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent runtime packages

An agent runtime package contains the code and assets that connect one agent runtime to NemoClaw.
The public CLI retains `harness` in its command names:

```bash
nemoclaw harness list
nemoclaw harness install
nemoclaw harness install <id>
```

This implementation is a local product-scope candidate. It does not establish a supported package
API, an external distribution policy, or a compatibility promise. Those claims require an accepted
design decision with an `Accept` outcome, an accountable maintainer, and a validation plan.

## Architecture thesis

NemoClaw composes an installed package. It does not implement the selected agent runtime.

- Core owns user intent, package identity, credential custody, policy authorization, OpenShell
  mutation, transaction order, rollback, durable state, operating-system readiness, hardware,
  runtime providers, and serving runtimes.
- A package owns every rule whose correct result changes when the selected agent runtime changes.
- A strict data-only manifest declares capabilities and fixed commands.
- A finite typed adapter translates a core operation into an agent-native plan. Core authorizes and
  executes that plan.
- NeMo Fabric supplies the package-selected headless invocation path inside the sandbox. It does
  not replace the host contract or the NemoClaw control plane.

This boundary covers the receipt-backed command, roster, configuration, Model Context Protocol
(MCP), messaging, session, startup, state, policy, provider-auth, provider-broker, managed-tool,
dashboard, secondary-forward, and Fabric surfaces described below. Explicit no-receipt legacy
paths remain in core for compatibility. They are a separate authority lane, not a fallback for a
broken or incomplete installed package.

## Repository layout

```text
packages/
├── README.md
├── nemoclaw-fabric/                    shared headless Fabric runner
├── nemoclaw-openclaw/                  OpenClaw package
├── nemoclaw-hermes/                    Hermes package
├── nemoclaw-langchain-deepagents-code/ LangChain Deep Agents Code package
├── nemoclaw-pi/                        Pi package candidate
├── nemoclaw-deepseek-harness/          DeepSeek Harness local candidate
└── nemoclaw-haystack-agent/            Haystack Agent local candidate
```

All six agent runtime packages use the shared Fabric path. OpenClaw, Hermes, Deep Agents Code, and
Pi declare managed images. DeepSeek Harness and Haystack Agent demonstrate the smaller terminal,
headless-only package shape without a managed image. Their presence in this local proof of concept
does not establish product support.

Each package tells the same workflow:

```text
package identity
-> data-only manifest
-> image and native runtime files
-> typed host translations
-> package-owned tests
-> immutable installation receipt
-> NemoClaw composition
-> focused live qualification
```

Use the shared folder names when the package needs that responsibility. Do not add empty folders
only to make packages look alike.

```text
packages/nemoclaw-<id>/
├── README.md              package workflow and compatibility notes
├── package.json           identity, scripts, and manifest location
├── manifest.yaml          strict data-only capabilities and commands
├── Dockerfile.base        pinned upstream dependency layer
├── Dockerfile             NemoClaw image assembly
├── start.sh               sandbox process entry point
├── policy-additions.yaml  baseline network policy
├── config/                native configuration generation
├── host/
│   ├── source/            typed adapter source
│   └── *-adapter.cts      reviewed self-contained build artifacts
├── runtime/               fixed sandbox commands and guards
├── fabric/                Fabric adapter inputs or released dependency
├── compat/                bounded upstream-version workarounds
├── plugin/                native runtime plugin, when required
├── policies/              package-owned policy data
├── provider-profiles/     package-owned provider profiles
├── model-specific-setup/  package-owned compatibility data
├── checks/                package and image checks
└── tests/
    ├── config/
    ├── host/
    ├── runtime/
    ├── compat/
    ├── image/
    ├── fabric/
    ├── integration/
    ├── package/
    ├── fixtures/
    └── helpers/
```

File names use one or two words when those words identify the responsibility. Use a third word
only when shorter text is ambiguous. Function names use enough words to state the semantic action
and object.

## Package and manifest contract

The directory is `packages/nemoclaw-<id>`. Its `package.json` identifies the manifest and compatible
NemoClaw version window:

```json
{
  "name": "@scope/nemoclaw-<id>",
  "version": "1.2.3",
  "nemoclaw": {
    "harnessManifest": "manifest.yaml",
    "minimumNemoClawVersion": "0.0.113",
    "maximumNemoClawVersionExclusive": "0.0.121",
    "buildProjects": ["plugin"]
  }
}
```

`buildProjects` is optional. Use it when package-owned builds need another locked npm project
inside the package, such as a native runtime plugin. The package rehearsal installs each declared
project from its own lockfile without learning which harness uses it. The package's normal test
scripts still own what those projects build and test. Only production TypeScript configs copied
by a package Dockerfile, and the local configs they extend, may ship from a declared build project.

The package name can be scoped or unscoped. Its basename, directory suffix, and manifest `name`
must contain the same ID. Every installable package contains these non-empty regular files:

- `package.json`
- `manifest.yaml`
- `Dockerfile.base`
- `Dockerfile`
- `start.sh`
- `policy-additions.yaml`

`start.sh` must be executable. Package validation rejects symbolic links, invalid metadata,
credential-shaped build-context paths, stale adapter artifacts, and files outside the npm publish
set. `policy-additions.yaml` contains only always-on baseline routes. Optional routes belong in
package-owned presets; conformance rejects a network-policy key that appears in both the baseline
and an owned preset.

The package Dockerfile is the receiving side of its startup plan. It declares one global
`BASE_IMAGE`, one `NEMOCLAW_BUILD_ID`, and an `ARG` for every configuration or root-owned material
the startup adapter can emit. To accept an operator corporate CA, it declares one assigned global
`NEMOCLAW_CORPORATE_CA_B64`, validates and installs the bundle in the final stage, and ends with a
validated `NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER`, `USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}`, and
the fixed exec-form `/usr/local/bin/nemoclaw-start` entry point. Core supplies and validates these
values; package code decides how they configure its image and native runtime.

`manifest.yaml` is data, not an extension-language entry point. Runtime validation rejects unknown
top-level and nested fields, ambiguous YAML, aliases, unbounded values, and an identity mismatch.
The manifest must declare `name`, `runtime`, `config`, `inference.config_update`, `messaging`,
`policy`, and `state_lifecycle`. A package with no package-specific policy behavior declares empty
`owned_presets`, `automatic_presets`, and `baseline_exclusion_impacts` values. Optional
declarations enable managed images, MCP, sessions, skills, dashboards, state files, and other
bounded capabilities.

The manifest cannot select a host module, export name, or schema. Core owns those choices. Use
manifest data or a fixed sandbox command before adding a host adapter.

`version_constraint`, `package_registry`, and `phone_home_hosts` are package-owned inventory, not
control-plane authority. Exact runtime qualification uses `expected_version`; package installation
uses an operator-selected validated artifact; and network authorization comes from policy files.
NemoClaw does not discover, install, or grant egress from those informational fields.

## Typed integration surfaces

The `@nvidia/nemoclaw-harness-contract` package exports the TypeScript types. Core owns matching
runtime schemas, fixed module paths, request and result bounds, package loading, authorization, and
execution.

The same package publishes the reviewed harness-neutral gateway controller and messaging build
runtime. A package materializes those exact artifacts with `nemoclaw-materialize-runtime`; it does
not copy NemoClaw source. `build:runtime` creates package-local snapshots and `check:runtime`
rejects drift. This lets a future standalone package repository install one released contract,
regenerate its runtime inputs, and test without a NemoClaw source checkout.

| Surface | Package declaration or module | Package responsibility |
| --- | --- | --- |
| Command | `manifest.runtime` | Interactive and headless commands, prompt transport, public environment, an optional gateway log path, smoke checks, finite process actions, optional semantic turns, and optional session or inference-selection qualification |
| Configuration | `host/config-adapter.cts` | Inference projection, configuration updates, URL classification, and mutable-state reconciliation |
| Agent roster | `manifest.agent_roster` and `host/agent-roster-adapter.cts` | Native list/add/delete argv, roster output parsing, manifest defaults, reconciliation, and rebuild-only distinctions |
| Inference routing | `manifest.inference.config_update.provider_api_overrides` and `inference.context_window_requirements` | Provider-specific API selection and bounded local-runtime requirements for initial onboarding and later inference updates |
| Web search | `manifest.web_search` and `provider-profiles/<profile_type>.yaml` | Config assertions, credential placement, result shape, and a bounded egress request |
| MCP | `host/mcp-adapter.cts` when `mcp.support: bridge` | Registration, removal, inspection, capability probes, runtime plans, intent verification, and snapshot repair |
| Messaging | `host/messaging-adapter.cts`, `messaging/profile.json`, and optional `provider-profiles/*.yaml` | Supported or disabled integration profile, native configuration projection, and any custom OpenShell credential boundary |
| Session | `host/session-adapter.cts` when `sessions` is declared | List, delete, reset, and export plans plus output interpretation |
| Policy | `manifest.policy` and `policies/presets/*.yaml` | Owned presets, automatic activation, tier suppression, context projection, and baseline exclusion effects |
| Provider profiles | `provider-profiles/*.yaml` | Package-owned OpenShell provider definitions referenced by messaging, web search, or broker workflows |
| Provider authentication | `manifest.provider_auth` and `host/provider-auth-adapter.cts` when managed | Provider choice, model catalogue, authentication methods, aliases, and a finite method-resolution plan |
| Provider broker | `host/provider-broker-adapter.cts` and `host/provider-broker-control.cts` when `provider_broker.support: managed` | Provider description, register or refresh, readiness, bounded inspection, and receipt-revalidated teardown |
| Managed tools | `manifest.tool_gateways` with managed provider broker and provider authentication | Tool IDs, aliases, labels, defaults, compatible auth methods, environment requests, and package-owned policy preset mappings |
| Startup | `host/startup-adapter.cts` | Startup plan, initial profile, profile preparation, and reconciliation for source-built and package-published images |
| Sandbox create | `manifest.sandbox_create` | Startup controls, Docker process limits, driver mounts, and generated-image build requirements |
| Secondary forward | `manifest.health_probe.port_resolution: sandbox-secondary-forward` and `health_probe.secondary_forward` | Environment name, preferred port, bounded allocation range, operator label, and recovery guidance for one package-owned endpoint |
| Optional dashboard | `manifest.dashboard_ui` | Opt-in environment name, public and private port settings, optional terminal UI flag, browser path, and operator label |
| State | `manifest.state_lifecycle`, `state_dirs`, and `state_files` | Backup quiescence, snapshot repair actions, and typed rebuild declarations made from fixed package commands and core-owned finite operations |
| Configuration restore | `host/restore-adapter.cts` when a state file uses `merge: package-config` | Native configuration merge and bounded write plan |
| Fabric | `manifest.runtime.headless_command`, generated `fabric.json`, and `fabric/` | Headless request translation through the shared sandbox-local Fabric runner |
| Semantic turn | `manifest.runtime.semantic_turn` and `runtime/` | One fixed sandbox command that translates a committed text turn into the closed semantic-turn NDJSON event schema |

Configuration, messaging, and startup adapters are required for every package. Agent roster, MCP,
session, provider-broker, and restore artifacts are required only when their corresponding manifest
capability is present.
The messaging adapter can return a typed disabled result. Optional disabled capabilities do not
require no-op adapters.

`runtime.semantic_turn` is an optional managed-image surface for a core-owned consumer, not a
voice implementation supplied by the package. Core captures and revalidates the exact package,
gateway, and sandbox lifecycle authority; holds the sandbox mutation lock; and owns OpenShell
execution, timeout, stream limits, cancellation, and event delivery. The package maps the opaque
conversation key and package target to native session grammar, authenticates to its native runtime,
bounds native traffic, and emits only the closed NDJSON records. A package does not receive a host
callback or choose the gateway that core executes against.

A channel that needs a custom OpenShell credential type declares `credentialProvider` in
`messaging/profile.json`. The declaration names a package-relative provider profile, its exact ID
and credential environment, and the core-owned secret input that supplies static or refresh
material. NemoClaw verifies the YAML asset against that declaration before projecting it into the
receipt-backed messaging plan. Core keeps credential custody and executes registration or refresh;
the package supplies no callback and receives no secret. Plans without a package receipt keep the
old built-in provider discovery only as an explicit compatibility path.

Package-native channel differences live in `lifecycle.hookOperations`. A `config-prompt`
operation selects the package's fields on a shared core prompt. A `sandbox-command` operation runs
one fixed package-owned probe and returns only the bounded bridge-health or channel-health
protocol. A `build-files` operation materializes schema-validated files from declared inputs and
generated timestamps. These operations contain data or fixed argv, never a host callback. A
legacy-native hook slot marked as requiring an operation fails closed for every receipt-backed
package, including a package that reuses a built-in package ID. No-receipt plans retain the old
native hook implementations as an explicit compatibility lane.

Each web-search binding selects one package-owned provider profile. Package validation requires a
regular profile file and matches its ID, credential environment, endpoint host, and credential
placement to the binding. Core reads only the declared `/sandbox` config path. Core then sends the
declared fixed request through `/usr/bin/curl`, which the profile must authorize. Core uses the
OpenShell placeholder. Core does not run package callbacks or copy a config credential into the
request.

An MCP bridge currently implements eight fixed operations:

- `buildMcpRegistrationPlan`
- `buildMcpRemovalPlan`
- `buildMcpInspectionCommand`
- `describeMcpMutationCapability`
- `describeMcpTeardownCapability`
- `describeMcpRuntimeIntentVerification`
- `buildMcpRuntimePlan`
- `buildMcpSnapshotRestorePlan`

The other module interfaces and their fixed exports live in
[`harness-contract/src/`](../harness-contract/src/). Keep adapters synchronous and self-contained.
They return finite data plans and do not execute commands.

## Receipt-backed loading

Installation publishes three records under the private package store:

1. An immutable object addressed by its content digest.
2. An immutable receipt binding package ID, version, source identity, and content digest.
3. An active pointer selecting a receipt for new work.

For a receipt-backed sandbox, core resolves the exact stored package identity, validates the
manifest and package tree, reads a bounded regular file from a fixed path, evaluates the
self-contained CommonJS module without an import loader, validates and freezes the request and
result, and then executes the returned plan under core authority. A missing, malformed,
capability-mismatched, or receipt-mismatched adapter fails closed. Core does not switch on the
agent runtime ID or fall back to a native translator.

A sandbox with `harnessPackage: null` is an explicit no-receipt legacy case. Those compatibility
and product paths can still use a closed core implementation. They must remain visibly separate
from receipt-backed dispatch so a new package cannot enter legacy behavior by accident.

Provider selection reads receipt-backed inference requirements before route validation or endpoint
probing. A package can select an API for a named provider through `provider_api_overrides`; it can
require Ollama's core-owned runtime to provide a minimum context window through one bounded
`context_window_requirements` entry. Core never infers either requirement from the package ID.
Managed host-local inference also carries the complete package receipt as its application
authority. The closed OpenClaw, Hermes, and Deep Agents Code ID list is used only for no-receipt
legacy sessions.

A package can select core-owned route checks through `inference.route_probe`. The available checks
cover terminal connection, inference before rebuild, and providers whose models route returns 404.
The rebuild check runs against the retained sandbox before backup or deletion. A failed check stops
the rebuild without changing the sandbox. Packages select these checks with finite manifest data;
they cannot supply host probe code.

A receipt-backed package that needs one additional forwarded endpoint declares its complete
allocation under `health_probe.secondary_forward`. Core allocates and reserves a port from that
bounded declaration, publishes it through the declared environment variable, and records it as
`secondaryForwardPort`. Health checks, forwarding, supervisor relaunch, and snapshot cloning read
the same receipt-pinned declaration and neutral registry field. The historical Hermes constants,
`hermesApiPort` field, and helper exports remain only for explicit no-receipt compatibility.

A receipt-backed package that offers an optional browser UI declares `dashboard_ui`. The package
names its enable, public-port, private-port, and optional terminal-UI environment settings. Core
allocates and forwards the public port, projects those declared settings into startup, compares
them for reuse drift, and stores only neutral `dashboardUi` state. Snapshot cloning and supervisor
relaunch reconstruct behavior from the sandbox's pinned receipt. Historical Hermes environment
constants and `hermesDashboard*` registry fields remain only in the explicit no-receipt lane.

A package that requires device or browser pairing declares both a bounded settlement command and
a read-only `runtime.session_qualification` command. Core appends a nonce, executes the command as
the receipt-pinned runtime identity, and accepts only one credential-free SHA-256 completion
record. Launch readiness stores and compares that generic digest. Native pairing formats and
credentials remain package-owned; the historical OpenClaw observer is used only without a package
receipt.

A package whose native runtime normalizes inference identity can declare
`runtime.selection_qualification`. Core passes a bounded credential-free selection and a nonce to
that fixed sandbox command. The package compares the selection with its native live state and
prints only the fixed nonce-bearing completion marker. Missing, malformed, ambiguous, timed-out,
or receipt-drifted results fail closed; core never dispatches on the package ID.

Receipt-backed managed startup is also generic. A package can participate when it declares a
managed image and startup adapter. It may reuse matching product-qualified stock publication
evidence or declare an exact per-platform publication bound to its package receipt. The latter
lets a buildless runtime consume an external harness without adding its ID to NemoClaw's stock
catalogue. It records provenance but does not authenticate the publisher or establish product
support. The closed stock profile mapping remains only in the explicit no-receipt legacy lane.

The adapter virtual machine limits accidental capability access. It is not a security boundary
for hostile code. Review and trust the complete package before installation.

## NeMo Fabric workflow

NeMo Fabric is the sandbox-local data plane for one headless request:

```text
user prompt
-> core selects the receipt-pinned runtime.headless_command
-> runtime.prompt_protocol: fabric-cli translates the finite CLI grammar onto standard input
-> nemoclaw-fabric-run validates bounds and owns cleanup
-> the package-owned fabric.json selects its Fabric adapter
-> Fabric invokes the agent runtime
-> NemoClaw returns bounded, redacted output
```

The package owns its Fabric adapter or released dependency, `fabric.json` projection, non-secret
environment names, native adapter tests, and policy destinations. The shared runner validates
configuration, rejects literal credentials, bounds input and output, redacts diagnostics, applies
deadlines, and cleans up processes. It contains no agent runtime ID branches.

`runtime.prompt_transport: stdin` alone means literal raw stdin: core accepts exactly one non-empty
prompt argument and does not add command flags. A Fabric-backed package must additionally declare
`runtime.prompt_protocol: fabric-cli`; only that finite protocol accepts `-m`/`--message` and
`--json` and adds the shared runner's `--stdin` flag. Core never infers the protocol from an
executable name or package ID.

Fabric does not own installation, managed startup, configuration mutation, MCP reconciliation,
messaging, sessions, backup, restore, rollback, or durable NemoClaw state. Those operations use the
manifest and typed host contract.

## Install and lifecycle workflow

Build and review a package before local installation:

```bash
npm run check:adapters
npm run check:package
npm run build:package

nemoclaw harness validate ../dist/example
nemoclaw harness install example \
  --from ../dist/example \
  --yes-i-trust-local-package
```

`build:package` writes the read-only artifact to `../dist/<package-id>`. The artifact stays outside
the package source and the command creates the sibling `dist` directory when needed. Move an earlier
artifact before another build. The builder never replaces an existing output.

The lifecycle is receipt-based:

- **Install:** validate the package, create or reuse its immutable object and receipt, then move
  the active pointer.
- **Upgrade:** increment the package version and install the new build. NemoClaw creates a new
  object and receipt while preserving the old identity. Changed bytes under the same package
  version are rejected.
- **Pin or roll back:** run `nemoclaw harness activate <id> --digest <sha256>` to select an existing
  verified receipt.
- **Remove:** run `nemoclaw harness remove <id> --yes` to deactivate the package for new sandboxes.
  Immutable history remains available to existing sandboxes and for rollback.

Existing sandboxes continue to resolve their exact receipt after an upgrade, activation change,
or removal. Removal is deactivation, not deletion.

## Test workflow

Run the earliest stable boundary that can detect the failure. Package-native behavior stays in
the package; generic trust, orchestration, and dispatch behavior stays in core.

| Lane | Owner | What it proves |
| --- | --- | --- |
| Unit and artifact | Package | Native configuration, grammar, adapter output, image inputs, file modes, locks, package materialization, and failure cases |
| Contract toolkit | `harness-contract` | Strict manifest validation, adapter freshness, safe publish set, and an external package authoring workflow |
| Loader and synthetic composition | Core | Receipt authority, schemas, VM limits, mutation races, capability refusals, and an unknown package ID without a core switch |
| Revision-pinned composition | Package plus core | A supplied NemoClaw commit builds, installs the candidate, and reports the expected healthy receipt-backed identity |
| Fabric | Package plus shared runner | Native adapter behavior and the composed headless data path |
| Focused live edge | Typed E2E registry | Only behavior that needs real OpenShell, image, process, filesystem, policy, network, hardware, or inference boundaries |

Every agent runtime package owns unit, host, Fabric, composition, and artifact coverage. Pi,
DeepSeek Harness, and Haystack Agent use `tests/package/materialization.test.ts`; OpenClaw, Hermes,
and Deep Agents Code use package-owned archive tests. No package depends on a root-only artifact
test as its package proof.

Each package exposes the same primary commands:

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Type-check package code, adapters, and tests. |
| `npm run test:package` | Run package-owned checks without importing NemoClaw source. |
| `npm run test:fabric` | Run native Fabric adapter tests. |
| `npm run test:fabric:composed` | Compose the adapter with the shared Fabric runner. |
| `npm run test:nemoclaw` | Run package-owned composition tests against the surrounding checkout. |
| `npm test` | Run package tests and surrounding-checkout composition. |
| `npm run test:spec` | Render the package behavior tree. |
| `npm run test:watch` | Watch checkout-independent TypeScript tests. |

The root `npm run test:packages`, `npm run test:spec`, and `npm run test:fabric` commands discover
packages through `nemoclaw.harnessManifest`. The Fabric lane first qualifies its generic runner
independently, then invokes every package's composed proof. Rehearse the future
separate-repository boundary with a package-only workspace and then an immutable NemoClaw
revision:

```bash
PACKAGE_ID=openclaw

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts package-only \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID" \
  --allow-package-code

NEMOCLAW_CHECKOUT="$(pwd)"
NEMOCLAW_COMMIT="$(git rev-parse HEAD)"

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts composed \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID" \
  --nemoclaw-checkout "$NEMOCLAW_CHECKOUT" \
  --nemoclaw-commit "$NEMOCLAW_COMMIT" \
  --allow-package-code
```

The package-only rehearsal copies one package into a private workspace, installs its declared
build projects, and runs its independent contract. The composed rehearsal checks the supplied
NemoClaw commit, builds the package outside that exact checkout, overlays a second candidate copy
only to run the package-owned `test:nemoclaw` integration lane, installs the independently built
artifact through `harness install --from`, and verifies the receipt-backed package identity. Neither
rehearsal contains a harness-name branch. The required
`--allow-package-code` flag acknowledges that these rehearsals execute reviewed candidate code on
the host; private workspaces and credential scrubbing do not make them sandboxes for untrusted
packages.

The package-only rehearsal does not prove a host operating system, hardware target, runtime
provider, or managed-image choice. The composed rehearsal gets those inputs from the supplied
NemoClaw revision. Image qualification and focused live tests prove only the concrete combinations
that require those external boundaries.

Core maintainers can plan or run both rehearsals for every discovered package. The command reads
the `nemoclaw.harnessManifest` marker and does not contain a package ID list or switch:

```bash
NEMOCLAW_COMMIT="$(git rev-parse HEAD)"

npm run test:package:rehearsals -- --nemoclaw-commit "$NEMOCLAW_COMMIT" --plan
npm run test:package:rehearsals -- --nemoclaw-commit "$NEMOCLAW_COMMIT" --allow-package-code
```

Planning only reads bounded package metadata and does not execute package code. A matrix run
requires its own `--allow-package-code` acknowledgement, runs all package-only rehearsals before
composed rehearsals, stops at the first failure, and keeps each rehearsal in a separate private
workspace. It remains a trusted-code host workflow, not an untrusted-package sandbox.

Use the typed E2E registry for an opt-in live journey only when a local boundary cannot prove the
changed behavior. Packages with `tests/fixtures/live-contract.json` can use the shared Fabric
package runner. Candidate packages such as Pi must also receive their already-valid protected
qualification authority; the runner preserves caller-supplied authority without learning the
package ID. Pi's separate qualification journey produces the stronger image evidence. Do not
multiply live runs across unchanged operating systems, providers, or hardware when contract and
synthetic tests already cover their composition.

Run the default smoke journey for each package. It proves the package-specific install, onboard,
Fabric turn, cleanup, and removal boundary:

```bash
npx tsx tools/e2e/fabric-package.mts run \
  --contract /path/to/package/tests/fixtures/live-contract.json \
  --package-artifact /path/to/package/dist/nemoclaw-example
```

Run the full control-plane lifecycle once for an exact candidate on each release environment:

```bash
npx tsx tools/e2e/fabric-package.mts run \
  --contract /path/to/package/tests/fixtures/live-contract.json \
  --package-artifact /path/to/package/dist/nemoclaw-example \
  --journey lifecycle
```

The full journey adds upgrade, immutable receipt pinning, rollback, deactivation, and restart. Those
operations are harness-neutral, so repeating them for every package adds runtime without adding a
new semantic coverage dimension.

## Add another package

1. Record product scope before presenting the integration as supported.
2. Create `packages/nemoclaw-<id>` with the six required files and package marker.
3. Declare commands and capabilities in the strict manifest.
4. Add native configuration, runtime files, policy, and Fabric inputs.
5. Implement only the typed adapter modules required by declared capabilities.
6. Add package-owned unit, adapter, artifact, Fabric, and negative tests.
7. Pass `typecheck`, `test:package`, `test:fabric`, and `test:fabric:composed` in the package.
8. Pass the package-only and revision-pinned composed rehearsals.
9. Add one focused live lifecycle only for an external boundary that earlier lanes cannot prove.

The receipt-backed path must accept the new ID without a command option, catalogue branch, loader
fallback, or agent-name switch. Add a typed operation to the contract only when a current core
consumer needs native translation and at least one package implements and tests it.

External package discovery, publisher trust, repository ownership, and compatibility policy remain
outside this local proof of concept. Moving a package to its own repository does not change the
contract: the package validates independently, pins the NemoClaw revision used for composition,
and publishes only after its own lifecycle and focused live gates pass.
