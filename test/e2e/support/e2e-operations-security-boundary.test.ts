// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

describe("E2E operations workflow security boundaries", () => {
  it("sanitizes raw traces before cleanup", () => {
    const workflow = readE2eOperationsWorkflow();
    const cloudSteps = workflow.jobs["cloud-onboard"].steps!;
    const sanitize = cloudSteps.find(
      (step) => step.name === "Build trusted cloud-onboard timing summary",
    )!;
    sanitize.run = "cp -R raw-traces e2e-artifacts";

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "cloud-onboard trace sanitizer must retain scripts/e2e/sanitize-trace-timing.py",
    );
  });

  it("prevents the PR Review Advisor from writing to Actions or dispatching workflows", () => {
    const workflow = readE2eOperationsWorkflow();
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-operations-"));
    const advisorPath = join(directory, "advisor.yaml");
    try {
      writeFileSync(advisorPath, "permissions: write-all\njobs:\n  advisor:\n    steps: []\n");
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toContain(
        "Unified advisor must not hold actions: write",
      );

      writeFileSync(
        advisorPath,
        'permissions: read-all\njobs:\n  advisor:\n    permissions:\n      actions: "write"\n    steps:\n      - run: createWorkflowDispatch()\n',
      );
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toEqual(
        expect.arrayContaining([
          "Unified advisor must not hold actions: write",
          "Unified advisor must not auto-dispatch workflows",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
