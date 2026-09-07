<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw agent runtime package

This package is the OpenClaw integration layer for NemoClaw. It owns OpenClaw configuration,
image contents, startup, runtime helpers, plugins, and compatibility code. NemoClaw core owns
package discovery, onboarding, credential selection, OpenShell registration, policy requests, and
rollback decisions. OpenShell owns credential custody, sandbox lifecycle, and enforcement.

The typed package boundary described here is a local proof of concept. It does not change the
existing OpenClaw product scope or establish an external package compatibility promise.

## Package workflow

The package follows one sequence:

1. `package.json` identifies the package; `manifest.yaml` identifies the agent runtime and declares its data-only capabilities.
2. `Dockerfile.base` installs the pinned OpenClaw and Model Context Protocol (MCP) dependency graphs.
3. `Dockerfile` adds package configuration, runtime helpers, plugins, policies, and compatibility patches.
4. `config/generate-config.mts` translates managed startup settings into `openclaw.json` and the
   credential-free Fabric launch configuration.
5. `start.sh` prepares protected state and starts the OpenClaw agent gateway.
6. Files in `runtime/` support the running sandbox.
7. Files in `compat/` adapt the pinned OpenClaw release where its native behavior is not sufficient.
8. Files in `checks/` reject version, dependency, and generated-runtime drift during image builds.

The fixed `runtime/generate-config.sh` command lets the existing managed-startup path invoke the
package-owned native generator at one path. The planner still admits only the closed set of managed
startup agent IDs.

Nested production projects use `npm-shrinkwrap.json`. npm publishes this lockfile. The image build
copies it to the in-image `package-lock.json` paths used by integrity checks. This preserves
reproducible installation without changing the runtime layout.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Generates native OpenClaw configuration and holds the plugin manifest schema. |
| `fabric/` | Implements the small OpenClaw adapter and pins its Fabric dependency graph. |
| `host/` | Contains typed roster, configuration, MCP, messaging, session, startup, and restore adapters plus package configuration and CLI helpers. |
| `runtime/` | Holds in-sandbox commands, protection helpers, preloads, state plans, and locked dependency graphs. |
| `compat/` | Holds upstream-version patches, legacy cleanup, and reviewed npm remediation. |
| `plugin/` | Implements the NemoClaw commands that OpenClaw loads through its plugin mechanism. |
| `checks/` | Validates build inputs, OpenClaw versions, Tool Search behavior, and the WeChat dependency graph. |
| `policies/` | Holds OpenClaw policy presets. |
| `model-specific-setup/` | Holds OpenClaw model compatibility manifests at the repository-defined path. |
| `openclaw-plugins/` | Holds executable OpenClaw compatibility plugins at the repository-defined path. |

The package root contains the files that NemoClaw and package tools discover directly. Each support file lives under the directory that names its execution responsibility.

## Typed adapter boundary

| Capability | Package file | Current behavior |
| --- | --- | --- |
| Command and Fabric | `manifest.runtime` and `fabric/` | Declares interactive, headless, native agent, process-lifecycle, pairing, session-qualification, semantic-turn, and smoke commands; Fabric translates headless requests. |
| Configuration | `host/config-adapter.cts` | Returns bounded mutable configuration and inference-update plans. |
| Roster | `host/agent-roster-adapter.cts` | Owns native list, add, delete, inspection, reconciliation, and rebuild distinctions. |
| MCP | `host/mcp-adapter.cts` | Implements all eight fixed MCP operations. |
| Messaging | `host/messaging-adapter.cts` and `messaging/` | Declares seven channels and projects package-native configuration. |
| Sessions | `host/session-adapter.cts` | Implements list, delete, reset, and export plans. |
| Startup | `host/startup-adapter.cts` | Builds and reconciles the managed-image startup profile. |
| State and restore | `manifest.state_lifecycle` and `host/restore-adapter.cts` | Declares managed extensions and post-restore actions; merges `openclaw.json` through a bounded write plan. |
| Policy and provider profiles | `manifest.policy`, `policies/`, and `provider-profiles/` | Owns OpenClaw presets and provider definitions for web search and messaging. |
| Provider auth, broker, and managed tools | The broker is disabled | Provider authentication and managed tools are not declared. |
| Dashboard and secondary forward | `manifest.dashboard` | Declares the gateway browser surface. It does not declare optional `dashboard_ui` or a secondary forward. |

These adapter files use the generic typed loader. `host/config-runtime.cts` is an image
configuration helper. `host/cli-grammar.cts` is limited to native agent-output interpretation that
has not moved to a separate typed operation.

## Runtime flow

`Dockerfile` copies `config/generate-config.mts` into the image and invokes it with managed startup
settings. The generator writes OpenClaw's native configuration and `.openclaw/fabric.json`.
Managed startup can invoke `/usr/local/lib/nemoclaw/generate-config` again through the same
package-owned generator.

The native gateway and TUI continue to use OpenClaw directly. A plain prompt through
`nemoclaw sandbox agent` uses the manifest's headless command, the generic `nemoclaw-fabric`
runner, and `fabric/openclaw.fabric-adapter.json`. The package-owned adapter translates one Fabric
request into OpenClaw's stable headless command, validates the response envelope, and contains the
child process on cancellation or timeout. NemoClaw core selects the receipt-pinned headless command
without importing the OpenClaw Fabric adapter.

The optional semantic-turn path uses `runtime/semantic-turn.sh` and `runtime/semantic-turn.mts`.
The shell wrapper reads the existing protected gateway environment in the sandbox. The TypeScript
adapter translates the closed semantic request into OpenClaw WebSocket frames and returns only
`started`, `text`, `completed`, or `failed` events. OpenClaw credentials, run IDs, and native frames
stay inside the package. NemoClaw core executes the declared command through OpenShell and owns the
receipt check, timeout, stream limits, event delivery, and cancellation.

`start.sh` is the readable process entry point. It loads package-owned modules from `runtime/`, then prepares state, applies provider routing, configures the gateway, and supervises the OpenClaw process. The modules keep each startup responsibility visible without adding callbacks to NemoClaw core:

- `runtime/runtime-state.sh` protects and recovers native configuration state.
- `runtime/gateway-timing.sh` writes the credential-free gateway startup timing record.
- `runtime/model-routing.sh` applies model, provider, and browser-origin overrides.
- `runtime/gateway-setup.sh` prepares messaging, gateway authentication, and automatic pairing.
- `runtime/startup-env.sh` prepares proxy, preload, and connect-shell environments.
- `runtime/sandbox-setup.sh` migrates state and prepares workspaces and plugins.
- `runtime/process-control.sh` starts, monitors, restarts, and stops the gateway.
- `runtime/auto-pair.py` implements the bounded automatic-pairing watcher.
- `runtime/semantic-turn.mts` translates the generic semantic-turn schema to the native gateway.

The `plugin/` code runs inside OpenClaw. Other `runtime/` helpers run as bounded commands in the sandbox.

NemoClaw core loads the agent-roster, configuration, MCP, and restore adapter files only after it verifies the
installed package receipt. Those files return bounded data or command plans. Core retains product
authorization, transaction, rollback, credential selection, and OpenShell registration decisions.
OpenShell retains credential custody and delivery, sandbox lifecycle, and enforcement authority.

## Compatibility debt

The files in `compat/` are not general package interfaces. Most patches target the pinned OpenClaw `2026.7.1` distribution. Each patch states its affected release, invalid state, and removal condition. Review this directory when the OpenClaw version changes.

`compat/shell-env.py` removes state written by older images. `compat/npm-remediation.mts` repairs reviewed package archives during a bounded dependency migration. `compat/dependency-review.md` records the dependency graph and its update checks.

## Large-file boundaries

Most remaining large implementation files are coherent security or build boundaries:

| File | Why it remains whole |
| --- | --- |
| `Dockerfile` | Builds and attests one ordered image graph; its final metadata checks cover the exact files assembled above them. |
| `runtime/config-guard.py` | Owns one descriptor-pinned configuration transaction, including recovery, mutation, sealing, and rollback. |
| `runtime/config-permissions.py` | Owns the corresponding mutable-tree ownership and permission transaction without reopening paths between validation and repair. |
| `compat/device-approval.mts` | Audits and applies one release-bound OpenClaw source transformation whose markers advance together. |
| `compat/npm-remediation.mts` | Verifies, repairs, repacks, and re-verifies one reviewed npm archive transaction. |
| `plugin/src/blueprint/runtime-identity.ts` | Keeps provider discovery, credential redaction, runtime probes, and signed identity validation in one trust boundary. |

The package lockfiles are generated dependency inventories. Do not split or hand-edit them; refresh them through the owning dependency workflow. Split one of the implementation boundaries only when the new interface can preserve the same validation, mutation, and rollback evidence.

`plugin/src/blueprint/runner.ts` is retained cleanup debt. At 2,320 lines, it combines blueprint
parsing, policy application, OpenShell commands, run-plan persistence, and the apply, status,
reconcile, and rollback actions. This adapter-contract slice does not refactor that plugin
orchestrator. A later change should split it along those existing action boundaries while
preserving its public exports, progress protocol, rollback behavior, and focused tests.

## Checks

- `checks/base-inputs.json` defines the files that determine the OpenClaw base image identity.
- `checks/extract-version.sh` rejects ambiguous OpenClaw version output during image builds.
- `checks/tool-search.mts` validates the generated Tool Search runtime before the image completes.
- `checks/wechat-lock.mts` validates the installed WeChat graph against its reviewed lockfile.

## Tests

`tests/config`, `tests/host`, `tests/runtime`, `tests/compat`, `tests/image`, and
`tests/integration` follow the package workflow described above. `tests/e2e` contains package-owned
assertions that depend on core E2E fixtures or scripts, so it runs in the composed
`test:nemoclaw` lane. A test in that directory contacts a live boundary only when its explicit
environment gate is enabled. Package-owned helpers stay under `tests/helpers`. Native plugin unit
tests remain beside their source under `plugin/src`. `messaging/runtime` is the canonical source
for OpenClaw channel preloads, and their native behavior tests live under `tests/runtime` and
`tests/compat`. The OpenClaw semantic-turn and native WebSocket tests also live under
`tests/runtime`; core tests cover only receipt-pinned command orchestration and the generic event
grammar.

Install the package and nested plugin locks, then run the checkout-independent lane:

```bash
npm ci --ignore-scripts
npm --prefix plugin ci --ignore-scripts
npm run test:package
npm run test:fabric
```

The complete OpenClaw command needs a surrounding NemoClaw checkout because the composed tests and
plugin consume named NemoClaw boundaries. A direct `npm test` does not pin that checkout. To prove
the layout against a supplied commit, run the `package-only` and `composed` in-tree overlay
rehearsals documented in [`packages/README.md`](../README.md) with package ID `openclaw`. The
composed rehearsal installs the nested plugin lock, builds the temporary CLI and plugin, runs both
package lanes, and verifies `nemoclaw harness install openclaw`, the human inventory, and the
receipt-verified digest from `nemoclaw harness list --json`.

`test:package` is package-only. It proves package adapters, runtime code, plugin behavior, checks,
and artifacts without importing NemoClaw source. The revision-pinned `composed` rehearsal supplies
the host operating system, runtime provider, hardware, and image-selection behavior from the
selected NemoClaw commit. Image qualification and focused live tests prove combinations that need
real OpenShell or external services.

`npm run test:fabric` tests the adapter without a NemoClaw source checkout.
`npm run test:fabric:composed` additionally runs the same adapter through the generic runner from
the surrounding NemoClaw checkout; `npm run test:nemoclaw` includes that composed proof.
`npm test` does not run `test:fabric` separately because the composed lane includes its direct
cases.
