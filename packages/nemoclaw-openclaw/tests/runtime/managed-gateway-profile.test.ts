// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, it } from "vitest";

const PROFILE = path.resolve(import.meta.dirname, "../../runtime/managed-gateway-profile.py");

it("declares OpenClaw process identity and port behavior through the fixed profile", () => {
  const result = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util,json,sys",
          "s=importlib.util.spec_from_file_location('profile',sys.argv[1])",
          "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
          "v=m.agent_spec({'NEMOCLAW_DASHBOARD_PORT':'19000'})",
          "ok=m.gateway_matches((b'node',b'openclaw.mjs',b'gateway',b'run',b'--port',b'19000'),19000)",
          "print(json.dumps({'spec':v,'matches':ok}))",
        ].join(";"),
        PROFILE,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result).toEqual({
    spec: { name: "managed-agent", port: 19000, readiness_checks: [] },
    matches: true,
  });
});
