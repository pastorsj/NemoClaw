// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, it } from "vitest";

const PROFILE = path.resolve(import.meta.dirname, "../../runtime/managed-gateway-profile.py");

it("declares Hermes process identity and readiness through the fixed profile", () => {
  const result = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util,json,sys",
          "s=importlib.util.spec_from_file_location('profile',sys.argv[1])",
          "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
          "v=m.agent_spec({'NEMOCLAW_HERMES_API_PORT':'8648'})",
          "ok=m.gateway_matches((b'/usr/local/bin/hermes',b'gateway',b'run'),18642)",
          "print(json.dumps({'spec':v,'matches':ok}))",
        ].join(";"),
        PROFILE,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result).toEqual({
    spec: { name: "managed-agent", port: 18642, readiness_checks: [[8648, "/health"]] },
    matches: true,
  });
});
