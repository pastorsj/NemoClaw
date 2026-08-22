<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model-Specific Setup Registry

The shared schema and registry guidance live in this directory.
Every model/provider compatibility manifest declares exactly one `agent` and lives with its owning agent runtime:

- `packages/nemoclaw-openclaw/model-specific-setup/openclaw/` for OpenClaw compatibility.
- `packages/nemoclaw-hermes/model-specific-setup/hermes/` for future Hermes compatibility.

Hermes has no model/provider compatibility manifests at this time.

Do not add shared multi-agent manifests in v1. OpenClaw and Hermes have different config files, plugin systems, replay behavior, and E2E paths, so a fix should be proven and reviewed for one agent at a time.

## Manifest Shape

Manifests follow `schema.json`:

- `id`: stable registry id.
- `agent`: exact agent id, for example `openclaw` or `hermes`.
- `description`: human-readable reason for the setup.
- `match`: model/provider route predicates.
- `effects`: declarative, agent-scoped effects.

The first OpenClaw entry is `packages/nemoclaw-openclaw/model-specific-setup/openclaw/kimi-k2.6-managed-inference.json`. It preserves the Kimi K2.6 managed `inference.local` compatibility behavior from PR #3046.

## Contributor Guidance

Put model-specific sandbox compatibility with its owning agent runtime, not directly in generator conditionals:

- Match logic belongs in a manifest.
- OpenClaw executable wrappers belong under `packages/nemoclaw-openclaw/openclaw-plugins/`.
- Hermes executable wrappers belong under `packages/nemoclaw-hermes/`.
- Runtime transformations stay in agent-owned code or plugins; registry manifests stay declarative.

Only add Hermes-specific Kimi behavior after a Hermes-specific failure or acceptance test proves it is needed.
