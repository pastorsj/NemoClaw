<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw agent runtime package

This package is the OpenClaw integration layer for NemoClaw. The package owns OpenClaw-specific
configuration, image contents, startup behavior, runtime helpers, plugins, and compatibility code.
NemoClaw core owns package discovery, onboarding, credentials, policy application, and sandbox
lifecycle operations.

## Package workflow

The package follows one sequence:

1. `manifest.yaml` describes the agent runtime and its NemoClaw capabilities.
2. `Dockerfile.base` installs the pinned OpenClaw and Model Context Protocol (MCP) dependency graphs.
3. `Dockerfile` adds package configuration, runtime helpers, plugins, policies, and compatibility patches.
4. `config/generate-config.mts` translates managed startup settings into `openclaw.json`.
5. `start.sh` prepares protected state and starts the OpenClaw agent gateway.
6. Files in `runtime/` support the running sandbox.
7. Files in `compat/` adapt the pinned OpenClaw release where its native behavior is not sufficient.
8. Files in `checks/` reject version, dependency, and generated-runtime drift during image builds.

The fixed `runtime/generate-config.sh` command lets NemoClaw request native configuration without
selecting an OpenClaw implementation in core.

## Directory guide

| Path | Responsibility |
| --- | --- |
| `config/` | Generates native OpenClaw configuration and holds the plugin manifest schema. |
| `host/` | Holds receipt-verified CommonJS helpers that NemoClaw core loads during transitions. |
| `runtime/` | Holds in-sandbox commands, protection helpers, preloads, state plans, and locked dependency graphs. |
| `compat/` | Holds upstream-version patches, legacy cleanup, and reviewed npm remediation. |
| `plugin/` | Implements the NemoClaw commands that OpenClaw loads through its plugin mechanism. |
| `checks/` | Validates build inputs, OpenClaw versions, Tool Search behavior, and the WeChat dependency graph. |
| `policies/` | Holds OpenClaw policy presets and the policies used for Shields down. |
| `model-specific-setup/` | Holds OpenClaw model compatibility manifests at the repository-defined path. |
| `openclaw-plugins/` | Holds executable OpenClaw compatibility plugins at the repository-defined path. |

The package root contains the files that NemoClaw and package tools discover directly. Each
support file lives under the directory that names its execution responsibility.

## Runtime flow

`Dockerfile` copies `config/generate-config.mts` into the image and invokes it with managed
startup settings. The generator writes OpenClaw's native configuration. Managed startup can invoke
`/usr/local/lib/nemoclaw/generate-config` again through the same package-owned generator.

`start.sh` then prepares the OpenClaw state directories, applies the state protection plan, loads
the required runtime preloads, and starts the OpenClaw agent gateway. The `plugin/` code runs
inside OpenClaw. Other `runtime/` helpers run as bounded commands in the sandbox.

NemoClaw core loads `host/` helpers only after it verifies the installed package receipt. These
helpers describe OpenClaw configuration grammar, restore behavior, CLI grammar, and MCP adapter
commands. Core retains the lifecycle and credential decisions around those operations.

## Compatibility debt

The files in `compat/` are not general package interfaces. Most patches target the pinned
OpenClaw `2026.7.1` distribution. Each patch states its affected release, invalid state, and removal
condition. Review this directory when the OpenClaw version changes.

`compat/shell-env.py` removes state written by older images. `compat/npm-remediation.mts` repairs
reviewed package archives during a bounded dependency migration. `compat/dependency-review.md`
records the dependency graph and its update checks.

## Checks

- `checks/base-inputs.json` defines the files that determine the OpenClaw base image identity.
- `checks/extract-version.sh` rejects ambiguous OpenClaw version output during image builds.
- `checks/tool-search.mts` validates the generated Tool Search runtime before the image completes.
- `checks/wechat-lock.mts` validates the installed WeChat graph against its reviewed lockfile.

Repository integration tests cover the Dockerfile contracts, startup behavior, host helper
contracts, compatibility patches, plugin behavior, and build-context staging.
