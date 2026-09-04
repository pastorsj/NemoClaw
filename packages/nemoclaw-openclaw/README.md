<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw harness package

This package is the OpenClaw integration layer for NemoClaw. The package owns OpenClaw-specific configuration, image contents, startup behavior, runtime helpers, plugins, and compatibility code. NemoClaw core owns package discovery, onboarding, credential collection and selection, OpenShell registration, policy requests, and product rollback decisions. OpenShell owns credential custody and delivery, sandbox lifecycle, and enforcement authority.

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

The fixed `runtime/generate-config.sh` command lets NemoClaw request native configuration without selecting an OpenClaw implementation in core.

Nested production projects use `npm-shrinkwrap.json`. npm publishes that standard lockfile, and the image build copies it to the existing in-image `package-lock.json` paths consumed by integrity checks. This keeps a registry-installed harness reproducible without changing the runtime layout.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Generates native OpenClaw configuration and holds the plugin manifest schema. |
| `fabric/` | Implements the small OpenClaw adapter and pins its Fabric dependency graph. |
| `host/` | Holds receipt-verified CommonJS helpers that NemoClaw core loads during transitions. |
| `runtime/` | Holds in-sandbox commands, protection helpers, preloads, state plans, and locked dependency graphs. |
| `compat/` | Holds upstream-version patches, legacy cleanup, and reviewed npm remediation. |
| `plugin/` | Implements the NemoClaw commands that OpenClaw loads through its plugin mechanism. |
| `checks/` | Validates build inputs, OpenClaw versions, Tool Search behavior, and the WeChat dependency graph. |
| `policies/` | Holds OpenClaw policy presets. |
| `model-specific-setup/` | Holds OpenClaw model compatibility manifests at the repository-defined path. |
| `openclaw-plugins/` | Holds executable OpenClaw compatibility plugins at the repository-defined path. |

The package root contains the files that NemoClaw and package tools discover directly. Each support file lives under the directory that names its execution responsibility.

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

`start.sh` is the readable process entry point. It loads package-owned modules from `runtime/`, then prepares state, applies provider routing, configures the gateway, and supervises the OpenClaw process. The modules keep each startup responsibility visible without adding callbacks to NemoClaw core:

- `runtime/runtime-state.sh` protects and recovers native configuration state.
- `runtime/gateway-timing.sh` writes the credential-free gateway startup timing record.
- `runtime/model-routing.sh` applies model, provider, and browser-origin overrides.
- `runtime/gateway-setup.sh` prepares messaging, gateway authentication, and automatic pairing.
- `runtime/startup-env.sh` prepares proxy, preload, and connect-shell environments.
- `runtime/sandbox-setup.sh` migrates state and prepares workspaces and plugins.
- `runtime/process-control.sh` starts, monitors, restarts, and stops the gateway.
- `runtime/auto-pair.py` implements the bounded automatic-pairing watcher.

The `plugin/` code runs inside OpenClaw. Other `runtime/` helpers run as bounded commands in the sandbox.

NemoClaw core loads `host/` helpers only after it verifies the installed package receipt. These helpers describe OpenClaw configuration grammar, restore behavior, CLI grammar, and MCP adapter commands. Core retains product authorization, transaction, rollback, credential selection, and OpenShell registration decisions around those operations. OpenShell retains credential custody and delivery, sandbox lifecycle, and enforcement authority.

## Compatibility debt

The files in `compat/` are not general package interfaces. Most patches target the pinned OpenClaw `2026.7.1` distribution. Each patch states its affected release, invalid state, and removal condition. Review this directory when the OpenClaw version changes.

`compat/shell-env.py` removes state written by older images. `compat/npm-remediation.mts` repairs reviewed package archives during a bounded dependency migration. `compat/dependency-review.md` records the dependency graph and its update checks.

## Large-file boundaries

The remaining large implementation files are deliberate boundaries, not hidden workflow files:

| File | Why it remains whole |
| --- | --- |
| `Dockerfile` | Builds and attests one ordered image graph; its final metadata checks cover the exact files assembled above them. |
| `runtime/config-guard.py` | Owns one descriptor-pinned configuration transaction, including recovery, mutation, sealing, and rollback. |
| `runtime/config-permissions.py` | Owns the corresponding mutable-tree ownership and permission transaction without reopening paths between validation and repair. |
| `compat/device-approval.mts` | Audits and applies one release-bound OpenClaw source transformation whose markers advance together. |
| `compat/npm-remediation.mts` | Verifies, repairs, repacks, and re-verifies one reviewed npm archive transaction. |
| `plugin/src/blueprint/runtime-identity.ts` | Keeps provider discovery, credential redaction, runtime probes, and signed identity validation in one trust boundary. |

The package lockfiles are generated dependency inventories. Do not split or hand-edit them; refresh them through the owning dependency workflow. Split one of the implementation boundaries only when the new interface can preserve the same validation, mutation, and rollback evidence.

## Checks

- `checks/base-inputs.json` defines the files that determine the OpenClaw base image identity.
- `checks/extract-version.sh` rejects ambiguous OpenClaw version output during image builds.
- `checks/tool-search.mts` validates the generated Tool Search runtime before the image completes.
- `checks/wechat-lock.mts` validates the installed WeChat graph against its reviewed lockfile.

## Tests

`tests/config`, `tests/runtime`, `tests/compat`, `tests/image`, and `tests/integration` follow the package workflow described above. Package-owned helpers stay under `tests/helpers`. Native plugin unit tests remain beside their source under `plugin/src`.

Install the package and nested plugin locks, then run the checkout-independent lane:

```bash
npm ci --ignore-scripts
npm --prefix plugin ci --ignore-scripts
npm run test:package
npm run test:fabric
```

The complete OpenClaw command also needs an exact NemoClaw checkout because the composed tests and plugin still consume named NemoClaw boundaries. To prove that layout from a separate candidate checkout, run the `package-only` and `composed` in-tree overlay rehearsals documented in [`packages/README.md`](../README.md) with package ID `openclaw`. The composed rehearsal installs the nested plugin lock, builds the temporary CLI and plugin, runs both package lanes, and verifies `nemoclaw harness install openclaw`, the human inventory, and the receipt-verified digest from `nemoclaw harness list --json`.

`npm run test:fabric` tests the adapter without a NemoClaw source checkout.
`npm run test:fabric:composed` additionally runs the same adapter through the generic runner from
the exact surrounding NemoClaw checkout; `npm run test:nemoclaw` includes that composed proof.
