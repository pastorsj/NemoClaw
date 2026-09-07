<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pi agent runtime package

This package connects Pi to the agent runtime package contract in
[`packages/README.md`](../README.md). It owns the Pi images, native model configuration, sandbox
startup, policy additions, dependency lock, and deterministic package tests. NemoClaw core owns
package discovery, onboarding, OpenShell coordination, product state, and lifecycle recovery.

This package integration and its typed boundary are a local proof of concept. They do not establish
Pi product support or an external package compatibility promise.

## Package workflow

1. `package.json` and `manifest.yaml` identify Pi and declare its data-only capabilities.
2. `Dockerfile.base` installs the locked Pi runtime from `runtime/pi`.
3. `Dockerfile` installs the native configuration generator, generic Fabric runner, Pi adapter,
   and sandbox startup entry point.
4. `runtime/generate-config.sh` exposes the fixed managed-startup command.
5. `config/generate-config.ts` writes Pi's credential-free native and Fabric configuration.
6. `start.sh` validates the managed proxy boundary before it starts the sandbox runtime.
7. `policy-additions.yaml` permits only the managed inference route by default.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Translates managed inference settings into Pi's native and Fabric configuration. |
| `fabric/` | Adapts Fabric's released lifecycle contract to Pi's stable headless command. |
| `host/` | Contains the typed immutable-configuration adapter. |
| `runtime/` | Contains the fixed configuration command and the locked Pi dependency graph. |
| `compat/` | Records the reviewed dependency baseline for the pinned Pi release. |
| `tests/` | Verifies configuration, the Fabric adapter, shell entry points, and package discovery. |

The package root contains the shared contract files: metadata, manifest, image definitions,
startup entry point, and network policy additions.

## Typed adapter boundary

| Capability | Package file | Current behavior |
| --- | --- | --- |
| Command and Fabric | `manifest.runtime` and `fabric/` | Declares terminal and headless commands; Fabric translates a request to Pi's non-session command. |
| Configuration | `host/config-adapter.cts` | Returns `immutable`; re-onboarding must materialize a changed model catalogue. |
| Roster | Not declared | Core returns the typed unsupported result for receipt-backed Pi sandboxes. |
| MCP | Disabled | Core rejects the capability before it loads an MCP adapter. |
| Messaging | `host/messaging-adapter.cts` | Returns the typed disabled integration. |
| Sessions | `host/session-adapter.cts` | Returns the declared empty operation set. |
| Startup | `host/startup-adapter.cts` | Builds and reconciles the managed-image startup profile. |
| State and restore | `state_lifecycle` and `state_files` | Declares Pi state and a core-owned key-allowlist settings restore. No package restore adapter is needed. |
| Policy and provider profiles | `manifest.policy` | Owns no optional presets or provider profiles. |
| Provider auth, broker, and managed tools | The broker is disabled | Provider authentication and managed tools are not declared. |
| Dashboard and secondary forward | Not declared | Core does not allocate a package UI or secondary endpoint. |

## Runtime flow

Managed startup invokes `/usr/local/lib/nemoclaw/generate-config`. The package wrapper runs
`config/generate-config.ts`, which writes `/sandbox/.pi/agent/models.json` and
`/sandbox/.pi/agent/fabric.json` with mode `0600`. The native catalog and Fabric configuration
contain the managed route and model metadata. They refer to the sandbox route credential by
environment-variable name and do not copy upstream provider credentials into Pi state.

`start.sh` reads the root-owned proxy host and port files, removes untrusted proxy overrides, and
starts the managed bootstrap path. Interactive use calls Pi directly. Headless use calls
`nemoclaw-fabric`, which discovers the root-owned `nvidia.nemoclaw.pi` descriptor and invokes the
package-owned Python adapter. The adapter projects Fabric's model, instructions, tools, skills,
and workspace onto Pi's documented non-session command.

## Compatibility debt

`runtime/pi/package-lock.json` pins Pi `0.84.1` and its production dependency graph.
`compat/dependencies.md` records the reviewed integrity and audit evidence. Update the package pin,
lock, compatibility record, image checks, and focused tests together.

## Tests

Install the package development lock and run the checkout-independent lane:

```bash
npm ci --ignore-scripts
npm run test:package
npm run test:fabric
```

Run `npm run test:nemoclaw` inside a surrounding NemoClaw checkout to verify that core discovers the
Pi package and to exercise the package adapter through that checkout's generic Fabric runner.
`npm run test:fabric` stays checkout independent, while `npm run test:fabric:composed` names the
ambient checkout boundary. `npm test` runs the package and ambient composition lanes; the composed
Fabric lane includes the direct Fabric cases. Use the `composed` in-tree overlay rehearsal in
[`packages/README.md`](../README.md) with package ID `pi` to pin a supplied core commit.

`test:package` is package-only. It proves package adapters, configuration, Fabric translation, and
the install artifact without importing NemoClaw source. The revision-pinned `composed` rehearsal
supplies the host operating system, runtime provider, hardware, and image-selection behavior from
the selected NemoClaw commit. The Pi qualification journey proves the concrete managed image and
live OpenShell boundaries.

Pi provides the same generic live-package fixture consumed by
[`tools/e2e/fabric-package.mts`](../../tools/e2e/fabric-package.mts). Core exposes Pi only when the
caller also supplies an already-valid protected qualification receipt for the matching managed
image; the generic runner preserves that authority without adding a Pi branch. The
[`pi-agent-qualification` journey](../../test/e2e/live/pi-agent-qualification.test.ts) remains the
producer and full live qualification lane. It covers package installation, qualified-image
onboarding, native and Fabric turns, restart and rebuild recovery, and cleanup.

`tests/package/materialization.test.ts` uses the public harness-contract builder to validate Pi's
npm publish set and materialize its read-only install artifact. The test verifies the install
envelope, Fabric descriptor, authoring-file exclusion, and executable startup entry point.
