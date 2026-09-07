<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DeepSeek Harness local POC

This package demonstrates one narrow integration: a plain terminal prompt goes
through NemoClaw's generic headless command, the released NeMo Fabric lifecycle,
and the published DeepSeek Harness Python SDK. It is a local research artifact,
not a supported, published, or managed-image NemoClaw integration.

The workflow is deliberately visible in the directory names:

1. `manifest.yaml` declares discovery, terminal execution, state, and policy.
2. `config/` turns NemoClaw's model selection into credential-free Fabric JSON.
3. `fabric/` validates that JSON, resolves the managed credential from the
   environment, and invokes the SDK with the fixed `sdk-minimal` profile.
4. `runtime/` and `start.sh` establish private state and the terminal process.
5. `tests/` owns deterministic package, adapter, composition, and E2E-contract
   evidence without adding a DeepSeek-specific branch to NemoClaw core.

The manifest's typed `runtime.headless_environment` supplies one public,
non-secret route marker to later OpenShell exec processes. The SDK requires a
non-empty API-key-shaped value, but the real inference credential remains owned
by OpenShell and never enters the package image, manifest, or Fabric config.

## Supported POC surface

- Plain-text input and one final text response
- OpenAI-compatible inference through `https://inference.local/v1`
- Replacement system instructions from Fabric configuration
- Private session state under `/sandbox/.deepseek-harness`
- Fabric deadlines plus adapter cancellation and process-group cleanup

Streaming, MCP, messaging, skills, subagents, configurable tool lists, runtime
updates, and service mode are intentionally absent. The SDK-minimal shell and
editor operate only inside the surrounding OpenShell sandbox policy.

## Contract map

| Surface | Package implementation |
| --- | --- |
| Command and Fabric | `manifest.runtime` sends terminal prompts through `nemoclaw-fabric-run`; `fabric/` translates the request to the SDK. |
| Configuration | `host/config-adapter.cts` reports the image-generated Fabric configuration as immutable. |
| Messaging and sessions | The manifest declares disabled messaging and no session operations; the two typed adapters return those results. |
| State and restore | `state_lifecycle` and `state_dirs` declare backup behavior. No package restore adapter is needed. |
| Policy and provider profiles | The baseline policy contains the managed route. The package owns no optional presets or provider profiles. |
| Provider auth, broker, and managed tools | The broker is explicitly disabled. Provider authentication and managed tools are not declared. |
| Startup | `host/startup-adapter.cts` translates generic inference and proxy input into the package's build, runtime, state, and rebuild profile. |
| Roster, MCP, dashboard, and secondary forward | These capabilities are omitted or disabled. |

This local POC uses the common typed disabled results. It does not inherit another package's
implementation when a capability is absent.

## Local checks

From this directory, run:

```bash
npm install
npm test
npm run typecheck
```

`npm run test:package` validates the npm publish set and materializes a read-only install artifact
through the public harness-contract builder.

`test:package` is package-only. It does not import NemoClaw source or prove a host operating
system, runtime provider, hardware target, or managed image. The revision-pinned `composed`
rehearsal supplies core-owned composition inputs from the selected NemoClaw commit. The live
fixture then proves the real OpenShell, process, policy, and inference boundaries.

The composed test uses the sibling `packages/nemoclaw-fabric` checkout. Set
`NEMOCLAW_FABRIC_RUNNER_PATH` when that generic runner lives elsewhere.

With hosted-inference environment variables already set, run the complete
install-to-destroy proof from the NemoClaw checkout:

```bash
npm --prefix packages/nemoclaw-deepseek-harness run build:package
npx tsx tools/e2e/fabric-package.mts run \
  --contract packages/nemoclaw-deepseek-harness/tests/fixtures/live-contract.json \
  --package-artifact packages/dist/deepseek-harness
```

The same command accepts an absolute contract-fixture path from a package in a
different checkout. The runner finds its own NemoClaw root, so the fixture—not a
harness-specific core branch—selects the integration.
