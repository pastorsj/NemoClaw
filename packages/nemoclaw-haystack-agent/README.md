<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Haystack Agent package POC

This directory is a local proof of concept. It is not a supported or published NemoClaw
integration. It carries no compatibility commitment.

Haystack is a Python orchestration framework, not an always-on harness. It has no default agent
daemon or native interactive CLI. This POC constructs a small headless `Agent` from Haystack's
public API and invokes it through the shared typed NeMo Fabric lifecycle.

## Package workflow

```text
manifest.yaml
-> Dockerfile.base installs the exact Python dependency graph
-> Dockerfile installs the generic runner and package adapter
-> config/generate-config.ts writes the credential-free Fabric projection
-> start.sh holds the terminal sandbox open
-> nemoclaw sandbox agent sends one text request through Fabric
-> HaystackAgentRuntime constructs, invokes, and closes one Haystack Agent
```

The package supports one OpenAI-compatible model through NemoClaw's managed
`https://inference.local/v1` route. Its image configuration can represent a replacement system
instruction, model temperature, and a bounded agent-step count. The typed NemoClaw startup path
currently uses the existing defaults for those three values. Each invocation starts with the
current message. The POC does not claim durable conversation memory.

The manifest uses the typed `runtime.headless_environment` field for a public,
non-secret route marker required by Haystack's OpenAI-compatible client. The
actual inference credential remains in OpenShell; it is not stored in the image,
manifest, or generated Fabric configuration.

The package omits interactive UI, Hayhooks, MCP, skills, tools, messaging, persistent sessions,
background services, managed-image publication, and core agent-name registration. Those features
need separate product decisions.

## Contract map

| Surface | Package implementation |
| --- | --- |
| Command and Fabric | `manifest.runtime` sends terminal prompts through `nemoclaw-fabric-run`; `fabric/` constructs and invokes the Haystack agent. |
| Configuration | `host/config-adapter.cts` reports the image-generated Fabric configuration as immutable. |
| Messaging and sessions | The manifest declares disabled messaging and no session operations; the two typed adapters return those results. |
| State and restore | `state_lifecycle` declares no quiescence or post-restore action. No package restore adapter is needed. |
| Policy and provider profiles | The baseline policy contains the managed route. The package owns no optional presets or provider profiles. |
| Provider auth, broker, and managed tools | The broker is explicitly disabled. Provider authentication and managed tools are not declared. |
| Startup | `host/startup-adapter.cts` owns the durable package profile, finite Dockerfile inputs, managed state, corporate CA handoff, and trusted proxy material. |
| Roster, MCP, dashboard, and secondary forward | These capabilities are omitted or disabled. The package has no published managed image. |

This local POC uses the common typed disabled results. It does not inherit another package's
implementation when a capability is absent.

The startup profile deliberately keeps the current temperature `0`, eight-turn limit, and default
system instruction. Package-specific tuning is not accepted through ambient environment variables.
Adding operator-controlled tuning later requires an explicit typed contract capability.

## Files

- `manifest.yaml` declares the terminal command, state, inference, and disabled capabilities.
- `config/generate-config.ts` validates image inputs and writes `fabric.json` without credentials.
- `fabric/haystack-agent.fabric-adapter.json` states the exact typed Fabric surface.
- `fabric/src/nemoclaw_haystack_fabric/adapter.py` translates Fabric models and requests into the Haystack `Agent` API.
- `host/config-adapter.cts` tells NemoClaw that the image-generated config is immutable.
- `host/startup-adapter.cts` turns generic startup intent into Haystack image and state plans.
- `Dockerfile.base`, `Dockerfile`, and `start.sh` assemble and hold the sandbox runtime.
- `tests/` owns deterministic package, adapter, composition, and live-contract fixture checks.

## Local validation

```bash
npm ci
npm run typecheck
npm run test:package
npm run test:fabric
npm run test:fabric:composed
```

`npm run test:package` validates the npm publish set and materializes a read-only install artifact
through the public harness-contract builder.

`test:package` is package-only. It does not import NemoClaw source or prove a host operating
system, runtime provider, hardware target, or managed image. The revision-pinned `composed`
rehearsal supplies core-owned composition inputs from the selected NemoClaw commit. The live
fixture then proves the real OpenShell, process, policy, and inference boundaries.

The successful inference edge still requires a real NemoClaw-managed route. The package-local live fixture in `tests/fixtures/live-contract.json` supplies the generic E2E runner fields without adding the package ID to a core switch.

With hosted-inference environment variables already set, run the complete
install-to-destroy proof from the NemoClaw checkout:

```bash
npm --prefix packages/nemoclaw-haystack-agent run build:package
npx tsx tools/e2e/fabric-package.mts run \
  --contract packages/nemoclaw-haystack-agent/tests/fixtures/live-contract.json \
  --package-artifact packages/dist/haystack-agent
```

An external package can pass an absolute fixture path to this same command. The
runner resolves the NemoClaw checkout from its own module location.
