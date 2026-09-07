<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Fabric Runner

`nemoclaw-fabric` runs one headless agent request through a package-selected
NeMo Fabric adapter. The runner reads a normal Fabric configuration. It does
not select or install adapters.

This path is a local product-scope candidate, not an approved support or distribution policy.
LangChain Deep Agents Code and Hermes use released Fabric adapters. Pi, OpenClaw, DeepSeek
Harness, and Haystack Agent use small package-owned adapters around stable native headless
commands. The Fabric path does not replace their native interactive or gateway commands.

```bash
nemoclaw-fabric --version
nemoclaw-fabric doctor --config /etc/nemoclaw/fabric.json
nemoclaw-fabric run --config /etc/nemoclaw/fabric.json -m "Review the workspace"
nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 \
  --config /etc/nemoclaw/fabric.json --stdin
```

`run` accepts one prompt source: `-m`, positional text, or `--stdin`. Add
`--json` to print the normalized Fabric report or result as one JSON object.
The runner accepts at most 1 MiB of UTF-8 prompt text and emits at most 1 MiB
for one rendered result or doctor report. It rejects an oversized prompt
before creating the Fabric client and returns `output_limit_exceeded` instead
of forwarding an oversized result.

The configuration file is the integration boundary. It is validated as a
native `FabricConfig`. This experimental qualification covers configurations
selected by `harness.adapter_id` only. Configurations using
`workflow.target_id` are parsed and validated, but workflow execution has not
been qualified through this runner. The runner has no adapter registry or
adapter-specific branches. Relative paths are resolved from the configuration
file's directory. Every config must set a positive, finite
`runtime.timeout_seconds` value.

Use environment-variable-name indirection for credentials. The runner detects
Fabric's credential fields and adapter extension fields ending in names such
as `_env`. For an adapter with a different convention, list its environment
variable names in
`environment.metadata.nemoclaw.credential_environment_names`. Entries must be
unique environment variable names. Literal credentials in sensitive
`environment.env`, header, model, or adapter settings are rejected before
Fabric starts. URI authority userinfo is rejected in every configuration
string, independent of scheme or adapter.

An agent package can reject an unsafe composition by setting
`environment.metadata.nemoclaw.invocation_unavailable_reason`. The runner
returns `unsupported_configuration` before it creates the Fabric client. The
Deep Agents Code package uses this guard because the released Fabric 0.2
adapter cannot apply Nemotron Ultra's managed `force_nonempty_content` option
or `NEMOCLAW_REASONING_EFFORT`. Use native `dcode -n` for those configurations.

The process exits with `0` after a successful run or a doctor pass/warning,
`1` after a doctor, adapter, lifecycle, or unexpected failure, and `2` after a
command-input or configuration error. SIGINT and SIGTERM request cancellation,
wait for Fabric's cleanup path, and exit with `130` or `143`. Fabric 0.2 does
not expose target cancellation, so cleanup can wait for the active invocation
to return or reach `runtime.timeout_seconds`. An installed agent package must
also put the command behind an operating-system deadline. The Deep Agents Code
manifest uses a 120-second TERM boundary and sends KILL ten seconds later; its
inner Fabric timeout is 90 seconds.

Plain failures go to standard error. For a syntactically valid `doctor` or
`run` invocation, `--json` emits one redacted object on standard output,
including failures. Argument-parser syntax errors are rendered as redacted
`invalid_arguments` errors on standard error and exit with `2`; they are not
normalized as JSON.
Credential-shaped environment values, values under credential-shaped result
keys, common token forms, and prompts embedded in exception diagnostics are
redacted.

Each package configuration names the same artifact directory in
`runtime.artifacts` and `environment.artifacts`. That directory must be a
canonical direct child of the configuration directory. The runner creates a
missing direct child with mode `0700`, then gives every request its own private
directory. Fabric can use that directory while the request is active. After
successful cleanup, NemoClaw has removed it on success, failure, timeout, or
cancellation. The public result therefore reports an empty artifact manifest
and omits output or metadata fields that point inside the removed directory.

The sandbox agent, its adapter, and other processes running as the sandbox user
share one operating-system identity. The private request directory prevents
routine Fabric retention and access by other sandbox identities; it is not an
isolation boundary between processes running as that same user. NemoClaw treats
the gateway and root identities inside the sandbox as trusted lifecycle owners.

Package manifests use `nemoclaw-fabric-run`, which owns the worker process,
hard deadline, stop grace, and final artifact cleanup. If a worker must be
killed, the supervisor removes only directories bearing that worker's process
identifier. A completed cleanup does not leave prompts or credentials in
Fabric's diagnostic tree, and independent worker processes do not delete one
another's state.

On Linux, the supervisor becomes a child subreaper before it starts the
worker. It adopts, signals, and reaps nested sessions when an adapter cleanup
owner cannot return. The command fails before starting a worker if Linux does
not provide that ownership boundary. Other operating systems retain the
worker-process-group cleanup boundary.

If process-group shutdown or artifact removal cannot be confirmed, the
supervisor returns a generic failure instead of success. That failure requires
the operator to inspect and remove entries from the package's dedicated
`fabric-artifacts` directory before treating another turn as qualified. An
unrecoverable kill of the supervisor itself or loss of the sandbox host can
prevent cleanup; the next qualification probe detects the non-empty artifact
root rather than claiming a clean turn.

From the repository root, run the complete isolated test lane:

```bash
npm run test:fabric
```

The command first qualifies the generic runner from its own source copy and
hash lock. It then discovers every installable harness package from the same
`nemoclaw.harnessManifest` marker used by the installer and runs that package's
composed Fabric proof. Adding a package therefore adds coverage without editing
a central harness list. The lane runs:

- Generic runner unit tests.
- Generic released-SDK lifecycle tests.
- Deep Agents Code, Pi, OpenClaw, Hermes, DeepSeek Harness, and Haystack Agent
  through their package-owned adapter and generic-runner lifecycle boundaries.

The generic runner can be qualified independently from its directory:

```bash
bash tests/run-tests.sh
```

The generic tests can also run from an environment that has the `test` extra:

```bash
python -m unittest discover -s tests/unit -v
python -m unittest tests/integration/test_fabric.py -v
```

## Add an agent package

Keep the adapter-specific work in the agent package:

1. Add the released Fabric adapter, or a small package-owned adapter, to the
   package's hash lock.
2. Generate a Fabric config that selects the adapter, sets `runtime.timeout_seconds`, and names credential environment variables.
3. Mark configurations unavailable when the released adapter cannot preserve required agent behavior.
4. Set a bounded manifest headless command, such as `nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config ...`.
5. Install the runner and adapter graph in the package image.
6. Add only the network policy destinations that the runner and adapter use.
7. Implement `test:fabric` for the adapter boundary and `test:fabric:composed`
   for the same cases through `nemoclaw-fabric`. The root lane discovers both
   from package metadata.

Keep the native agent command available for behavior the Fabric adapter does
not preserve. The runner package must not import the agent package or branch on
its adapter ID.
