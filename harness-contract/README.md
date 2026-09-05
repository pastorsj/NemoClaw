<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw harness contract

This package is the typed authoring boundary for a NemoClaw harness package. It supplies types and
three build-time commands. It does not run a harness or grant host access.

The contract has no V1 or V2 product label. NemoClaw adds a typed operation only when core has a
current consumer and a package needs native translation for that operation.

## Package workflow

Use this sequence in a harness repository:

1. Create the required package files.
2. Declare data and fixed sandbox commands in `manifest.yaml`.
3. Add a typed host adapter only when a fixed command cannot express the native behavior.
4. Compile each `host/source/*-adapter.cts` file into its reviewed `host/*-adapter.cts` artifact.
5. Validate the package and its npm publish set.
6. Materialize a read-only install artifact.
7. Install that artifact with `nemoclaw harness install`.
8. Run the generic package lifecycle E2E against a pinned NemoClaw revision.

The package root uses this structure. Add only the folders that the harness needs.

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

## Authoring commands

Install this package as a development dependency. Then expose these scripts from the harness
package:

```json
{
  "scripts": {
    "build:adapters": "nemoclaw-build-adapters .",
    "check:adapters": "tsc -p tsconfig.adapters.json && npm run build:adapters -- --check",
    "check:package": "nemoclaw-validate-package .",
    "build:package": "nemoclaw-build-package . ./dist/nemoclaw-example"
  }
}
```

Run the commands in this order:

```bash
npm run check:adapters
npm run check:package
npm run build:package
nemoclaw harness install example \
  --from ./dist/nemoclaw-example \
  --yes-i-trust-local-package
```

`nemoclaw-build-adapters` compiles self-contained CommonJS artifacts. Imports are unavailable when
NemoClaw evaluates an adapter.

`nemoclaw-validate-package` checks identity, required files, adapter freshness, file types, modes,
credential-shaped paths, and the npm publish set. It runs `npm pack` with lifecycle scripts
disabled.

`nemoclaw-build-package` copies the validated publish set into a new read-only directory. It does
not replace an existing output.

## Typed operations

Import request, result, and module interfaces from `@nvidia/nemoclaw-harness-contract`. Current
interfaces cover:

- Runtime configuration updates, URL policy, and mutable configuration repair.
- Configuration restore merging.
- Model Context Protocol registration, removal, inspection, capability probes, and runtime intent.
- Managed startup environment, material, action, and integrity plans.

The module file and export name are fixed by NemoClaw core. A manifest cannot select executable
host code. An adapter returns a finite data plan and must not execute commands.

Use manifest data or a fixed sandbox command before you add a host adapter. A new operation needs:

- One current core consumer.
- One package implementation.
- Runtime request and result validation.
- Negative trust-boundary tests.
- Removal of the native harness branch that it replaces.

## Trust boundary

NemoClaw verifies the installed package receipt before it reads an adapter. It bounds and freezes
the request and result. Core retains credential custody, policy authorization, privileged
execution, transaction order, rollback, and redacted diagnostics.

The adapter VM limits available capabilities. It is not a security boundary for hostile code.
Install a local package only after you review and trust its complete contents.

NeMo Fabric is the sandbox-local headless data plane. It does not replace this host contract or the
NemoClaw control plane.

