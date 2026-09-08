<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw harness contract

This package is the typed authoring toolkit for a NemoClaw agent runtime package. It supplies
types, manifest validation, adapter compilation, package validation, and artifact materialization.
It does not run an agent runtime, discover packages, grant host access, or establish product
support.

This implementation is a local product-scope candidate. It does not establish a supported package
API, an external distribution policy, or a compatibility promise. Those claims require an accepted
design decision with an `Accept` outcome, an accountable maintainer, and a validation plan.

The contract has no V1 or V2 product label. Add a typed operation only when core has a current
consumer and an agent runtime package needs native translation for it.

## Authoring workflow

Use this sequence in an agent runtime repository:

1. Create the required package files.
2. Declare capabilities and fixed commands in `manifest.yaml`.
3. Add only the typed adapters required by those capabilities.
4. Compile `host/source/*-adapter.cts` into reviewed self-contained `host/*-adapter.cts` artifacts.
5. Validate the manifest, package tree, adapter freshness, and npm publish set.
6. Materialize a new read-only install artifact.
7. Run package-owned tests without NemoClaw source.
8. Install the artifact and test it against an immutable NemoClaw revision.
9. Run a focused live journey only when the changed boundary requires real infrastructure.

Use this structure and add only the folders the package needs:

```text
nemoclaw-<id>/
├── README.md
├── package.json
├── manifest.yaml
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/
├── host/
│   ├── source/
│   └── *-adapter.cts
├── runtime/
├── fabric/
├── compat/
└── tests/
```

Declare the manifest and compatible NemoClaw version window in `package.json`:

```json
{
  "nemoclaw": {
    "harnessManifest": "manifest.yaml",
    "minimumNemoClawVersion": "0.0.113",
    "maximumNemoClawVersionExclusive": "0.2.0",
    "buildProjects": ["plugin"]
  }
}
```

The two exact `x.y.z` values form a half-open compatibility window. NemoClaw accepts the package
when its running build is at least `minimumNemoClawVersion` and strictly below
`maximumNemoClawVersionExclusive`. Use the narrowest window that the package tests qualify. The
in-tree packages retain their established compatibility floor and include the current NemoClaw
minor release.

`buildProjects` is optional package-rehearsal metadata. Each entry names a bounded relative path
to another locked npm project owned by the package. NemoClaw installs those development
dependencies generically; the package's own scripts decide what to build and test. A declared
build project may publish only the production `tsconfig*.json` files copied by a package
Dockerfile, plus their local `extends` chain. Root, test, undeclared-project, Vitest, and Jest
configuration remains authoring-only.

Dockerfiles are composed from two authorities. A package may `COPY` anything beneath its own
`packages/nemoclaw-<id>/` path. NemoClaw supplies the shared Fabric runner, blueprint, security
helpers, managed-startup tooling, and other explicitly named core build-kit files. Validation
rejects arbitrary repository paths and every sibling harness package. This keeps native harness
code independently publishable without making each package redistribute NemoClaw core; adding a
new core dependency is an intentional contract change rather than an implicit monorepo coupling.

## Strict data-only manifest

`HarnessAgentManifest` intentionally has no string index signature. Authors get TypeScript editor
feedback for unknown fields, while runtime validation remains authoritative for YAML.

The validator requires `name`, `runtime`, `config`, `inference.config_update`, `messaging`, and
`state_lifecycle`. It rejects unknown top-level and nested fields, ambiguous YAML, aliases,
unbounded values, invalid paths and commands, and package identity mismatches.

`config.dir` must be a canonical directory below `/sandbox`. Each declared config file must use a
canonical relative path that stays below that directory.

The manifest declares data. It cannot choose an executable module, export name, request schema, or
result schema. Core fixes those values. Prefer manifest data or a fixed sandbox command whenever
native behavior does not require a protected host transaction.

Three legacy metadata fields are deliberately non-authoritative. `version_constraint` records the
package's upstream compatibility floor, while `expected_version` is the exact runtime version that
NemoClaw qualifies. `package_registry` records the package manager and registry hosts used by the
package itself; it is not a discovery or installation source. `phone_home_hosts` is an upstream
host inventory, not an egress grant. Package policy files remain the network authority. Core must
not act on these inventory fields without a separate typed operation and protecting tests.

Receipt-backed inference selection consumes `inference.config_update.provider_api_overrides` and
the optional bounded `inference.context_window_requirements` before route compatibility checks or
provider probes. The latter currently accepts one `ollama-local` minimum between 16,384 and
4,194,304 tokens. These are package requirements applied by core-owned inference runtimes, not
host callbacks.

`inference.route_probe` selects finite checks that NemoClaw owns and runs. `terminal_connect`
requires a healthy managed inference route before the terminal smoke command. `rebuild_preflight`
requires one inference request from the retained sandbox before backup or deletion. `models_404`
uses an inference request when the provider does not support the models route. A package selects
these checks with data; it does not supply probe code or receive credentials.

`sandbox_create` contains finite inputs that core must apply before a managed harness starts. A
package can declare `startup_controls` for `approval-mode` and `observability`; core resolves and
persists those settings without branching on the package ID, then passes them through the existing
typed startup profile. A package can also declare `docker_ulimits` as exact `name`, `soft`, and
`hard` values. Core applies those limits to Docker sandbox creation so the supervisor and its child
processes inherit them. The validator bounds both lists and rejects unknown controls, duplicate
limit names, invalid names, and limits whose hard value is below the soft value.

No-receipt compatibility behavior is separate. A current package must declare every startup
control and Docker limit it requires in its manifest.

Every package also declares `policy`. Empty `owned_presets`, `automatic_presets`, and
`baseline_exclusion_impacts` values are the explicit no-additions form. This keeps receipt-backed
onboarding total: core never has to guess whether an omitted policy surface means “none” or an
incomplete package.

### Package-published managed images

An external package may make its managed image available to buildless runtime providers without
adding the harness ID to NemoClaw's stock image catalogue:

```yaml
managed_image:
  repository: registry.example/team/example-sandbox
  architectures: [linux/amd64, linux/arm64]
  runtime_identity: { uid: 1000, gid: 1000, workdir: /sandbox }
  base_image:
    corporate_ca: true
    security_inventory: true
    package_probe: true
  publication:
    source:
      repository: ExampleOrg/example-harness
      revision: 0123456789abcdef0123456789abcdef01234567
      release: v1.2.3
      cohort: build-2026.09.05
    digests:
      linux/amd64: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      linux/arm64: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

The digest keys must exactly match `architectures`. NemoClaw selects the runtime platform, binds
the resulting immutable reference and source identity to the exact installed package receipt, and
does not fetch the NVIDIA stock catalogue. Without `publication`, an external package uses its
local Dockerfile where the runtime permits builds and receives a typed refusal where a managed
image is required.

The local package receipt establishes operator trust for this proof of concept. Publication data
records provenance; it does not authenticate an external publisher or establish product support.

`base_image` is optional and omission has no harness-specific fallback. Its three booleans select
only core-owned CA projection, security-inventory validation, and the conventional package probe.
A declared probe must be published as `checks/image-probe.py`; the image installs the same bytes at
`/usr/local/lib/nemoclaw/checks/image-probe.py` and emits
`nemoclaw-image-probe-ok <source-sha256>` after its package-specific checks pass. A package that
requires a pinned final base may additionally declare one `pinned_remote` object containing the
literal argument `BASE_IMAGE` and its exact OCI digest reference. Commands, callback modules, and
probe paths are not manifest fields.

## Typed operations

Import types from `@nvidia/nemoclaw-harness-contract`. The exported surface is organized by the
operation core needs to perform:

| Source | Typed responsibility |
| --- | --- |
| `command.ts` | Interactive and headless commands, raw or Fabric CLI prompt protocol, prompt transport, public environment, smoke checks, process lifecycle actions, semantic turns, and bounded session or inference-selection qualification commands |
| `agent-roster.ts` | Agent list, add, delete, inspection, and declarative reconciliation plans |
| `config.ts` | Inference projection, configuration update, URL policy, mutable-state reconciliation, and package-specific restore merging |
| `mcp.ts` | Model Context Protocol (MCP) registration, removal, inspection, capability probes, runtime plans, intent verification, and snapshot repair |
| `messaging.ts` | Supported or disabled channel integration profiles and native configuration projection |
| `policy.ts` | Package-owned policy presets, activation conditions, tier suppression, and operator-facing exclusion effects |
| `provider-auth.ts` | Provider selection metadata and finite API-key or device-code authentication plans |
| `provider-broker.ts` | Provider description, registration, readiness, bounded inspection, and teardown plans |
| `provider-profile.ts` | Validation of package-owned provider profiles used by bounded web-search verification |
| `tool-gateway.ts` | Managed-tool catalogue, aliases, labels, defaults, authentication compatibility, environment requests, and package-owned policy mappings |
| `session.ts` | Session list, delete, reset, and export plans plus output interpretation |
| `startup.ts` | Managed startup plans, startup profiles, material, actions, and reconciliation |
| `state.ts` | Backup quiescence, snapshot repair actions, and typed rebuild declarations using fixed package commands and finite core operations |
| `manifest.ts` | The complete package declaration and managed-image composition requirements |

Command and state behavior is primarily declarative. Protected translations use fixed module paths
and exports:

| Module | Required when |
| --- | --- |
| `host/config-adapter.cts` | Every package |
| `host/messaging-adapter.cts` | Every package |
| `host/mcp-adapter.cts` | `mcp.support` is `bridge` |
| `host/agent-roster-adapter.cts` | `agent_roster.support` is `managed` |
| `host/session-adapter.cts` | `sessions` is declared |
| `host/startup-adapter.cts` | Every package |
| `host/provider-auth-adapter.cts` | `provider_auth.support` is `managed` |
| `host/provider-broker-adapter.cts` | `provider_broker.support` is `managed` |
| `host/provider-broker-control.cts` | `provider_broker.support` is `managed` |
| `host/restore-adapter.cts` | A state file uses `restore.merge: package-config` |

An adapter returns a finite data plan and does not execute commands. Core retains credential
custody, authorization, protected execution, transaction order, locks, verification, rollback,
and redacted diagnostics. A new operation needs a current core consumer, at least one package
implementation, runtime request and result schemas, negative trust-boundary tests, and removal of
the native branch it replaces.

### Agent roster

Declare roster support only when the package implements all three fixed adapter exports:

```yaml
agent_roster:
  support: managed
  adapter: agent-roster
  onboarding_environment: NEMOCLAW_EXTRA_AGENTS_JSON
```

`buildAgentRosterCommand` translates core's fixed `list`, `add`, and `delete` operations into
native argv. `buildAgentRosterInspection` validates the package-native manifest and returns one
bounded inspection command. `buildAgentRosterApplyPlan` interprets that output and returns finite
add/delete commands, rebuild-only fields, and operator notices. The adapter owns native grammar,
output parsing, path defaults, and rebuild distinctions. NemoClaw owns receipt authority,
OpenShell execution, input and output bounds, confirmation, ordering, and the sandbox mutation
lock. A receipt-backed package that omits `agent_roster` receives a typed unsupported result; it
never inherits OpenClaw behavior. Only sandboxes without a package receipt use the explicit legacy
compatibility path.

### Command output

Every runtime declares an interactive or headless entry point. A package that opts its bounded
agent command into `output_interpretation: structured-turn-envelope` emits the exported
`HarnessStructuredTurnEnvelope`: either a response with `payloads` and `meta`, or a gateway wrapper
whose `result` is that response. Only the final response `meta` record carries completion authority.
NemoClaw treats `replayInvalid`, an abandoned `livenessState`, a non-empty `timeoutPhase`, or
`error.kind: incomplete-turn` as unfinished. Package payloads and earlier JSON log records remain
untrusted output and cannot cause a retry.

### Semantic turns

A package can declare `runtime.semantic_turn` when a core-owned service needs one committed text
turn from the package's native runtime:

```yaml
semantic_turn:
  support: managed
  command: [/usr/local/bin/future-semantic-turn]
  timeout_seconds: 120
  protocol: semantic-turn-ndjson
```

Core writes one `HarnessSemanticTurnRequest` to the command's standard input. The request contains
only `type`, `message`, `conversationKey`, `runtimeTarget`, and `idempotencyKey`. The conversation
key is opaque. The package maps the key and target to its native session grammar. The command
either writes one `failed` event before native work starts, or writes one `started` event, zero or
more `text` events, and one `completed` or `failed` event. Each event is newline-delimited JSON.
The schema is closed. Native run IDs, frames, options, and diagnostic fields cannot cross the
boundary. The package must omit native secrets from its text projection; core treats accepted text
as opaque package output.

Managed semantic turns require a managed image because core needs its runtime identity authority.
The package owns native authentication, session mapping, protocol translation, and native frame
bounds inside its sandbox. Core captures the sandbox name, exact package receipt, gateway name and
port, lifecycle generation, and live identity fingerprint. It rechecks that binding under the
sandbox mutation lock before each turn. Core also owns OpenShell execution, the timeout, request
and response limits, cancellation, and event delivery. A package can omit this optional surface or
declare `support: unsupported` with a reason. It does not add a host callback.

### Provider authentication and broker

`provider_auth` declares one package-owned provider choice and its finite authentication methods.
The adapter resolves a requested method. NemoClaw owns prompts, secrets, provider registration,
route validation, and persisted non-secret state.

`provider_broker` declares five operations: describe the provider, register or refresh it, ensure
the broker, inspect it, and tear it down. The adapter returns the provider identity. The fixed
controller performs the bounded package operation. NemoClaw verifies the package receipt and
provider ownership before each mutation. Inspection reports bounded non-secret state. Teardown
revalidates that authority before it detaches or deletes the provider and before it removes
package-owned broker state.

### Managed tool gateways

`tool_gateways` is an optional, finite declaration for tools exposed through a package's managed
provider broker. Each entry declares its canonical ID, input aliases, operator-facing text,
default selection, compatible `provider_auth` methods, and required package-owned policy presets.
Core reads this data from the exact installed receipt, prompts and validates the selection, keeps
credentials, stores only `toolGatewaySelections`, adds the declared policy presets, and projects
the IDs into the typed startup profile. A receipt-backed package with no managed declaration gets
an unsupported result; it never inherits another harness's catalogue. The old Hermes field and
selector remain only on the explicit no-receipt compatibility path.

## Build commands

Install this package as a development dependency and expose the tools from the agent runtime
package:

```json
{
  "scripts": {
    "build:adapters": "nemoclaw-build-adapters .",
    "check:adapters": "tsc -p tsconfig.adapters.json && npm run build:adapters -- --check",
    "check:package": "nemoclaw-validate-package .",
    "build:package": "nemoclaw-build-package --create-output-parent . ../dist/example"
  }
}
```

Run them in this order:

```bash
npm run check:adapters
npm run check:package
npm run build:package

nemoclaw harness validate ../dist/example
nemoclaw harness install example \
  --from ../dist/example \
  --yes-i-trust-local-package
```

`nemoclaw-build-adapters` compiles self-contained CommonJS artifacts. Imports are unavailable when
NemoClaw evaluates an adapter. The check mode detects drift between typed source and reviewed
artifact.

`nemoclaw-validate-package` checks identity, required files, manifest fields, adapter presence and
freshness, file types and modes, credential-shaped paths, and the npm publish set. It runs
`npm pack` with lifecycle scripts disabled.

`nemoclaw-build-package` copies that validated publish set into a new read-only directory and adds
`nemoclaw-package.json`. The example writes to the sibling `../dist` directory because an artifact
cannot be inside its source package. The CLI creates that one parent when it is absent. It does not
replace an existing output. Source files, tests, lockfiles, and development dependencies do not
enter the runtime artifact. The exported builder API still requires an existing, caller-owned
output parent.

## Receipt and lifecycle boundary

The contract toolkit produces validated package bytes. NemoClaw owns their installed lifecycle:

```text
validated artifact
-> immutable object by content digest
-> immutable package receipt
-> active pointer for new work
-> exact receipt pinned to each sandbox
```

Installing a newer package version advances the active pointer without changing existing
sandboxes. `nemoclaw harness activate <id> --digest <sha256>` pins or rolls back to a verified
receipt. `nemoclaw harness remove <id> --yes` deactivates the package for new sandboxes but retains
its immutable history.

For receipt-backed work, NemoClaw verifies the package identity and tree before loading a fixed
adapter. An adapter failure never enters an agent-native core fallback. Explicit no-receipt legacy
behavior is a separate compatibility lane.

The adapter virtual machine limits accidental capabilities but is not a security boundary for
hostile code. Install a local package only after reviewing and trusting its complete contents.

NeMo Fabric is the sandbox-local headless data plane. It consumes the package's bounded command
and Fabric configuration. It does not replace the host contract, package receipts, or NemoClaw's
control plane.

Messaging profiles may attach finite `hookOperations` to core-owned workflow slots. Use
`config-prompt` to declare the configuration outputs a package needs, `sandbox-command` to invoke
a fixed package probe that emits NemoClaw's bounded health protocol, and `build-files` to describe
bounded configuration artifacts using typed input and generated-value markers. Core validates and
executes these operations without loading arbitrary callbacks. Package code owns native paths,
process names, CLI grammar, and output parsing. A receipt-backed profile cannot fall back to a
legacy-native implementation when its required operation is absent.

An optional browser surface is data, not a host callback. A package declares `dashboard_ui` with
distinct public and private ports, distinct non-credential environment names for enablement and
port projection, and an optional terminal-UI environment name. NemoClaw owns allocation,
forwarding, drift decisions, and durable neutral state. It reconstructs those actions from the
pinned package declaration; a malformed or missing declaration fails closed instead of entering a
harness-specific fallback.

An MCP bridge implements eight fixed operations. They cover registration, removal, inspection,
mutation and teardown capability probes, runtime intent verification, runtime planning, and
snapshot repair.

## Test workflow

The contract test suite proves its tools from outside the NemoClaw checkout. It packs this module,
installs the tarball into a temporary agent runtime repository without workspace links or network
access, compiles and invokes every typed adapter surface, validates managed lifecycle declarations,
checks a Fabric descriptor and bounded headless turn, validates the npm publish set, builds the
runtime artifact, and verifies that authoring-only files are absent.

Each agent runtime package should expose these layers:

- `npm run typecheck` for typed source and tests.
- `npm run test:package` for adapter checks, package validation, unit tests, and package-owned
  artifact coverage without NemoClaw source imports.
- `npm run test:fabric` for the native Fabric adapter.
- `npm run test:fabric:composed` for the adapter plus shared Fabric runner.
- `npm run test:nemoclaw` for package-owned composition against the surrounding checkout.
- `npm test` for the package and composed lanes together.

Before moving a package to a separate repository, run the package-only rehearsal and the composed
rehearsal against an exact NemoClaw commit. The composed lane builds that revision, installs the
candidate artifact, and verifies its receipt-backed identity. Add live coverage only for a changed
OpenShell, image, process, filesystem, policy, network, hardware, or inference boundary that the
deterministic lanes cannot prove.

Package-only tests do not select a host operating system, runtime provider, hardware target, or
managed-image source. The revision-pinned composed lane supplies those core-owned inputs through
the selected NemoClaw commit. Image qualification and live tests then prove the combinations that
need a real image, runtime, host, hardware, or OpenShell boundary.

A package is ready for local review when it:

1. Uses the strict manifest without executable selectors.
2. Implements every adapter required by its declared capabilities.
3. Compiles reproducible self-contained adapter artifacts.
4. Owns its native unit, negative, artifact, and Fabric tests.
5. Passes package-only and revision-pinned composition workflows.
6. Enters receipt-backed dispatch without an agent runtime ID branch or fallback.
7. Records focused live evidence for each external boundary changed by the package.

This checklist demonstrates the local contract. It does not claim product approval, publisher
trust, external discovery, or long-term compatibility.
