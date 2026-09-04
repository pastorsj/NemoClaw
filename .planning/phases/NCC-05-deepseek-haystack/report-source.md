<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DeepSeek Harness and Haystack integration research

**Date:** 2026-09-04
**Branch:** `agent-runtime-composition-architecture`
**Audience:** NemoClaw product, architecture, security, package, and test owners

## Result

Both integrations can use the existing NemoClaw package boundary and NVIDIA NeMo Fabric. They do
not require a harness-specific branch in NemoClaw production code.

- DeepSeek Harness is an upstream agent harness. Its first supported surface should use the
  published Python SDK, the `sdk-minimal` profile, and one package-owned Fabric adapter.
- Haystack is a framework. It has no default agent process, command, or service. NemoClaw can use
  Haystack only by owning a specific agent or by defining a loader for separately registered
  Haystack applications. The smallest useful first surface is a NemoClaw-authored, headless
  `Haystack Agent` with a package-owned Fabric adapter.
- NemoClaw core should continue to own package identity, host and runtime selection, credentials,
  managed inference, policy authority, lifecycle transactions, rollback, and state safety.
- Each package should own its upstream dependency graph, native configuration, Fabric adapter,
  image, startup, policy additions, compatibility notes, and package-specific tests.
- Fast tests should prove nearly all adapter behavior. One focused live journey on macOS ARM64 and
  one on Brev Linux AMD64 should prove the external system boundaries.

Implementation is not authorized at this baseline. The repository product scope gate requires an
accepted decision before adding a supported third-party integration. DeepSeek issue
[#9329](https://github.com/NVIDIA/NemoClaw/issues/9329) remains `Proposed`, with every acceptance
box open. Haystack has no NemoClaw product-scope issue or accepted design decision. This report
therefore supplies the evidence and decision text needed to unblock implementation. It does not
claim product support or live qualification.

## Direct recommendation

Use these package identities after product acceptance:

| Integration | NemoClaw package ID | Fabric adapter ID | First surface |
| --- | --- | --- | --- |
| DeepSeek Harness | `deepseek-harness` | `nvidia.nemoclaw.deepseek-harness` | Headless SDK runtime |
| Haystack | `haystack-agent` | `nvidia.nemoclaw.haystack-agent` | Headless NemoClaw-owned agent |

Do not call the second package only `haystack`. That name would imply that the Haystack framework
ships a runnable harness. The display name can be `Haystack Agent`.

Keep the NemoClaw harness contract unversioned. NeMo Fabric's published descriptor contains its
own external contract identifier, currently `fabric.adapter/v1alpha2`; NemoClaw should consume
that identifier rather than create a parallel NemoClaw adapter version.

## Evidence

### NeMo Fabric

NeMo Fabric already defines the required southbound seam. Its adapter contract gives consumers
one configuration, planning, lifecycle, result, error, artifact, and telemetry model. An adapter
owns target translation, runtime state, invocation, and cleanup. The minimum adapter has a
discoverable descriptor plus `start`, ordered `invoke`, and `stop` operations. See the
[adapter contract](https://github.com/NVIDIA/NeMo-Fabric/blob/main/docs/adapter-contract/README.md),
[custom-agent decision guide](https://github.com/NVIDIA/NeMo-Fabric/blob/main/docs/adapter-contract/custom-agents.md),
and [adapter inventory](https://github.com/NVIDIA/NeMo-Fabric/blob/main/adapters/README.md).

The current released Fabric baseline is
[`0.2.0`](https://github.com/NVIDIA/NeMo-Fabric/releases/tag/v0.2.0). It contains no DeepSeek
Harness or Haystack adapter. Both integrations therefore need package-owned adapters until an
equivalent released Fabric adapter exists.

Fabric supports three integration shapes:

1. A harness adapter for an opinionated runtime.
2. A shared framework adapter that resolves separately registered target descriptors.
3. A dedicated custom-agent adapter for one application or agent family.

DeepSeek fits the first shape. The first Haystack package fits the third shape. A reusable Haystack
target loader can later adopt the second shape when a second accepted Haystack application proves
the need.

### DeepSeek Harness

DeepSeek Harness is an official upstream project with Web, headless, ACP, and SDK surfaces. Its
[repository](https://github.com/deepseek-ai/deepseek-harness) and
[published SDK guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/python/sdk/README.md)
identify the JSON-RPC SDK as a supported programmatic boundary.

The newest source tag observed during this research was
[`dsh-v0.1.3-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1).
The tested published baseline was `deepseek-harness-sdk==0.1.2rc1` with the same-version runtime
wheel. The project remains a developer preview and can make breaking changes. The package must pin
one complete dependency closure and require upgrade qualification. Do not use a compatible range.

The [`sdk-minimal` profile](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/bundle/sdk-minimal/README.md)
contains a persistent shell, a string-replace editor, JSONL session storage, and the SDK server. It
omits the Web surface, settings, managed credentials, telemetry, Web tools, skills, subagents, and
the default broad plugin tree. This is the smallest upstream composition that remains a useful
coding agent.

A local research probe installed the published SDK and runtime wheels on macOS ARM64. It started
`DeepSeekHarness(profile="sdk-minimal")`, called a credential-free local OpenAI-compatible test
server with an arbitrary model ID, returned the expected response, and persisted its session. This
proves the API shape. It is not NemoClaw live qualification.

The probe also found a required supervisor boundary. The Python SDK applies
`request_timeout_seconds` to JSON-RPC replies, but `Session.run()` can keep waiting for session
notifications after that timeout. A deliberately hung model exceeded a 30-second outer process
deadline. The package adapter must run each turn in a killable process group. The generic
`nemoclaw-fabric-run` deadline must remain authoritative.

DeepSeek's ACP surface is broader and includes sessions, cancellation, MCP, model selection, and
semantic updates. A generic ACP Fabric adapter could become reusable later. It should live in NeMo
Fabric, not NemoClaw core. There is no second accepted ACP consumer today, so it is not a
prerequisite for this package.

### Haystack

The current stable Haystack release is
[`haystack-ai==3.1.1`](https://pypi.org/project/haystack-ai/3.1.1/), published on 2026-09-03. It is
Apache-2.0 and requires Python 3.10 or newer. Its wheel has no console script. The project describes
itself as an orchestration framework, not an installed agent process. See the
[tagged source](https://github.com/deepset-ai/haystack/tree/d60cce01a778bc3498a02866fe288b3c07398649f)
and [project README](https://github.com/deepset-ai/haystack/blob/d60cce01a778bc3498a02866fe288b3c07398649f/README.md).

Haystack's [`Agent`](https://docs.haystack.deepset.ai/docs/agent) is a useful implementation seam.
It supports asynchronous execution, tools, bounded steps, hooks, explicit resource cleanup, and a
structured result. `OpenAIChatGenerator` accepts a custom base URL, model, timeout, retries, and an
environment-backed secret. These inputs map to NemoClaw managed inference without copying an
upstream provider credential into the sandbox.

The official `MockChatGenerator` supports deterministic adapter tests. A local research probe
installed `haystack-ai==3.1.1`, `mcp-haystack==1.5.1`, `nemo-fabric==0.2.0`, and the Fabric adapter
contract into one Python 3.13 environment. The 60-package closure passed `pip check`, and a direct
asynchronous Agent call with the mock generator completed. This proves dependency compatibility,
not image or live inference qualification.

Haystack sends anonymous usage telemetry by default. The package must set
`HAYSTACK_TELEMETRY_ENABLED=false`. It must also force `HAYSTACK_AUTO_TRACE_ENABLED=false` and
`HAYSTACK_CONTENT_TRACING_ENABLED=false`. See the official
[telemetry](https://docs.haystack.deepset.ai/docs/telemetry) and
[tracing](https://docs.haystack.deepset.ai/docs/tracing) references.

[Hayhooks](https://github.com/deepset-ai/hayhooks) can expose Haystack pipelines through REST, MCP,
or an OpenAI-compatible service. It is not required for the first package. Adding it would create a
server, port, authentication, CORS, and lifecycle surface without answering which agent NemoClaw
should run.

## Shared architecture

The existing package workflow remains the public workflow:

```text
nemoclaw harness install <package-id>
  -> discover package metadata
  -> validate and copy immutable package bytes
  -> publish receipt and active pointer

nemoclaw onboard --agent <package-id>
  -> resolve installed receipt
  -> select host OS, runtime provider, hardware, and serving route
  -> build or select the package image
  -> apply core-owned credentials and policy authority
  -> start the package entry point

nemoclaw sandbox agent <sandbox> <request>
  -> resolve receipt-pinned headless command
  -> pass request through standard input
  -> nemoclaw-fabric-run
  -> NeMo Fabric plan and doctor
  -> package Fabric adapter
  -> upstream runtime
  -> bounded normalized result
```

NemoClaw production code should not import either package. The package manifest and installed
receipt supply the identity. The current synthetic unknown-package composition test already proves
that the installer, Dockerfile selector, and terminal Fabric dispatch can use an unknown package
ID.

The current managed-image startup path still uses a closed agent set. The first qualification can
use the package Dockerfile path without adding a named core branch. Before stock buildless support,
core should replace the closed gate with a receipt-bound, manifest-driven managed-image contract.
That change must be generic and protected with a synthetic future-package test. It must not add
`deepseek-harness` or `haystack-agent` to another switch statement.

For the first in-tree, Docker-built, terminal, headless slice, the existing code needs no NemoClaw
production change. Discovery, install, selection, Docker staging, Fabric standard-input dispatch,
stop, start, snapshot authority, rebuild authority, and destroy already accept a package receipt
whose ID is unknown to core. The implementation delta belongs in the two packages and the generic
E2E target. Stock managed images, Web or dashboard surfaces, messaging, pairing, mutable runtime
configuration, MCP mutation, and interactive UI remain separate capabilities.

### Current NemoClaw seams

| Responsibility | Current source | Effect on these packages |
| --- | --- | --- |
| Package discovery and materialization | [`scripts/build-harnesses.mts`](../../../scripts/build-harnesses.mts) | Discovers `nemoclaw.harnessManifest` without an ID list |
| Install and list | [`src/commands/harness/install.ts`](../../../src/commands/harness/install.ts), [`list.ts`](../../../src/commands/harness/list.ts) | Uses catalogue entries and installed receipts |
| Onboarding selection | [`package-selection.ts`](../../../src/lib/onboard/package-selection.ts), [`sandbox-agent.ts`](../../../src/lib/onboard/sandbox-agent.ts) | Resolves an installed package and its manifest |
| Docker workload | [`source.ts`](../../../src/lib/onboard/workload/source.ts), [`build-context-stage.ts`](../../../src/lib/onboard/build-context-stage.ts) | Stages a receipt-matched package Dockerfile |
| Headless request | [`passthrough.ts`](../../../src/lib/actions/sandbox/agent/passthrough.ts) | Sends the request to the fixed Fabric command through standard input |
| Fabric runtime | [`packages/nemoclaw-fabric`](../../../packages/nemoclaw-fabric) | Owns generic SDK invocation, limits, artifacts, deadline, and cleanup |
| Unknown-package proof | [`package-composition.test.ts`](../../../test/onboarding/package-composition.test.ts) | Proves install, selection, Dockerfile, and Fabric dispatch for an unknown ID |
| Managed-image gate | [`contract.ts`](../../../src/lib/onboard/managed-image/contract.ts), [`profile.ts`](../../../src/lib/onboard/managed-startup/profile.ts) | Remains closed and is outside the first source-build slice |

## Contract mapping

The package adapter must implement the NeMo Fabric lifecycle without receiving NemoClaw host
authority.

```text
start(AgentConfig, RuntimeContext) -> isolated package runtime
invoke(AgentRunRequest)            -> one terminal AgentRunResult
stop()                             -> idempotent cleanup after any prior state
```

The shared rules are:

- Resolve one model and one environment-variable credential reference.
- Accept only declared configuration fields.
- Reject unsupported features during Fabric planning.
- Keep requests out of process arguments.
- Keep credential values out of generated configuration, logs, errors, artifacts, and receipts.
- Bound input, output, diagnostics, artifact count, and artifact size.
- Support ordered invokes within one runtime.
- Isolate two simultaneous runtimes.
- Clean up after partial start, failed invoke, timeout, cancellation, and repeated stop.
- Return stable error classes. Do not expose native exception text when it can contain input or
  credentials.

### DeepSeek mapping

| Fabric input | DeepSeek SDK input |
| --- | --- |
| `models[0].model` | `model` |
| `models[0].base_url` | managed `DEEPSEEK_BASE_URL` value |
| credential environment reference | in-memory `DEEPSEEK_API_KEY` child environment |
| replacement system instructions | `system_prompt` or a root-owned final patch |
| workspace | SDK `cwd` |
| runtime state root | explicit `dsh_home` |
| request text | JSON-RPC SDK session request through standard input |

The descriptor should initially claim models, model base URL, replacement system instructions,
plain-text input, and text output. It should reject normalized streaming, service mode, live
updates, MCP, skills, subagents, and configurable tools. The `sdk-minimal` profile supplies its
fixed shell and editor roster.

Each invoke should run in a child process group. A bounded parent protocol should receive the
request through standard input and return one normalized result. On timeout, the adapter should
send `TERM`, wait for the configured grace interval, send `KILL`, reap the full process group, and
verify that no marked descendant remains.

### Haystack mapping

| Fabric input | Haystack input |
| --- | --- |
| `models[0].model` | `OpenAIChatGenerator.model` |
| `models[0].base_url` | `OpenAIChatGenerator.api_base_url` |
| credential environment reference | `Secret.from_env_var(...)` |
| replacement system instructions | `Agent.system_prompt` |
| `runtime.max_turns` | bounded `max_agent_steps` |
| request text | `ChatMessage.from_user(...)` |
| result | final message, usage, tool count, and exit reason |

The first package should claim models, base URL, temperature, replacement system instructions,
plain-text input, text output, and a bounded agent-step limit. Defer MCP and skills unless the
accepted product decision includes them. Their translation is technically feasible, but each adds
path, authentication, logging, and cleanup behavior that needs independent evidence.

The runtime class should be `HaystackAgentRuntime`. Functions should describe the workflow:

- `select_default_model`
- `build_chat_generator`
- `build_haystack_agent`
- `normalize_agent_result`
- `close_runtime_resources`

If MCP is accepted, add `build_mcp_toolsets`. If skills are accepted, add
`build_skill_toolset`. Do not create those files or functions before they have a consumer.

## Package structures

The shared folder names follow the existing package workflow. A package should omit folders that
it does not use.

### DeepSeek Harness

```text
packages/nemoclaw-deepseek-harness/
├── README.md
├── package.json
├── package-lock.json
├── manifest.yaml
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/
│   └── generate-config.ts
├── runtime/
│   └── generate-config.sh
├── fabric/
│   ├── deepseek.fabric-adapter.json
│   ├── pyproject.toml
│   ├── requirements.in
│   ├── requirements.lock
│   └── src/nemoclaw_deepseek_fabric/
│       ├── __init__.py
│       ├── adapter.py
│       └── process.py
├── compat/
│   └── dependencies.md
├── tsconfig.test.json
├── vitest.config.ts
├── vitest.nemoclaw.ts
└── tests/
    ├── config/
    ├── fabric/
    ├── image/
    ├── integration/
    ├── runtime/
    ├── fixtures/
    └── helpers/
```

`process.py` exists because the SDK notification wait needs an outer process-tree deadline.
`adapter.py` should contain only Fabric translation and lifecycle behavior.

### Haystack Agent

```text
packages/nemoclaw-haystack-agent/
├── README.md
├── package.json
├── package-lock.json
├── manifest.yaml
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/
│   └── generate-config.ts
├── runtime/
│   └── generate-config.sh
├── fabric/
│   ├── haystack.fabric-adapter.json
│   ├── pyproject.toml
│   ├── requirements.in
│   ├── requirements.lock
│   └── src/nemoclaw_haystack_fabric/
│       ├── __init__.py
│       ├── adapter.py
│       ├── config.py
│       └── runtime.py
├── compat/
│   └── dependencies.md
├── tsconfig.test.json
├── vitest.config.ts
├── vitest.nemoclaw.ts
└── tests/
    ├── config/
    ├── fabric/
    ├── image/
    ├── integration/
    ├── runtime/
    ├── fixtures/
    └── helpers/
```

Do not add `mcp.py`, `skills.py`, or a service folder until the accepted package includes those
surfaces.

## Test ownership

Core tests should prove the generic contract with a synthetic package. Package tests should prove
each upstream integration.

| Owner | Tests |
| --- | --- |
| NemoClaw core | package discovery, receipt integrity, manifest schema, generic Dockerfile selection, generic Fabric dispatch, managed-inference authority, generic lifecycle and rollback |
| `nemoclaw-fabric` | input/output limits, standard-input transport, SDK deadline, result normalization, artifact ownership, process cleanup |
| DeepSeek package | SDK translation, profile, process tree, native state, dependency/image identity, DeepSeek errors, package live journey |
| Haystack Agent package | Agent construction, model translation, tools if accepted, resource cleanup, dependency/image identity, Haystack errors, package live journey |

The live journey should be one generic root suite, such as
`test/e2e/live/package-agent.test.ts`. Typed target records supply the package source, package ID,
platform, onboarding mode, and expected state. The suite must derive adapter and runtime identity
from the installed package and receipt. It must not switch on a package ID.

Package workflows should invoke this same generic suite against a pinned NemoClaw checkout. When a
package moves to another repository, its workflow supplies the package checkout or archive and the
target inputs. It does not copy the E2E implementation or add a second target registry. NemoClaw
core should continue to run one synthetic external-package composition test.

This split lets a package update its upstream dependency, adapter, image, and tests without a
NemoClaw code change. A NemoClaw change should be required only when the common contract changes.

## Fast deterministic tests

Both packages need these tests on each change:

1. Discover, materialize, install, list, select, damage-detect, and reinstall the package.
2. Validate the manifest, Fabric descriptor, configuration, and unsupported capability refusals.
3. Install the hashed dependency closure and run the package manager's integrity check.
4. Prove model, base URL, credential reference, instructions, limits, and workspace translation.
5. Run successful and repeated invokes against a deterministic local model server or mock
   generator.
6. Normalize provider errors, malformed results, empty results, native crashes, and partial start.
7. Enforce input, output, stderr, artifact, and deadline limits.
8. Terminate descendants after timeout and cancellation.
9. Keep two runtimes isolated and make repeated stop safe.
10. Scan result, error, log, config, artifact, receipt, and image fixtures for credential and prompt
    canaries.
11. Verify Docker users, file ownership, modes, binaries, imports, versions, and startup commands.
12. Compose the package through a pinned NemoClaw checkout and the generic Fabric runner.

DeepSeek adds these deterministic cases:

- The published SDK and runtime wheel use the same pinned version and hashes.
- `sdk-minimal` exposes only the accepted profile and fixed tool roster.
- DSH home and workspace are explicit and isolated.
- Fresh and reused session IDs follow the accepted state rules.
- The child process group exits after success, failure, deadline, and parent termination.
- Direct provider fallback, telemetry, feedback export, plugin installation, and self-update are
  unavailable.
- Both `DSH_TELEMETRY_MODE=DISABLED` and the hard opt-out `DSH_TELEMETRY_DISABLED=1` remain set.

Haystack Agent adds these deterministic cases:

- `MockChatGenerator` covers success, two ordered turns, accepted tool use, maximum steps, and
  provider failure.
- Explicit timeout, retry, agent-step, and concurrent-tool limits override upstream defaults.
- Telemetry, automatic tracing, and content tracing remain disabled.
- Arbitrary pipeline deserialization and unregistered module loading remain unavailable.
- If accepted, MCP tests cover stdio and streamable HTTP, tool allow/block rules, cleanup,
  unsupported authentication, and redacted diagnostics.
- If accepted, skill tests cover approved roots, malformed skills, duplicate names, traversal, and
  symbolic-link escape.

## Live E2E

Do not create a Cartesian matrix of packages, host operating systems, hardware, container
runtimes, and serving runtimes. Those dimensions remain core qualification lanes. Each package
must prove only the external boundaries that its deterministic tests cannot simulate.

### macOS ARM64 development journey

Run one focused journey for each package:

1. Start with no installed harness package.
2. Run `nemoclaw harness install <package-id>`.
3. Confirm `nemoclaw harness list` reports only installed packages as installed.
4. Run source-build onboarding through the normal Docker and OpenShell path.
5. Verify package receipt, image identity, runtime version, configuration mode, and Fabric doctor.
6. Send a deterministic request through `nemoclaw sandbox agent` and managed inference.
7. Verify one native file operation when the accepted tool roster supports it.
8. Stop and start the sandbox, then send a second request.
9. Trigger one bounded failure and verify process cleanup and redaction.
10. Destroy the sandbox and verify that the sandbox, forwards, child processes, and temporary
    Fabric artifacts are gone.

The macOS journey proves the local installer, Docker Desktop, OpenShell, package image, Fabric
adapter, managed route, and cleanup boundary.

### Brev Linux AMD64 qualification journey

Run the same public commands on a fresh Brev instance. Add these assertions:

- The request reaches `inference.local`, not the upstream provider.
- No upstream inference credential enters sandbox environment, files, logs, artifacts, snapshots,
  or evidence.
- The installed upstream wheel and binary match the accepted Linux AMD64 identity.
- The package cannot use undeclared direct egress.
- Restart, same-version rebuild or restore when advertised, and destroy preserve the accepted state
  contract.
- The result artifact records the NemoClaw commit, package receipt, image identity, Fabric version,
  adapter descriptor, upstream runtime, architecture, runtime provider, inference route, test
  result, and redaction result.

DeepSeek qualification must also prove the SDK child and every tool descendant terminate. Haystack
qualification must prove `Agent.close_async` and generator resources close. If the Haystack
package does not advertise durable conversation state, the test must not claim cross-command
conversation persistence.

No messaging-service tests belong in either first qualification. Messaging remains outside the
accepted scope for this work.

### Additional release evidence

A supported managed-image release needs Linux AMD64 and Linux ARM64 image evidence. A Mac ARM64
run does not replace native Linux ARM64 image qualification. The managed-image publication lane
must bind both image digests to one candidate receipt before stock buildless onboarding is
advertised.

## Confidence model

The target confidence comes from independent evidence, not repeated broad live runs:

1. Adapter contract and negative-path tests establish deterministic correctness.
2. Exact dependency and image tests establish reproducibility.
3. A local model server establishes request translation without credentials.
4. The Mac journey establishes the developer host boundary.
5. The Brev journey establishes the Linux runtime, OpenShell, managed inference, and policy
   boundary.
6. Linux ARM64 image qualification establishes release portability.
7. A version-update workflow reruns package tests and the two affected live boundaries before a
   pin changes.

When all seven layers pass for one immutable candidate, the team can make a 90–95% engineering
confidence statement. A 95–100% statement still requires production observations and cannot be
established by E2E tests alone.

## Estimated change size

These estimates assume headless-only packages, the current generic Dockerfile path, and no initial
Haystack MCP, skills, or Hayhooks service.

| Area | Files | Production lines | Test lines | Effort after acceptance |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek package | 26–34 | 2,100–2,900 | 1,300–1,900 | 5–9 engineering days |
| Haystack Agent package | 24–32 | 1,800–2,600 | 1,200–1,800 | 6–10 engineering days |
| Generic core managed-image opening | 4–8 | 200–500 | 400–800 | 3–6 engineering days |
| Generic live E2E wiring | 3–6 | 250–500 | 400–800 | 2–4 engineering days |

The package estimates use Pi's current package as the nearest local baseline. Pi has about 30
non-lock files, 2,491 production, configuration, and documentation lines, and 1,432 test lines.
Generated lockfiles are additional and should not be counted as handwritten lines.

MCP and skills for Haystack add about 4–7 files, 300–600 production lines, 500–900 test lines, and
3–5 engineering days. A reusable ACP adapter in NeMo Fabric is a separate 1–2 week project. These
are planning estimates, not measured implementation counts.

## Upgrade and independent work lanes

Each package should pin one upstream version and one Fabric contract package. An update PR should
change the pin, lock, compatibility record, image identity, and package tests together. It should
run only the affected package's deterministic lane and live boundary.

```text
NemoClaw core
  owns common contracts and synthetic future-package tests

nemoclaw-fabric
  owns adapter-neutral invocation, deadlines, artifacts, and cleanup

nemoclaw-deepseek-harness
  owns DeepSeek SDK, profile, process model, state, image, and tests

nemoclaw-haystack-agent
  owns the NemoClaw-authored Haystack Agent, dependencies, image, and tests
```

An upstream harness change should not require a NemoClaw core change when the package can still
implement the same manifest, fixed-command, and Fabric contracts. A contract change should require
one NemoClaw change plus conformance updates for every package. Unsupported new upstream features
remain package-local until the product accepts a common capability.

## Gaps and decisions

| Question | Evidence | Recommended decision | Status |
| --- | --- | --- | --- |
| Is DeepSeek a harness? | Official SDK, CLI, ACP, and profiles | Yes; use ID `deepseek-harness` | Resolved technically |
| Which DeepSeek surface ships first? | SDK minimal is bounded; Web adds browser authority | Headless `sdk-minimal` only | Needs product acceptance |
| Which DeepSeek version? | Published RC is behind alpha source | Pin published `0.1.2rc1`; qualify each update | Needs lifecycle owner |
| Can DeepSeek turns hang? | Local probe exceeded outer deadline | Retain process-group supervisor | Resolved technically |
| Is Haystack a harness? | Stable wheel has no runnable entry point | No | Resolved technically |
| What does NemoClaw install for Haystack? | `Agent` is a framework component | A NemoClaw-owned `Haystack Agent` | Needs product acceptance |
| Does Haystack include MCP and skills now? | Both exist but add trust and cleanup surfaces | Defer from first package | Needs product acceptance |
| Does either need a core agent ID branch? | Unknown-package composition already works | No | Resolved technically |
| Can stock buildless onboarding remain generic? | Managed startup still has a closed set | Open it through receipt-bound manifest data | Needs design acceptance |
| Who owns compatibility and support? | No accepted record names owners | Name package, security, release, and support owners | Blocked |

## Required decision record

Maintainers can authorize implementation by recording `Accept` for each integration with these
fields. Do not mark either record accepted until every owner agrees.

### DeepSeek Harness

```text
Decision: Accept | Request changes | Defer | Decline
Reason: Add a headless DeepSeek Harness package through the existing NemoClaw package and
        NeMo Fabric contracts.
Placement: packages/nemoclaw-deepseek-harness during monorepo development; separate package
           repository after contract qualification.
Accountable maintainer: <name or team>
Security owner: <name or team>
Release and support owner: <name or team>
Surface: headless SDK only; sdk-minimal fixed profile; no Web, ACP, MCP, skills, plugins,
         telemetry, feedback, self-update, or direct provider fallback.
Compatibility: pin deepseek-harness-sdk and runtime 0.1.2rc1 with hashes; requalify every update.
State: persist only accepted sessions and workspace data; reconstruct configuration; prohibit
       credentials, package trees, cache, telemetry identity, and executable profile changes.
Validation: deterministic package suite; macOS ARM64 journey; Brev Linux AMD64 journey; Linux
            ARM64 image qualification; managed-route, process cleanup, policy, and redaction
            evidence.
```

DeepSeek issue [#9329](https://github.com/NVIDIA/NemoClaw/issues/9329) can hold this decision. The
remaining issues [#9330](https://github.com/NVIDIA/NemoClaw/issues/9330) through
[#9336](https://github.com/NVIDIA/NemoClaw/issues/9336) already divide candidate packaging,
surface, state, inference, security, qualification, and activation work.

### Haystack Agent

```text
Decision: Accept | Request changes | Defer | Decline
Reason: Ship one NemoClaw-authored headless coding agent implemented with Haystack and exposed
        through the existing package and NeMo Fabric contracts.
Placement: packages/nemoclaw-haystack-agent during monorepo development; separate package
           repository after contract qualification.
Accountable maintainer: <name or team>
Security owner: <name or team>
Release and support owner: <name or team>
Surface: headless only; models, base URL, system instructions, text input/output, and bounded agent
         steps; no interactive UI, Hayhooks, arbitrary pipeline loading, MCP, or skills initially.
Compatibility: pin haystack-ai 3.1.1 and its complete hashed closure; requalify every update.
State: no durable cross-command conversation claim; persist only explicitly accepted workspace
       artifacts; reconstruct configuration.
Validation: deterministic package suite; macOS ARM64 journey; Brev Linux AMD64 journey; Linux
            ARM64 image qualification; managed-route, cleanup, policy, and redaction evidence.
```

Haystack needs a new NemoClaw issue or accepted design record. The title should state that the
product is a NemoClaw-authored Haystack Agent, not a generic claim that Haystack itself is a
harness.

## Definition of done after acceptance

- Both package decisions have an `Accept` result and named accountable owners.
- `nemoclaw harness install deepseek-harness` and `nemoclaw harness install haystack-agent` work
  without a production-core package ID branch.
- Onboarding selects only installed packages and uses the existing user workflow.
- Each package owns every upstream-specific source file and test.
- Core contains no DeepSeek or Haystack production switch, alias, provider rule, config grammar,
  command grammar, state path, or process marker.
- Fabric planning rejects every unimplemented capability before target startup.
- All package tests and generic NemoClaw contract tests pass.
- The macOS ARM64 and Brev Linux AMD64 live journeys pass from fresh state.
- Linux AMD64 and Linux ARM64 images have immutable, secret-free qualification receipts.
- Failure artifacts are bounded and contain no credential, prompt canary, or prohibited state.
- Destroy leaves no sandbox, forward, adapter, upstream process, or temporary request artifact.
- Package update instructions identify the upstream pin, lock, compatibility review, and required
  qualification lanes.

## Current limitations

- No supported package code was added because neither integration has an accepted product record.
- No Mac, Brev, or Linux ARM64 live E2E was run.
- The local branch was five commits behind `origin/main` at the research baseline. Reconcile that
  delta before implementation and rerun changed-package selection.
- The DeepSeek local SDK and Haystack dependency probes establish feasibility only. They do not
  establish NemoClaw image, OpenShell, policy, lifecycle, or release support.
