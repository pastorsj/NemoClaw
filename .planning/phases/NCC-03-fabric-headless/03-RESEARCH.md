<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Research: Fabric Headless Integration

**Researched:** 2026-08-30
**NemoClaw baseline:** `34ceb565734785bebb0229150fbde0bd5faf8a8f`
**Fabric source:** annotated tag `v0.2.0` at `065dacdfe5b10e910b418ab2d9ee510ed888f43f`,
which points to commit `810189732befa2a5a7feb139c935bbd4dfc400a2`
**Fabric package:** released PyPI `nemo-fabric==0.2.0`

## Decision

Use Fabric as a generic sandbox-local headless invocation layer. Do not make Fabric a fourth
component axis or a user-facing agent runtime. The existing LangChain Deep Agents Code package is
the first consumer because its Fabric adapter is released with Fabric 0.2.0. Its native `dcode`
interactive command remains unchanged.

Pi is not the first consumer. Its adapter is present on Fabric's unreleased 0.3 development line,
while public package metadata does not provide a reproducible released Pi adapter. A later Pi
package must use the same runner contract after those artifacts are released.

This is a local-fork product experiment. It does not establish a supported NemoClaw integration.
An upstream contribution still needs an accepted product decision with named ownership, lifecycle,
compatibility, security, and validation expectations.

## Contract Boundary

```text
nemoclaw harness install langchain-deepagents-code
  -> validated data and image assets
  -> OpenShell sandbox lifecycle owned by NemoClaw
  -> nemoclaw-fabric run inside the sandbox
  -> FabricConfig selects nvidia.fabric.langchain.deepagents
  -> released Fabric adapter invokes Deep Agents
```

NemoClaw continues to own package installation, credentials, network policy, image selection,
OpenShell lifecycle, state, backup, rebuild, and qualification. Fabric owns adapter discovery,
configuration projection, `doctor`, `start`, `invoke`, normalized results, and `stop`.

The shared runner accepts a normal Fabric configuration file. It must not contain an adapter-name
branch. The agent runtime package owns the exact adapter ID and model projection.

## Existing NemoClaw Seams

- `AgentDefinition.runtime` already distinguishes `interactive_command` and `headless_command`.
- `nemoclaw sandbox agent` currently selects the interactive command for most terminal agents.
  Generic non-interactive dispatch must select `headless_command` first.
- The current reviewed package build copies LangChain Deep Agents Code assets through
  `src/lib/harness/bundled-source.ts`. The Fabric runner can enter that artifact as one declared
  shared source until the Phase 3 package root becomes authoritative.
- Package installation is data-only. A public `nemoclaw harness validate <artifact-directory>`
  command can compose tree, envelope, manifest, and `AgentDefinition` checks without installing or
  executing package code.

## Released Adapter Limit

Fabric 0.2 installs `deepagents==0.6.12` and `langchain-mcp-adapters==0.2.2`. Native DCode installs
`deepagents==0.7.5` and `langchain-mcp-adapters==0.3.0`. The released adapter also constructs
`ChatOpenAI` without DCode's managed Nemotron Ultra `force_nonempty_content` option or explicit
reasoning effort. The experiment therefore proves a separately named released Fabric Deep Agents
round trip. It does not qualify native DCode behavior.

Package data marks a Fabric invocation unavailable when those model options are required. The
generic runner rejects that data before adapter discovery. The live round trip uses
`nvidia/nvidia/nemotron-3-super-v3` with no reasoning effort.

## Dependency Concerns

| ID | Failure mode | Control and evidence |
|---|---|---|
| DEP-01 | An unreleased or mutable Fabric artifact makes the demo irreproducible. | Pin released 0.2.0 packages and hashes; assert installed versions in the image. |
| DEP-02 | A credential enters configuration, output, or diagnostics. | Store only `api_key_env`; redact errors; scan fake-server requests, output, and artifacts for a sentinel. |
| DEP-03 | Start, invoke, signal, or stop failure leaves an adapter host. | Use the SDK lifecycle and verify cleanup for success, failure, malformed result, SIGINT, and SIGTERM. |
| DEP-04 | Adapter and native DCode dependencies disagree. | Isolate two hash-locked graphs, run `pip check` and image probes for both, and do not claim native parity. |
| DEP-05 | Host validation imports package code. | Keep `harness validate` data-only and revalidate tree authority after all reads. |

## Validation Layers

1. Runner unit tests cover configuration, input selection, output modes, redaction, status mapping,
   and exceptions.
2. Released-SDK integration tests use a deterministic Fabric fixture and verify
   `doctor -> start -> invoke -> stop`, two ordered invokes, faults, and process cleanup.
3. A released Fabric Deep Agents round trip uses a fake OpenAI-compatible server for text and
   confined workspace tool calls.
4. Package composition verifies artifact conformance, adapter configuration, exact locks, command
   selection, and built image contents.
5. One Mac arm64 no-messaging journey uses the fake endpoint. One Brev Linux amd64 no-messaging
   journey uses the existing approved inference route. Live messaging stays excluded.
