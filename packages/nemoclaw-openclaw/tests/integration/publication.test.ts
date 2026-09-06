// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  completeOpenClawFabricImageContract,
  inspectOpenClawPublications,
} from "../helpers/publication";

it("keeps every protected OpenClaw publication recipe on the package Fabric contract", () => {
  const inspection = inspectOpenClawPublications();
  expect(inspection.packageDockerfilePath).not.toBeNull();
  expect(inspection.protectedPaths).toHaveLength(1);
  expect(inspection.workflowPaths.length).toBeGreaterThan(0);
  expect(inspection.packageContract).toEqual(completeOpenClawFabricImageContract);
  expect(inspection.publications.map((publication) => publication.pathIsAbsolute)).not.toContain(
    true,
  );
  expect(inspection.publications.flatMap((publication) => publication.pathSegments)).not.toContain(
    "..",
  );
  expect(inspection.publications.map((publication) => publication.isFile)).not.toContain(false);
  expect(inspection.publications.map((publication) => publication.contract)).toEqual(
    inspection.publications.map(() => inspection.packageContract),
  );

  expect(inspection.agent.runtime?.headless_command).toBe(
    "nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 15 --config /sandbox/.openclaw/fabric.json",
  );
  expect(inspection.agent.runtime?.smoke_commands).toEqual(
    expect.arrayContaining([
      "nemoclaw-fabric --version",
      "test -s /sandbox/.openclaw/fabric.json && echo NEMOCLAW_OPENCLAW_FABRIC_OK",
      'test "$(stat -c %a /sandbox/.openclaw/fabric.json)" = 600 && echo NEMOCLAW_OPENCLAW_FABRIC_MODE_OK',
    ]),
  );
});
