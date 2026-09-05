<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DeepSeek Harness and Haystack Fabric POC evidence

**Date:** 2026-09-05

**Audience:** NemoClaw architecture and package maintainers

**Code evidence cutoff:** local commit `7ab76f1bda53ab6ab658beb996d61a1709bc0506`

## Scope

This is a local, disposable proof of concept. It does not add an official NemoClaw integration,
publish a package, promise compatibility, or establish product support. The question is narrower:

> Can a materially different harness and framework-backed agent use the current typed NemoClaw
> package boundary plus NeMo Fabric without adding their identities or native behavior to
> NemoClaw production code?

The tested surface is a source-built Docker/OpenShell terminal package, one private plain-text
request, one terminal text result, hosted inference through `inference.local`, restart, and
destroy. Messaging, MCP, streaming, native cancellation, services, interactive UI, configurable
tools, arbitrary framework loading, and package publication are excluded.

## Direct answer

**Yes. The current typed package boundary plus NeMo Fabric is sufficient for this narrow POC.**
Both packages are discovered, installed, configured, and dispatched through common data and the
same Fabric lifecycle entrypoints. Exact searches find no `deepseek-harness`, `haystack-agent`,
either npm package name, or either adapter ID in non-test NemoClaw core, launcher, blueprint, or
the generic package builder.

DeepSeek Harness and Haystack Agent each completed the same public lifecycle on the exact local
commit on two ARM64 environments: Docker/Colima hosted by macOS and Docker/OpenShell on Brev
Linux. Each run proved empty isolated inventory, receipt-backed installation, source-built
onboarding, hosted inference before and after sandbox restart, Fabric doctor, immutable private
configuration, bounded credential-free state, no lingering marked processes, destroy, sandbox
absence, and isolated gateway cleanup.

This proves the current in-tree Dockerfile/headless/Fabric composition path. It does not prove an
external package marketplace, separate-repository builds, every host architecture or runtime,
or richer capabilities that these two packages deliberately refuse.

## Contract path

```text
package.json nemoclaw.harnessManifest
  -> generic package discovery and materialization
  -> nemoclaw harness install <package-id>
  -> immutable object + receipt + active package pointer
  -> manifest.yaml terminal runtime and public headless environment
  -> package Dockerfile and start.sh
  -> nemoclaw sandbox agent <sandbox> <prompt>
  -> receipt-pinned headless command, typed environment, private stdin
  -> generic nemoclaw-fabric-run
  -> Fabric config and discoverable package descriptor
  -> AgentConfig + AgentRunRequest + RuntimeContext
  -> package start / invoke / stop
  -> normalized AgentRunResult
```

The responsibilities remain distinct:

| Owner | Responsibility in this POC |
| --- | --- |
| NemoClaw core | Package identity, receipt integrity, selection, host/runtime orchestration, managed inference, policy authority, lifecycle, rollback, state safety, typed command environment |
| `packages/nemoclaw-fabric` | Prompt and output bounds, Fabric configuration loading, adapter discovery, SDK invocation, process deadline, redaction, artifacts, generic cleanup |
| Harness package | Upstream pin, image, native configuration, startup, policy additions, Fabric descriptor, target translation, target cleanup, package tests |

The typed package entrypoints used here are:

1. `package.json` selects one manifest through `nemoclaw.harnessManifest`.
2. `manifest.yaml` declares identity, Docker inputs, terminal runtime, state, policy, and disabled
   capabilities.
3. Core's startup-environment builder gives every package-owned startup command a package-neutral,
   validated managed proxy host and port. Authored `runtime.startup_environment` values remain a
   separate bounded public map. The package never receives the inference credential.
4. `runtime.headless_environment` supplies bounded public constants for later commands. Core
   rejects credentials, proxy variables, `NEMOCLAW_*`, and `OPENSHELL_*` values.
5. Core restores the trusted managed route before status, doctor, and connect probes, so those
   generic operations see the same route as startup and invocation.
6. `runtime.headless_command` selects the package command. Core recognizes the shared
   `nemoclaw-fabric-run` prompt grammar and sends the prompt over standard input.
7. The Fabric descriptor declares its exact ID, Python module, accepted normalized configuration,
   model schema, and capabilities.
8. The adapter implements Fabric's typed `start`, `invoke`, and `stop` lifecycle and returns an
   `AgentRunResult`.
9. `host/config-adapter.cts` implements the existing finite typed configuration operation map;
   both POCs declare their image-generated Fabric configuration immutable.
10. A package-owned E2E fixture supplies bounded identity, path, descriptor, and process evidence
    to one generic live test.

## Package implementations

### DeepSeek Harness

`packages/nemoclaw-deepseek-harness` is a harness adapter around the published Python SDK.

- Package ID: `deepseek-harness`
- Adapter ID: `nvidia.nemoclaw.deepseek-harness`
- Upstream pin: `deepseek-harness-sdk==0.1.2rc1` and matching
  `deepseek-harness-runtime-bin==0.1.2rc1`, hash locked
- Fabric pin: `nemo-fabric==0.2.0` and matching contract/common packages
- Translation: one managed OpenAI-compatible model, managed base URL, route-marker environment
  reference, optional replacement system instruction, explicit workspace, and explicit DSH home
- Native boundary: `DeepSeekHarness(profile="sdk-minimal", patches=())`
- Cleanup boundary: a separate process group plus Linux child-subreaper logic stops and reaps the
  SDK worker and detached tools on success, failure, cancellation, or runner timeout
- State: sessions are backup state; logs and cache are non-backup state; invocation artifacts are
  ephemeral
- Refused surface: non-text input, unmanaged providers or URLs, arbitrary profiles or patches,
  MCP, streaming, services, and runtime updates

Its important package files are:

```text
manifest.yaml
Dockerfile.base
Dockerfile
start.sh
config/generate-config.py
runtime/generate-config.sh
host/config-adapter.cts
fabric/deepseek.fabric-adapter.json
fabric/src/nemoclaw_deepseek_fabric/adapter.py
fabric/src/nemoclaw_deepseek_fabric/process.py
tests/{config,fabric,host,image,integration,runtime,fixtures,helpers}
```

### Haystack Agent

`packages/nemoclaw-haystack-agent` is a dedicated custom agent implemented with Haystack. Haystack
is a framework rather than a turnkey daemon, so this POC owns the concrete agent construction.

- Package ID: `haystack-agent`
- Adapter ID: `nvidia.nemoclaw.haystack-agent`
- Upstream pin: `haystack-ai==3.1.1`, hash locked
- Fabric pin: `nemo-fabric==0.2.0` and matching contract/common packages
- Translation: one managed OpenAI-compatible model, managed base URL, route-marker environment
  reference, temperature, literal replacement system message, and bounded agent steps
- Native boundary: `Agent` plus `OpenAIChatGenerator`; tools are deliberately `None`
- Result boundary: success requires Haystack's `exit_reason == "text"`, an assistant-role final
  message, and nonblank text; retained user messages and malformed results fail closed
- Cleanup boundary: an active invocation is cancelled on stop, then `Agent.close_async()` closes
  hooks and generator resources
- State: no durable conversation claim; each invocation starts from the current request
- Refused surface: tools, skills, MCP, workflow selection, harness settings, streaming, services,
  and arbitrary pipeline loading
- Privacy posture: Haystack telemetry, automatic tracing, and content tracing are disabled before
  Haystack is imported and in the image/startup environment

Its important package files are:

```text
manifest.yaml
Dockerfile.base
Dockerfile
start.sh
config/generate-config.ts
runtime/{generate-config.sh,version-check.py}
host/config-adapter.cts
fabric/haystack-agent.fabric-adapter.json
fabric/src/nemoclaw_haystack_fabric/adapter.py
tests/{config,fabric,host,image,integration,runtime,fixtures,helpers}
```

## Evidence matrix

| Evidence | DeepSeek Harness | Haystack Agent |
| --- | --- | --- |
| Package TypeScript tests | 16/16 pass | 18/18 pass |
| NemoClaw composition tests | 4/4 pass | 2/2 pass |
| Composed Python/Fabric tests rerun 2026-09-05 | 12/12 pass | 11/11 pass |
| Package TypeScript check | Pass | Pass |
| Fabric aggregate | 157 pass, 6 platform skips across 163 tests | Same aggregate run |
| Synthetic unknown-package composition | Shared test passes | Same shared test |
| Generic E2E support | 3,891 pass, 39 skips across 270 files | Same shared run |
| macOS ARM64 public journey at `7ab76f1bda` | Pass, 110,616 ms | Pass, 113,726 ms |
| Brev Linux ARM64 public journey at `7ab76f1bda` | Pass, 127,400 ms | Pass, 130,927 ms |
| Exact package digest on both hosts | `751dff97e98d...` | `e4863dc8c10e...` |
| Artifact credential scan | Pass | Pass |
| CLI typecheck and project membership | Pass | Pass |

Final macOS evidence is retained outside the repository at
`/tmp/nemoclaw-deepseek-final.Hh7Kcm/fabric-package` and
`/tmp/nemoclaw-haystack-final.xqT5Sp/fabric-package`. Both `target-result.json` files record the
lifecycle `onboard -> turn -> stop -> start -> turn -> destroy`, runner identity
`nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)`, matching install/onboard/restart package identities,
two successful responses, Fabric doctor pass, mode-0600 `sandbox:sandbox` configuration, bounded
credential-free state, no lingering marked processes, and sandbox absence.

The provenance-correct Brev evidence is retained at
`/tmp/nemoclaw-brev-final2.b6ZudP`, with its transfer archive at
`/tmp/nemoclaw-brev-evidence-7ab76f1bda-final2.tgz`. The local and remote SHA-256 of that archive
is `0045f1332649105b3edb57c8d2a3d9d9c5e68e2fc0a93fb6ceb1330c47d3a32a`.
The Brev host ran Linux `aarch64`, Node.js `22.23.2`, Docker `29.7.2`, and OpenShell `0.0.106`.
Its generated build identity exactly matched the code evidence cutoff. An independent exact-value
scan of all retained macOS and Brev artifacts found no inference credential. Every disposable
source archive, private environment file, checkout, evidence directory, sandbox, and gateway
created on Brev was removed after retrieval.

## What the POC proves

- A new package ID can traverse discovery, install, receipt binding, selection, Dockerfile
  staging, terminal dispatch, and Fabric selection without a production-core ID branch.
- The same Fabric lifecycle accommodates an opinionated subprocess harness and a direct
  framework-backed custom agent.
- Model, endpoint, instructions, request, result, state, cleanup, and safe-failure translation can
  remain package-owned.
- Package tests can compose against the shared runner while the generic E2E owns the public
  install-to-destroy workflow.
- The manifest needed one genuinely generic addition for later execs:
  `runtime.headless_environment`. Its validator and OpenShell propagation contain no harness ID.
- Package artifacts are reproducible across the working-tree Mac build and the tracked-only Brev
  build. The generic bundler excludes authoring caches and empty source-only directories, and a
  synthetic package regression protects both the artifact tree and content digest.

These facts support the architectural thesis. They do not prove every future harness or every
NemoClaw feature can use the contract unchanged.

## Gaps and next evidence

| Gap | Consequence | Smallest next step |
| --- | --- | --- |
| External installation is absent | A separately published Python/npm package does not yet appear in `nemoclaw harness list` | Add one explicit trusted external package source, compatibility check, install receipt, and synthetic test only when external distribution is in scope |
| Prompt transport is inferred from executable basename | Other Fabric runner names cannot request private stdin through typed metadata | Replace basename inference with a typed prompt-transport field if a second runner requires it |
| Live fixture repeats descriptor/path metadata | Package drift can require two edits | Derive fields from the installed manifest/descriptor where safe, leaving only assertions that cannot be discovered |
| Root E2E registration is explicit | Direct fixture execution is generic, but a package must edit the core catalogue to join central CI | Discover package-owned qualification fixtures or let external package CI invoke the generic runner directly |
| E2E runner identity is fixed in core evidence | A separately versioned package cannot qualify another compatible runner without a core test edit | Read the expected runner identity from the package fixture or descriptor |
| E2E runner remains in NemoClaw | A separate package repository still depends on a NemoClaw test implementation | Expose the generic runner as a stable development command before repository extraction |
| Dockerfile build uses the NemoClaw repository context | A fully separate package cannot build unchanged | Define the minimal package/core build inputs or a staged context before repository extraction |
| Managed/buildless startup and managed image maps are closed | Unknown package IDs use the Dockerfile terminal path but cannot opt into those richer paths | Add a typed capability only when a concrete external package requires one of these paths |
| Status probes require `/usr/bin/curl` | A minimal package image without that fixed executable fails before invocation | Keep curl as the documented terminal-image prerequisite, or add a typed health probe when a non-curl package requires it |
| Advanced capabilities are disabled | This POC says nothing about MCP, services, streaming, UI, messaging, or configurable tools | Add a typed capability only for a concrete package and protect it with Fabric planning plus one synthetic core test |
| Fabric 0.3 prereleases exist | The POC validates stable `0.2.0`, not newer prerelease behavior | Treat an upgrade as a separate pin-and-validation change |
| Package `.cts` host modules rely on runtime schemas | Their operation map is typed in core, but implementations are not compile-time imports | Add package-side compile-time conformance only if these modules grow beyond the current small immutable-config plan |
| Validation covered ARM64 Docker only | x86_64, Podman, managed images, and other host/runtime combinations remain unproven | Add only the next materially different environment to the shared journey matrix |
| The current npm tree reports nine audit findings | This POC did not determine exploitability or ownership | Handle dependency remediation as a separate repository-wide security task |
| Legacy harness translators remain elsewhere in core | The broader repository is not yet fully harness-agnostic | Migrate OpenClaw, Hermes, and Deep Agents independently through the proven package boundary |

## Completion rule for this POC

The scoped POC is complete. Both package suites and common contract suites pass at one immutable
local commit; both package fixtures pass the full public macOS journey at that commit; both pass
the same journey on the available Brev host; retained artifacts prove credential redaction and
process cleanup; package digests agree across hosts; and an exact search confirms no new
production-core package ID branch. Superseded or incorrectly stamped runs are excluded from this
conclusion.

## Claim-to-source ledger

External source locators intentionally omit hyperlinks. They identify the first-party project,
tag or version, commit, and path so this repository does not add third-party project links.

| Claim | Primary source locator | Access and confidence |
| --- | --- | --- |
| Fabric adapters translate one normalized configuration/runtime contract into a target and own target translation, state, invocation, and cleanup | NVIDIA NeMo Fabric `v0.2.0`, commit `810189732befa2a5a7feb139c935bbd4dfc400a2`, `docs/adapter-contract/README.md` | Local shallow clone plus public source page; high |
| Fabric's minimum local adapter is one descriptor plus `start`, ordered `invoke`, and `stop`, returning normalized results | Same Fabric source, `docs/adapter-contract/README.md` and `docs/adapter-contract/execution.md` | Local shallow clone; high |
| The descriptor contract used here is `fabric.adapter/v1alpha2` | Same Fabric source, `docs/adapter-contract/README.md`; both package descriptor JSON files | Upstream and local implementation agree; high |
| Stable Fabric package `0.2.0` exists; `0.3.0b2` is a later prerelease | Python Package Index, `nemo-fabric` release history accessed 2026-09-05 | Public registry metadata; high |
| DeepSeek's Python SDK drives a matching bundled runtime over newline-delimited JSON-RPC on stdio | DeepSeek Harness `dsh-v0.1.2-rc.1`, commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`, `python/README.md` and `python/sdk/README.md` | Local shallow clone plus public source page; high |
| DeepSeek's `sdk-minimal` profile supports explicit workspace/home, Bash/editor behavior, and final response results | Same DeepSeek source, `python/sdk/README.md`, `python/sdk/examples/minimal.py`, and `python/sdk/src/deepseek_harness/api.py` | Local shallow clone; high |
| DeepSeek SDK/runtime `0.1.2rc1` artifacts were published and the POC pins both with hashes | Python Package Index release metadata accessed 2026-09-05; package `fabric/requirements.lock` | Registry plus lock; high |
| Haystack provides an async `Agent`, bounded `max_agent_steps`, structured `exit_reason`/`last_message`, and `close_async` resource cleanup | Haystack `v3.1.1`, commit `d60cce01a778bc3498a02866fe288b3c07398649f`, `haystack/components/agents/agent.py` | Local shallow clone plus public source page; high |
| Haystack's OpenAI chat generator accepts an environment-backed secret, custom base URL, timeout, retries, and async close | Same Haystack source, `haystack/components/generators/chat/openai.py` | Local shallow clone plus public source page; high |
| Haystack `3.1.1` supports Python 3.10+ and its release maps to the cited source commit | Python Package Index `haystack-ai==3.1.1` provenance accessed 2026-09-05 | Public registry attestation metadata; high |
| NemoClaw can compose an unknown package ID without a named core branch | `test/onboarding/package-composition.test.ts` plus the generic package-artifact regression | Local code and execution at `7ab76f1bda`; high for the covered path |
| Both adapters pass their deterministic and composed package suites | 32 DeepSeek tests, 31 Haystack tests, and 157/163 aggregate Fabric tests pass; six platform tests skip | Local execution; high |
| The common E2E support layer remains internally consistent | 3,891 tests pass and 39 skip across 270 files; project membership is exact for 2,481 candidates | Local execution; high |
| DeepSeek completes the full public lifecycle on macOS and Brev | Retained target, proof, command, cleanup, and progress evidence under `/tmp/nemoclaw-deepseek-final.Hh7Kcm/fabric-package` and `/tmp/nemoclaw-brev-final2.b6ZudP/deepseek/fabric-package` | Two-host live evidence at the exact code cutoff; high for the declared surface |
| Haystack completes the full public lifecycle on macOS and Brev | Retained target, proof, command, cleanup, and progress evidence under `/tmp/nemoclaw-haystack-final.xqT5Sp/fabric-package` and `/tmp/nemoclaw-brev-final2.b6ZudP/haystack/fabric-package` | Two-host live evidence at the exact code cutoff; high for the declared surface |
| Package artifacts are host-reproducible | DeepSeek and Haystack content digests match Mac and Brev; synthetic cache/empty-directory regression passes | Local and remote execution; high |
| Retained evidence contains no inference credential | E2E state assertions plus independent exact-value scans across all three final artifact roots | Local and remote execution; high |

Research stopped after the two upstream target APIs, the Fabric contract, the local implementation,
and every consequential test claim had first-party or executable evidence. The remaining questions
are distribution, richer capability, and environment-matrix gaps rather than blockers for this
scoped POC.
