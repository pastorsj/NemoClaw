<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes agent runtime package

This package connects Hermes to the harness package contract described in
[`packages/README.md`](../README.md). The package owns the Hermes image, native configuration,
sandbox startup, runtime guards, upstream compatibility work, and package checks. NemoClaw core
continues to own package discovery, onboarding, credential collection and selection, OpenShell
registration, product rollback decisions, and shared messaging orchestration. OpenShell owns
credential custody and delivery, sandbox lifecycle, and enforcement authority.

## Package workflow

The workflow reads from top to bottom:

1. `package.json` and `manifest.yaml` identify Hermes and declare its data-only capabilities.
2. `Dockerfile.base` builds the pinned Hermes base and applies reviewed dependency patches.
3. `Dockerfile` assembles the NemoClaw image from package-owned configuration, runtime, plugin,
   policy, and compatibility files.
4. `config/generate-config.ts` translates managed startup inputs into native Hermes configuration
   and the credential-free Fabric launch configuration.
5. `start.sh` reads as the startup workflow: admit startup, load the package modules, configure the
   proxy boundary, and execute the root or non-root launch path.
6. The shell modules in `runtime/` define each startup responsibility without hiding orchestration
   or effects inside a framework.
7. `compat/` adapts the pinned upstream release where its native behavior does not yet meet the
   NemoClaw contract.
8. `plugin/__init__.py` registers Hermes tools and hooks, then delegates managed-tool compatibility
   to `plugin/tool_broker.py`.
9. `checks/` validates those build and compatibility boundaries.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Builds Hermes `config.yaml`, `.env`, managed policy, model setup, and tool-gateway settings. |
| `fabric/` | Selects the released Hermes adapter through a bounded package-owned process boundary and pins both Fabric dependency graphs. |
| `runtime/` | Provides startup modules, commands, and guards installed into the sandbox. `runtime/state/` is the bounded state-mutation subsystem. |
| `host/` | Provides integrity-verified helpers that NemoClaw core loads for managed routes, MCP, image qualification, and the tool gateway. |
| `compat/` | Contains version-bound patches for the pinned Hermes release. |
| `plugin/` | Registers Hermes tools and hooks. `tool_broker.py` contains managed tool-broker compatibility, while channel adapters stay separate. |
| `checks/` | Provides build probes, the CLI contract validator, source download verification, and the release update command. |
| `policies/` | Contains the permissive policy and Hermes-only policy presets. |
| `provider-profiles/` | Contains package-owned OpenShell provider profiles. |
| `model-specific-setup/` | Reserves the package-owned location for future Hermes model compatibility declarations; no manifest is currently required. |

`manifest.yaml`, the two Dockerfiles, `start.sh`, and `policy-additions.yaml` are the common package
contract. `portable-build-context.json` stays at the root because the Portable context loader reads
that exact metadata location.

## Runtime flow

Managed startup invokes the fixed `/usr/local/lib/nemoclaw/generate-config` command. The package
wrapper runs `config/generate-config.ts`, which writes Hermes-native configuration and
`.hermes/fabric.json`. `start.sh` then
loads five package-owned modules in execution order:

| Module | Startup responsibility |
| --- | --- |
| `runtime/state-gate.sh` | Authenticates startup against an active runtime-state mutation. |
| `runtime/config-setup.sh` | Validates ports and prepares configuration, logs, and durable state. |
| `runtime/service-control.sh` | Tracks process identity and operates the dashboard and loopback relays. |
| `runtime/runtime-integrity.sh` | Migrates legacy state and protects configuration across managed restarts. |
| `runtime/gateway-control.sh` | Launches, validates, recovers, and supervises the gateway topology. |

After those definitions are loaded, the visible main section in `start.sh` performs the same
non-root or root startup sequence as before. New Hermes integrations should keep orchestration in
the entrypoint, put one coherent implementation responsibility in each runtime module, and avoid
moving Hermes behavior into NemoClaw core.

The CLI wrapper and adapter preserve the managed Hermes command surface. The configuration guard,
MCP transaction, cron control, and state-mutation subsystem reconcile mutable state without moving
those protocols into NemoClaw core. Host helpers remain data- and integrity-bound entry points for
the core operations that still need them.

The native TUI and gateway continue to invoke Hermes directly. A plain prompt through
`nemoclaw sandbox agent` uses the manifest's headless command and the generic `nemoclaw-fabric`
runner. Fabric loads its released Hermes adapter with the native Hermes Python environment. The
package-owned descriptor selects a thin lifecycle proxy, which preserves the released adapter's
contract while bounding protocol output and owning every adapter and tool process until shutdown.
The package projects the managed model route into `fabric.json` and passes only a sandbox-route
credential through the protected startup environment. NemoClaw core resolves the package command
without importing Hermes-specific code.

The host broker reads as one process workflow:

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
| `runtime/state/control.py` | Owns the authenticated runtime-state mutation transaction and its recovery state machine. |
| `runtime/mcp-transaction.py` | Keeps native MCP inspection, apply, reload, verification, commit, and rollback in one transaction. |
| `runtime/state/publisher.py` | Publishes and validates the candidate and release receipts used by the same state protocol. |
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
as `plugin/test_*.py`.

Install the package lock and run the checkout-independent TypeScript and Python tests:

```bash
npm ci --ignore-scripts
npm run test:package
npm run test:fabric
```

Tests that exercise the composed build and current NemoClaw boundaries run through
`npm run test:nemoclaw`. To prove both lanes from a separate candidate checkout, run the
`package-only` and `composed` in-tree overlay rehearsals documented in
[`packages/README.md`](../README.md) with package ID `hermes`. The composed rehearsal builds an
exact temporary NemoClaw revision, overlays only Hermes, runs the complete package command, and
verifies `nemoclaw harness install hermes`, `nemoclaw harness list`, and the temporary-home
installation inventory.
