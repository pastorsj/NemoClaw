<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes agent runtime package

This package connects Hermes to the agent runtime package contract described in
[`packages/README.md`](../README.md). The package owns the Hermes image, native configuration,
sandbox startup, runtime guards, upstream compatibility work, and package checks. NemoClaw core
continues to own package discovery, onboarding, credential collection and selection, OpenShell
registration, product rollback decisions, and shared messaging orchestration. OpenShell owns
credential custody and delivery, sandbox lifecycle, and enforcement authority.

The typed package boundary described here is a local proof of concept. It does not change the
existing Hermes product scope or establish an external package compatibility promise.

## Package workflow

The workflow reads from top to bottom:

1. `package.json` and `manifest.yaml` identify Hermes and declare its data-only capabilities.
2. `Dockerfile.base` builds the pinned Hermes base and applies reviewed dependency patches.
3. `Dockerfile` assembles the NemoClaw image from package-owned configuration, runtime, plugin,
   policy, and compatibility files.
4. `config/generate-config.ts` translates managed startup inputs into native Hermes configuration
   and the credential-free Fabric launch configuration.
5. `host/config-adapter.cts` and `host/mcp-adapter.cts` translate typed core requests into bounded
   Hermes plans.
6. `start.sh` reads as the startup workflow: admit startup, load the package modules, configure the
   proxy boundary, and execute the root or non-root launch path.
7. The shell modules in `runtime/` define each startup responsibility without hiding orchestration
   or effects inside a framework.
8. `compat/` adapts the pinned upstream release where its native behavior does not yet meet the
   NemoClaw contract.
9. `plugin/__init__.py` registers Hermes tools and hooks, then delegates managed-tool compatibility
   to `plugin/tool_broker.py`.
10. `checks/` validates those build and compatibility boundaries.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Builds Hermes `config.yaml`, `.env`, managed policy, model setup, and tool-gateway settings. |
| `fabric/` | Selects the released Hermes adapter through a bounded package-owned process boundary and pins both Fabric dependency graphs. |
| `runtime/` | Provides startup modules, commands, and guards installed into the sandbox. `runtime/state/` is the bounded state-mutation subsystem. |
| `host/` | Contains typed configuration, MCP, messaging, session, startup, provider-auth, and provider-broker adapters plus the broker controller. |
| `compat/` | Contains version-bound patches for the pinned Hermes release. |
| `plugin/` | Registers Hermes tools and hooks. `tool_broker.py` contains managed tool-broker compatibility, while channel adapters stay separate. |
| `checks/` | Provides build probes, the CLI contract validator, source download verification, and the release update command. |
| `policies/` | Contains the permissive policy and Hermes-only policy presets. |
| `provider-profiles/` | Contains package-owned OpenShell provider profiles. |
| `model-specific-setup/` | Reserves the package-owned location for future Hermes model compatibility declarations; no manifest is currently required. |

`package.json`, `manifest.yaml`, the two Dockerfiles, `start.sh`, and `policy-additions.yaml` are the
common package contract. `portable-build-context.json` stays at the root because the Portable
context loader reads that exact metadata location.

## Typed adapter boundary

| Capability | Package file | Current behavior |
| --- | --- | --- |
| Command and Fabric | `manifest.runtime` and `fabric/` | Declares interactive, headless, process-lifecycle, and smoke commands; Fabric translates a headless request to Hermes. |
| Configuration | `host/config-adapter.cts` | Returns bounded mutable configuration and inference-update plans. |
| Roster | Not declared | Core returns the typed unsupported result for receipt-backed Hermes sandboxes. |
| MCP | `host/mcp-adapter.cts` | Implements all eight fixed MCP operations. |
| Messaging | `host/messaging-adapter.cts` and `messaging/` | Declares seven channels and projects package-native configuration. |
| Sessions | `host/session-adapter.cts` | Implements list, delete, and export plans. |
| Startup | `host/startup-adapter.cts` | Builds and reconciles the managed-image startup profile. |
| State and restore | `manifest.state_lifecycle` | Declares quiescence, scheduled-work, file strategies, and post-restore actions. Core applies the finite strategies; no package restore adapter is needed. |
| Policy and provider profiles | `manifest.policy`, `policies/`, and `provider-profiles/` | Owns Hermes policy presets and provider definitions for messaging, web search, and broker-related routes. |
| Provider authentication | `host/provider-auth-adapter.cts` | Resolves the declared OAuth device-code or API-key method. Core keeps credentials. |
| Provider broker | `host/provider-broker-adapter.cts` and `host/provider-broker-control.cts` | Describes, registers or refreshes, ensures, inspects, and tears down the package-owned provider broker. |
| Managed tools | `manifest.tool_gateways` and package policy presets | Declares five tools, auth compatibility, defaults, aliases, and required policies. |
| Dashboard and secondary forward | `dashboard_ui` and `health_probe.secondary_forward` | Supplies bounded UI and API port declarations. Core allocates, forwards, and persists neutral state. |

Only files named by the core contract use the typed adapter loader. `host/managed-route.cts` and
`host/base-qualification.cts` have separate package consumers. The provider-broker adapter and
controller are part of the typed contract; the older HTTP broker implementation remains their
package-owned runtime machinery.

## Runtime flow

Managed startup invokes the fixed `/usr/local/lib/nemoclaw/generate-config` command. The package
wrapper runs `config/generate-config.ts`, which writes Hermes-native configuration and
`.hermes/fabric.json`. `start.sh` then
loads four package-owned modules in execution order:

| Module | Startup responsibility |
| --- | --- |
| `runtime/config-setup.sh` | Validates ports and prepares configuration, logs, and durable state. |
| `runtime/service-control.sh` | Tracks process identity and operates the dashboard and loopback relays. |
| `runtime/runtime-integrity.sh` | Migrates legacy state and protects configuration across managed restarts. |
| `runtime/gateway-control.sh` | Launches, validates, recovers, and supervises the gateway topology. |

After those definitions are loaded, the visible main section in `start.sh` performs the same
non-root or root startup sequence as before. New Hermes integrations should keep orchestration in
the entrypoint, put one coherent implementation responsibility in each runtime module, and avoid
moving Hermes behavior into NemoClaw core.

The CLI wrapper and adapter preserve the managed Hermes command surface. The configuration guard,
MCP transaction, and cron control reconcile mutable state without moving those protocols into
NemoClaw core. Host helpers remain data- and integrity-bound entry points for the core operations
that still need them.

The native TUI and gateway continue to invoke Hermes directly. A plain prompt through
`nemoclaw sandbox agent` uses the manifest's headless command and the generic `nemoclaw-fabric`
runner. Fabric loads its released Hermes adapter with the native Hermes Python environment. The
package-owned descriptor selects a thin lifecycle proxy, which preserves the released adapter's
contract while bounding protocol output and owning every adapter and tool process until shutdown.
The package projects the managed model route into `fabric.json` and passes only a sandbox-route
credential through the protected startup environment. NemoClaw core resolves the package command
without importing Hermes-specific code.

The typed provider-broker adapter selects the fixed host workflow. The controller owns its bounded
register, readiness, inspection, and teardown operations:

| Module | Host broker responsibility |
| --- | --- |
| `host/tool-broker.ts` | Starts the public and private listeners, schedules refresh, and owns shutdown. |
| `host/broker-credentials.ts` | Keeps refresh credentials in memory and owns OAuth rotation, inference keys, and the atomic clone credential transaction. |
| `host/clone-control.ts` | Binds the private control socket and dispatches bounded clone credential requests. |
| `host/request-proxy.ts` | Removes sandbox secrets, adds host-managed authorization, forwards requests, and sanitizes responses. |

## Compatibility debt

Files in `compat/` are tied to Hermes release `v2026.7.20` (`0.19.0`). Each patch checks the
reviewed upstream source shape and fails when that shape changes. Remove a patch when Hermes owns
the required behavior; otherwise refresh its source binding and focused test during an upgrade.

The runtime modules retain the existing security protocols and execution order. Their boundaries
follow the workflow above rather than creating shared abstractions with other agent runtimes.

## Large-file boundaries

The remaining large files each hold one security or build protocol:

| File | Why it remains whole |
| --- | --- |
| `Dockerfile` | Assembles and attests the ordered Hermes image, including every pinned compatibility input. |
| `runtime/config-guard.py` | Owns descriptor-pinned configuration validation, mutation, sealing, recovery, and rollback. |
| `runtime/mcp-transaction.py` | Keeps native MCP inspection, apply, reload, verification, commit, and rollback in one transaction. |
| `portable-build-context.json` | Is a generated, mode-aware inventory consumed as one Portable build receipt. |

Splitting these files before their protocols have a smaller proven boundary would separate checks
from the mutations they authorize. The startup, plugin, and host-broker workflows are split because
their responsibilities already have stable handoffs.

## Checks

`checks/image-probes.py` validates patched behavior in the built image.
`checks/cli-adapter.py` compares the CLI adapter with the installed Hermes parser.
`checks/download-source.sh` verifies the pinned source archive, and `checks/update-agent.sh`
updates the reviewed release pins.

## Tests

`tests/config`, `tests/runtime`, `tests/host`, `tests/compat`, `tests/image`, and
`tests/integration` follow the Hermes workflow described above. Package-owned fixtures and support
stay under `tests/fixtures` and `tests/helpers`. Python plugin tests remain beside the plugin source
as `plugin/test_*.py`. `messaging/runtime` is the canonical source for Hermes channel adapters,
and their native behavior tests live under `tests/runtime`.

Install the package lock and run the checkout-independent TypeScript and Python tests:

```bash
npm ci --ignore-scripts
npm run test:package
npm run test:fabric
```

Tests that exercise the composed build and current NemoClaw boundaries run through
`npm run test:nemoclaw`. That direct command uses the surrounding checkout. To pin core, run the
`package-only` and `composed` in-tree overlay rehearsals documented in
[`packages/README.md`](../README.md) with package ID `hermes`. The composed rehearsal builds an
exact temporary NemoClaw revision, overlays only Hermes, runs the complete package command, and
verifies `nemoclaw harness install hermes`, `nemoclaw harness list`, and the temporary-home
installation inventory.

`test:package` is package-only and does not import NemoClaw source. It proves package adapters,
runtime code, and artifacts. The revision-pinned `composed` rehearsal supplies the host operating
system, runtime provider, hardware, and image-selection behavior from the selected NemoClaw
commit. Image qualification and focused live tests prove combinations that need real OpenShell or
external services.

`npm test` does not run `test:fabric` separately because the composed Fabric lane in
`test:nemoclaw` includes its direct cases. That lane also creates separate runner and Hermes
adapter Python environments, verifies their dependency boundaries, and completes one Fabric
lifecycle request across them.
