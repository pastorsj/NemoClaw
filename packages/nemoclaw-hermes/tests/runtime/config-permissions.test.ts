// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { expect, it } from "vitest";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "..",
  "runtime",
  "config-guard.py",
);

it("does not weaken the guard: an explicitly group/world-writable config is still rejected (#6448)", () => {
  // The normalization only affects how test fixtures are created; the production
  // guard must still fail closed on an explicitly unsafe (0o666) runtime config
  // path. This proves the harness change did not relax the security boundary.
  const result = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util, os, sys, tempfile

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

d = tempfile.mkdtemp()
os.chmod(d, 0o700)
p = os.path.join(d, "config.yaml")
open(p, "w", encoding="utf-8").write("model: test\n")
os.chmod(p, 0o666)
try:
    guard._open_regular(p).close()
except guard.UnsafePathError as exc:
    sys.stdout.write("REJECTED:" + str(exc))
else:
    sys.stdout.write("ACCEPTED")
`,
      RUNTIME_CONFIG_GUARD,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("REJECTED:");
  expect(result.stdout).toContain("group/world-writable");
});
