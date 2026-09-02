// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { failedStartupProcessControlCommands } from "../fixtures/shields-failed-startup.ts";

export interface ChildlessBoundaryShim {
  readonly directory: string;
  readonly executable: string;
  readonly receipt: string;
  readonly resumeSupervisor: string[];
}

export function createPolicySetChildlessBoundaryShim(options: {
  configGuardPath: string;
  containerId: string;
  realOpenshellPath: string;
  runtimeCommand: string;
  runtimePrefix: readonly string[];
  sandboxName: string;
  startupPid: number;
  tempRoot: string;
}): ChildlessBoundaryShim {
  const directory = fs.mkdtempSync(path.join(options.tempRoot, "shields-openshell-"));
  const executable = path.join(directory, "openshell-childless-boundary.cjs");
  const receipt = path.join(directory, "childless-boundary.json");
  const processControl = failedStartupProcessControlCommands(
    options.containerId,
    options.startupPid,
  );
  const childlessCensusScript = [
    "import runpy, sys, time",
    `guard = runpy.run_path(${JSON.stringify(options.configGuardPath)})`,
    "identity = guard['_production_identity']()",
    "for _ in range(100):",
    "    census = guard['_openshell_supervised_nonroot_start_census'](identity.root_uid, identity.sandbox_uid)",
    "    if census is not None and census[0] == 0:",
    "        sys.exit(0)",
    "    time.sleep(0.1)",
    "sys.exit(1)",
  ].join("\n");
  const shimSource = `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const delegated = spawnSync(${JSON.stringify(options.realOpenshellPath)}, args, {
  env: process.env,
  stdio: "inherit",
});
if (delegated.error || delegated.status !== 0) {
  if (delegated.error) console.error(delegated.error.message);
  process.exit(delegated.status ?? 1);
}

const isTargetPolicySet =
  args[0] === "policy" &&
  args[1] === "set" &&
  args.includes("--wait") &&
  args.at(-1) === ${JSON.stringify(options.sandboxName)};
if (!isTargetPolicySet || fs.existsSync(${JSON.stringify(receipt)})) process.exit(0);

fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ status: "arming" }), {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
const runtimeCommand = ${JSON.stringify(options.runtimeCommand)};
const runtimePrefix = ${JSON.stringify(options.runtimePrefix)};
const pause = spawnSync(runtimeCommand, [...runtimePrefix, ...${JSON.stringify(processControl.pauseSupervisor)}], {
  env: process.env,
  stdio: "inherit",
});
if (pause.error || pause.status !== 0) process.exit(pause.status ?? 1);
const terminate = spawnSync(runtimeCommand, [...runtimePrefix, ...${JSON.stringify(processControl.terminateStartupChild)}], {
  env: process.env,
  stdio: "inherit",
});
if (terminate.error || terminate.status !== 0) process.exit(terminate.status ?? 1);
const childless = spawnSync(
  runtimeCommand,
  [
    ...runtimePrefix,
    "exec",
    "--user",
    "0",
    ${JSON.stringify(options.containerId)},
    "python3",
    "-I",
    "-c",
    ${JSON.stringify(childlessCensusScript)},
  ],
  { env: process.env, stdio: "inherit" },
);
if (childless.error || childless.status !== 0) process.exit(childless.status ?? 1);
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ status: "childless" }), {
  encoding: "utf8",
  mode: 0o600,
});
`;
  fs.writeFileSync(executable, shimSource, { encoding: "utf8", mode: 0o700 });
  return {
    directory,
    executable,
    receipt,
    resumeSupervisor: processControl.resumeSupervisor,
  };
}
