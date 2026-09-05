<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pi agent runtime package

This package connects Pi to the agent runtime package contract in
[`packages/README.md`](../README.md). It owns the Pi images, native model configuration, sandbox
startup, policy additions, dependency lock, and deterministic package tests. NemoClaw core owns
package discovery, onboarding, OpenShell coordination, product state, and lifecycle recovery.

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
| Runtime configuration | `host/config-adapter.cts` | Returns `immutable`; re-onboarding must materialize a changed model catalog. |
| MCP | None | The manifest disables MCP, so core rejects the capability before adapter load. |
| Configuration restore | None | Pi has no package configuration merge operation. |

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

Pi intentionally does not provide the generic live-package fixture used by
[`tools/e2e/fabric-package.mts`](../../tools/e2e/fabric-package.mts). That journey performs ordinary
onboarding. Core exposes Pi only with a published qualification receipt and the matching
managed-image catalog. The
[`pi-agent-qualification` journey](../../test/e2e/live/pi-agent-qualification.test.ts) owns Pi's
live test. It covers package installation, qualified-image onboarding, native and Fabric turns,
restart and rebuild recovery, and cleanup. Pi can adopt the ordinary package journey after it
becomes selectable without candidate qualification.

Pi does not yet have a package-owned archive test. The root
`test/package-contract/bundled-harnesses.test.ts` test verifies its materialized package and packed
root artifact. Add a package-owned archive test before Pi moves to an independent repository.
