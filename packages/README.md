<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent runtime packages

This directory contains the agent runtime packages that ship with NemoClaw.
The first package boundary is data-only and uses existing onboarding code.

Run these commands to inspect or install a package:

```bash
nemoclaw harness list
nemoclaw harness install <harness>
```

Installation copies a bundled package to `~/.nemoclaw/harnesses`.
Onboarding discovers installed packages before bundled packages.
Existing `nemoclaw onboard --agent <agent>` commands do not change.

## Package contract

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
It reads package data but does not import a package module.

Every agent runtime package must include the agent manifest named by
`nemoclaw.harnessManifest` and these files:

- `manifest.yaml` declares runtime identity, configuration paths, state, ports, and capabilities.
- `Dockerfile.base` builds the sandbox base image.
- `Dockerfile` builds the agent runtime image.
- `start.sh` starts the agent runtime in the sandbox.
- `policy-additions.yaml` defines the agent runtime's baseline network policy.

The registry requires each file to be a non-empty regular file and requires `start.sh` to be
executable. Packages can also include these optional paths:

- `policy-permissive.yaml` optionally defines the agent runtime's Shields down policy.
- `plugin/` optionally contains an agent runtime plugin.

Package-specific helpers, lockfiles, patches, schemas, and runtime plugins belong with these files.
Repository test projects continue to own integration and E2E coverage for the in-tree packages.
NemoClaw core continues to own command parsing, onboarding, OpenShell lifecycle operations,
credential custody, and the shared messaging-channel pipeline.

## Add a bundled package

1. Add `packages/nemoclaw-<id>` with valid metadata and a manifest.
2. Add the runtime image, startup, policy, and package-specific support files.
3. Run the package-contract and affected onboarding tests.
4. Add or extend the live E2E target for that agent runtime, then run it.

The registry discovers the package without a new command option or catalogue entry.
External package download and repository ownership are outside this in-tree migration.
