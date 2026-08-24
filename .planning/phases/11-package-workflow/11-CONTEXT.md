<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 11 Context: Package Workflow

## Goal

Make each in-tree agent runtime package explain the same integration workflow without forcing the
three agent runtimes to share their internal implementation.

This phase is a local implementation candidate. It does not establish product support or authorize
publication. All commits remain local until the user authorizes a remote write.

## Success Conditions

- OpenClaw, Hermes, and LangChain Deep Agents Code keep the existing onboarding experience.
- Each package uses the same root contract and the same responsibility-based directory vocabulary.
- Each package installs `/usr/local/lib/nemoclaw/generate-config` for managed startup.
- NemoClaw core invokes that fixed command and does not select a generator by agent ID.
- Package-specific compatibility code stays package-owned and is visible as compatibility code.
- Each package README explains build, configuration, startup, runtime, and validation in that order.
- Deterministic tests and one credential-free live environment prove the changed boundaries.
- Live messaging-service tests remain excluded.

## Package Workflow

The package root contains only files that NemoClaw discovers directly or that standard package
tools expect at the root:

```text
README.md
package.json
manifest.yaml
Dockerfile.base
Dockerfile
start.sh
policy-additions.yaml
```

Packages add only the directories their implementation needs:

```text
config/       build-time native configuration
runtime/      in-sandbox commands and long-running helpers
host/         receipt-verified transition helpers still executed by core
compat/       version-bound upstream patches and workarounds
plugin/       code loaded through the agent runtime's plugin mechanism
checks/       package-owned build and behavior checks
policies/     package-owned policy presets
```

File names use one or two words when that names the responsibility. A third word is allowed only
when removing it makes the responsibility ambiguous. Function and class names use enough words to
state the action and object.

## Boundary Decisions

- The first common executable contract is configuration generation. All three managed images use
  the same in-sandbox command path.
- The manifest, image, start command, policy, state, service, and inference fields remain the main
  declarative contract.
- Current host helpers remain bounded transition code. This phase groups and documents them before
  it generalizes any additional host capability.
- MCP remains on its existing security-reviewed behavior while package files move. A later task can
  replace its closed adapter dispatch only after the fixed in-sandbox mutation boundary is explicit.
- Shared structure does not require empty directories or identical internal files.

## Validation Boundary

The phase runs package-contract, focused CLI and integration tests, TypeScript checks, repository
checks, and the relevant no-messaging live target. It does not use Telegram, Discord, Slack,
WeChat, WhatsApp, Microsoft Teams, or Google Chat accounts.
