// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const TEST_IMAGE = process.env.NEMOCLAW_HERMES_TEST_IMAGE?.trim();
const ADAPTER_PYTHON = "/opt/hermes/.venv/bin/python";
const OFFLINE_API_KEY = "nemoclaw-offline-lifecycle-check";
const START_MARKER = "NEMOCLAW_HERMES_FABRIC_STARTED";
const STOP_MARKER = "NEMOCLAW_HERMES_FABRIC_STOPPED";

const lifecycleScript = String.raw`
import asyncio
import json
import os
import tempfile
from pathlib import Path

from nemo_fabric import Fabric, FabricConfig

adapter_python = Path(os.environ["NEMOCLAW_HERMES_ADAPTER_PYTHON"])
if adapter_python != Path("${ADAPTER_PYTHON}") or not adapter_python.is_file():
    raise RuntimeError("Hermes Fabric adapter interpreter is unavailable")


async def verify_lifecycle() -> None:
    source = Path("/sandbox/.hermes/fabric.json")
    payload = json.loads(source.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="nemoclaw-hermes-fabric-", dir="/tmp") as temporary:
        run_root = Path(temporary)
        workspace = run_root / "workspace"
        artifacts = run_root / "artifacts"
        workspace.mkdir(mode=0o700)
        artifacts.mkdir(mode=0o700)
        payload["runtime"]["artifacts"] = str(artifacts)
        payload["environment"]["workspace"] = str(workspace)
        payload["environment"]["artifacts"] = str(artifacts)
        config = FabricConfig.from_mapping(payload)
        client = Fabric()
        async with await client.start_runtime(config, base_dir=run_root):
            print("${START_MARKER}", flush=True)
    print("${STOP_MARKER}", flush=True)


asyncio.run(verify_lifecycle())
`;

function formatFailure(result: ReturnType<typeof spawnSync>): string {
  const output = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .replaceAll(OFFLINE_API_KEY, "[redacted]");
  return output || "Docker exited without diagnostics";
}

describe.skipIf(!TEST_IMAGE)("Hermes final-image Fabric lifecycle", () => {
  it("starts and stops the released adapter without network access or inference", () => {
    if (!TEST_IMAGE) {
      throw new Error("NEMOCLAW_HERMES_TEST_IMAGE is required");
    }
    expect(TEST_IMAGE).not.toMatch(/^[-\s]|[\0\r\n]/);

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=512m",
        "--user=sandbox",
        `--env=HERMES_FABRIC_API_KEY=${OFFLINE_API_KEY}`,
        "--entrypoint=/opt/nemoclaw-fabric-venv/bin/python3",
        TEST_IMAGE,
        "-I",
        "-c",
        lifecycleScript,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 45_000,
      },
    );

    const diagnostic = formatFailure(result);
    expect(result.status, diagnostic).toBe(0);
    expect(result.stdout, diagnostic).toContain(START_MARKER);
    expect(result.stdout, diagnostic).toContain(STOP_MARKER);
  }, 50_000);
});
