<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Fabric Runner

`nemoclaw-fabric` runs one headless agent request through a package-selected
NeMo Fabric adapter. The runner reads a normal Fabric configuration. It does
not select or install adapters.

This path is an experimental fork evaluation. It is not canonical NemoClaw
behavior. For LangChain Deep Agents Code, this path invokes the released
Fabric Deep Agents adapter in a separate dependency graph. It does not replace
or emulate native `dcode -n`, its plugins, or its model request settings.

```bash
nemoclaw-fabric --version
nemoclaw-fabric doctor --config /etc/nemoclaw/fabric.json
nemoclaw-fabric run --config /etc/nemoclaw/fabric.json -m "Review the workspace"
```

`run` accepts one prompt source: `-m`, positional text, or `--stdin`. Add
`--json` to print the normalized Fabric report or result as one JSON object.

The configuration file is the integration boundary. It is validated as a
native `FabricConfig`, and its `harness.adapter_id` or `workflow.target_id`
selects the adapter. The runner has no adapter registry or adapter-specific
branches. Relative paths are resolved from the configuration file's directory.
Every config must set a positive, finite `runtime.timeout_seconds` value.

Use environment-variable-name indirection for credentials. The runner detects
Fabric's credential fields and adapter extension fields ending in names such
as `_env`. For an adapter with a different convention, list its environment
variable names in
`environment.metadata.nemoclaw.credential_environment_names`. Entries must be
unique environment variable names. Literal credentials in sensitive
`environment.env`, header, model, or adapter settings are rejected before
Fabric starts.

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
including failures. Argument-parser syntax errors retain argparse's standard
error output and exit code `2`; they are not normalized as JSON.
Credential-shaped environment values, common token forms, and prompts embedded
in exception diagnostics are redacted.

From the repository root, run the complete isolated test lane:

```bash
npm run test:fabric
```

The command creates a Python 3.13 environment. It installs the package-owned
hash locks for build tooling and runtime dependencies, builds the runner
offline, installs it without dependency resolution, and runs:

- Generic runner unit tests.
- Generic released-SDK lifecycle tests.
- The Deep Agents package's real adapter test against a loopback endpoint.
- `pip check` for the installed dependency graph.

The generic tests can also run from an environment that has the `test` extra:

```bash
python -m unittest discover -s tests/unit -v
python -m unittest tests/integration/test_fabric.py -v
```

## Add an agent package

Keep the adapter-specific work in the agent package:

1. Add the released Fabric adapter to the package's hash lock.
2. Generate a Fabric config that selects the adapter, sets `runtime.timeout_seconds`, and names credential environment variables.
3. Mark configurations unavailable when the released adapter cannot preserve required agent behavior.
4. Set a bounded manifest headless command, such as `timeout --signal=TERM --kill-after=10s 120s nemoclaw-fabric run --config ...`.
5. Install the runner and adapter graph in the package image.
6. Add only the network policy destinations that the runner and adapter use.
7. Add a package-owned test that runs the generated config through the released adapter.

Keep the native agent command available for behavior the Fabric adapter does
not preserve. The runner package must not import the agent package or branch on
its adapter ID.
