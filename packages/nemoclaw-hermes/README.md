<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes agent runtime package

This package connects Hermes to the agent-runtime contract described in
[`packages/README.md`](../README.md). The package owns the Hermes image, native configuration,
sandbox startup, runtime guards, upstream compatibility work, and package checks. NemoClaw core
continues to own package discovery, onboarding, credentials, OpenShell lifecycle operations, and
shared messaging orchestration.

## Package workflow

The workflow reads from top to bottom:

1. `Dockerfile.base` builds the pinned Hermes base and applies reviewed dependency patches.
2. `Dockerfile` assembles the NemoClaw image from package-owned configuration, runtime, plugin,
   policy, and compatibility files.
3. `config/generate-config.ts` translates managed startup inputs into Hermes configuration.
4. `start.sh` starts the gateway, dashboard, and supervised services.
5. `runtime/` protects configuration and state while the sandbox is running.
6. `compat/` adapts the pinned upstream release where its native behavior does not yet meet the
   NemoClaw contract.
7. `checks/` validates those build and compatibility boundaries.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Builds Hermes `config.yaml`, `.env`, managed policy, model setup, and tool-gateway settings. |
| `runtime/` | Provides commands and guards installed into the sandbox. `runtime/state/` is the bounded state-mutation subsystem. |
| `host/` | Provides receipt-verified helpers that NemoClaw core loads for managed routes, MCP, image qualification, and the tool gateway. |
| `compat/` | Contains version-bound patches for the pinned Hermes release. |
| `plugin/` | Contains code loaded through Hermes' plugin mechanism. |
| `checks/` | Provides build probes, the CLI contract validator, source download verification, and the release update command. |
| `policies/` | Contains the permissive policy and Hermes-only policy presets. |
| `provider-profiles/` | Contains package-owned OpenShell provider profiles. |
| `model-specific-setup/` | Contains package-owned model compatibility declarations used by existing NemoClaw discovery paths. |

`manifest.yaml`, the two Dockerfiles, `start.sh`, and `policy-additions.yaml` are the common package
contract. `portable-build-context.json` stays at the root because the Portable context loader reads
that exact metadata location.

## Runtime flow

Managed startup invokes the fixed `/usr/local/lib/nemoclaw/generate-config` command. The package
wrapper runs `config/generate-config.ts`, which writes Hermes-native configuration. `start.sh` then
validates the environment boundary, prepares the dashboard profile, establishes the configuration
hash, and launches the gateway.

The CLI wrapper and adapter preserve the managed Hermes command surface. The configuration guard,
MCP transaction, cron control, and state-mutation subsystem reconcile mutable state without moving
those protocols into NemoClaw core. Host helpers remain data- and receipt-bound entry points for
the core operations that still need them.

## Compatibility debt

Files in `compat/` are tied to Hermes release `v2026.7.20` (`0.19.0`). Each patch checks the
reviewed upstream source shape and fails when that shape changes. Remove a patch when Hermes owns
the required behavior; otherwise refresh its source binding and focused test during an upgrade.

The large runtime guards retain their existing security protocols in this refactor. Their size is
visible debt, but splitting them without an independent protocol boundary would make this move
harder to review and could change behavior.

## Checks

`checks/image-probes.py` validates patched behavior in the built image.
`checks/cli-adapter.py` compares the CLI adapter with the installed Hermes parser.
`checks/download-source.sh` verifies the pinned source archive, and `checks/update-agent.sh`
updates the reviewed release pins. Repository integration tests exercise configuration generation,
startup, MCP, state mutation, wrappers, policies, and the Portable inventory.
