<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Haystack Agent package POC

This directory is a local, disposable proof of concept. It is not a supported NemoClaw integration, is not published, and carries no compatibility commitment.

Haystack is a Python orchestration framework, not a turnkey always-on harness. It has no default agent daemon or native interactive CLI to package. This POC therefore names the runnable product honestly: NemoClaw constructs a small headless `Agent` directly from Haystack's public API and invokes it through the same typed NeMo Fabric lifecycle used by other terminal packages.

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

The package supports one OpenAI-compatible model through NemoClaw's managed `https://inference.local/v1` route, a replacement system instruction, model temperature, and a bounded agent-step count. Each invocation starts with only the caller's current message; the POC does not claim durable conversation memory.

The manifest uses the typed `runtime.startup_environment` field for a public,
non-secret route marker required by Haystack's OpenAI-compatible client. The
actual inference credential remains in OpenShell; it is not stored in the image,
manifest, or generated Fabric configuration.

The following surfaces are intentionally absent: interactive UI, Hayhooks, MCP, skills, tools, messaging, persistent sessions, background services, managed-image publication, and core agent-name registration. Those are separate product decisions, not hidden adapter behavior.

## Files

- `manifest.yaml` declares the terminal command, state, inference, and disabled capabilities.
- `config/generate-config.ts` validates image inputs and writes `fabric.json` without credentials.
- `fabric/haystack-agent.fabric-adapter.json` states the exact typed Fabric surface.
- `fabric/src/nemoclaw_haystack_fabric/adapter.py` translates Fabric models and requests into the Haystack `Agent` API.
- `host/config-adapter.cts` tells NemoClaw that the image-generated config is immutable.
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

The successful inference edge still requires a real NemoClaw-managed route. The package-local live fixture in `tests/fixtures/live-contract.json` supplies the generic E2E runner fields without adding the package ID to a core switch.

With hosted-inference environment variables already set, run the complete
install-to-destroy proof from the NemoClaw checkout:

```bash
npx tsx tools/e2e/fabric-package.mts run \
  --contract packages/nemoclaw-haystack-agent/tests/fixtures/live-contract.json
```

An external package can pass an absolute fixture path to this same command. The
runner resolves the NemoClaw checkout from its own module location.
