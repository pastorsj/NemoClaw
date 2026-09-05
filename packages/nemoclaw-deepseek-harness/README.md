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

## Local checks

From this directory, run:

```bash
npm install
npm test
npm run typecheck
```

The composed test uses the sibling `packages/nemoclaw-fabric` checkout. Set
`NEMOCLAW_FABRIC_RUNNER_PATH` when that generic runner lives elsewhere.

With hosted-inference environment variables already set, run the complete
install-to-destroy proof from the NemoClaw checkout:

```bash
npx tsx tools/e2e/fabric-package.mts run \
  --contract packages/nemoclaw-deepseek-harness/tests/fixtures/live-contract.json
```

The same command accepts an absolute contract-fixture path from a package in a
different checkout. The runner finds its own NemoClaw root, so the fixture—not a
harness-specific core branch—selects the integration.
