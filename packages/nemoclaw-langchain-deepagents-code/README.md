<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code package

This package is the NemoClaw integration layer for the LangChain Deep Agents Code agent runtime.
The root files declare the package and image contract. The responsibility directories contain the
code that implements each stage of that contract.

## Package workflow

1. `package.json` and `manifest.yaml` identify Deep Agents Code and declare its data-only capabilities.
2. `Dockerfile.base` installs the exact Python dependency set from
   `runtime/requirements.lock`.
3. `Dockerfile` installs the package-owned configuration, runtime, plugin, and compatibility code
   into the final sandbox image.
4. `runtime/generate-config.sh` runs `config/entrypoint.ts`, which loads
   `config/generate-config.ts` and writes the native Deep Agents Code configuration.
5. `start.sh` prepares writable state and launches the managed startup hold. Interactive and
   headless `dcode` commands then pass through the package-owned launch chain.
6. Image-build checks verify the pinned plugin, runtime patch, tool disclosure, observability, and
   read-only Model Context Protocol call before the image is accepted.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Translates NemoClaw inference selections into native Deep Agents Code configuration. |
| `runtime/` | Contains the sandbox launch chain, runtime guards, installed features, and dependency locks. |
| `host/` | Exposes receipt-verified CommonJS helpers that NemoClaw core loads for identity, Model Context Protocol state, and base-image qualification. |
| `compat/` | Records and applies changes tied to the pinned upstream Deep Agents Code version. |
| `plugin/` | Registers NemoClaw-managed model-profile aliases through the upstream plugin entry point. |
| `checks/` | Validates the installed plugin, patched runtime, and managed runtime features while the image builds. |

The package root keeps only the shared package contract: metadata, the agent manifest, image
definitions, startup, and network policy additions.

## Runtime flow

The final image exposes `/usr/local/bin/dcode`, `dcode.real`, and `deepagents-code` through the same
root-owned launcher. `runtime/agent-launcher.sh` validates the process boundary and starts
`runtime/session-supervisor.py`. The supervisor contains the process tree, then delegates to
`runtime/agent-wrapper.sh`. The wrapper validates managed inference and observability inputs before
it invokes the pinned Python agent runtime. Status, identity, and managed help output live in
`runtime/agent-status.sh`, which the wrapper loads only for those commands.

The compatibility patch installs `runtime/managed-runtime.py`, `runtime/tool-disclosure.py`, and
`runtime/observability.py` into the pinned upstream package. The wrapper also exposes
`runtime/readonly-mcp.py` for deterministic read-only tool calls. Repository file names describe
their package responsibilities; the Dockerfile preserves established paths inside the image so the
external command behavior does not change.

`runtime/managed-runtime.py` remains one security module because the compatibility patch installs
it as the upstream runtime-invariant boundary. It validates environment, managed inference, sealed
Model Context Protocol state, proxy access, approval, and reasoning settings before patched
upstream call sites use them. `runtime/observability.py` remains one export boundary because its
capture limits, redaction, middleware, and exporter lifecycle must apply together. Splitting either
module would add import boundaries inside the pinned upstream patch without simplifying package
startup.

## Compatibility debt

`compat/runtime-patch.py` is intentionally version-bound. It checks the installed Deep Agents Code
version and exact upstream symbols before it changes third-party source. `compat/dependencies.md`
records why each pinned workaround exists, how tests detect drift, and when the workaround can be
removed. `plugin/` also validates the exact Deep Agents and Deep Agents Code versions because its
managed model aliases depend on reviewed upstream profile internals.

Treat changes in `runtime/requirements.lock`, the compatibility patch, or plugin source as one
semantic dependency migration. Update their version checks, hashes, compatibility notes, and
focused tests together.

## Large-file boundaries

`runtime/requirements.lock` is the generated dependency inventory. `compat/runtime-patch.py`
validates and applies one version-bound upstream source transformation, so its symbol checks and
edits advance together. As described above, `runtime/managed-runtime.py` and
`runtime/observability.py` are single runtime trust boundaries. The larger programs under `checks/`
are self-contained image-build validators: they intentionally probe the installed environment
without importing mutable package source. Split any of these only after a smaller interface can
preserve the same pin, validation, and failure evidence.

## Checks

The Python programs in `checks/` run during the image build against the installed dependency set.
They fail the build when the plugin, runtime patch, observability boundary, tool-disclosure
middleware, or read-only Model Context Protocol command no longer matches its contract. The
Dockerfile removes build-only checks from the completed image.

Repository tests under `test/` cover configuration generation, launchers, runtime hardening,
plugin behavior, patch drift, and final-image layout. The package-contract tests also verify that
the files required by NemoClaw core are present in the packed npm artifact.
