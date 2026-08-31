// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_DISPLAY_ENTRIES } from "../../lib/cli/public-display-defaults";
import type { HarnessPackageValidationReport } from "../../lib/agent-runtime/package/validation";
import HarnessValidateCommand, { harnessValidateCommandDependencies } from "./validate";

const rootDir = process.cwd();
const DIGEST = "a".repeat(64);
const REPORT: HarnessPackageValidationReport = {
  schemaVersion: 1,
  valid: true,
  identity: {
    kind: "agent-runtime",
    id: "example-runtime",
    packageVersion: "1.2.3",
    contentDigest: DIGEST,
  },
  displayName: "Example Runtime",
  manifest: "agents/example-runtime/manifest.yaml",
  runtimeKind: "terminal",
  entryCount: 6,
  totalBytes: 512,
};

describe("harness validate oclif command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "validates one artifact and reports that it was not installed",
    { timeout: 15_000 },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const validate = vi
        .spyOn(harnessValidateCommandDependencies, "validateHarnessPackage")
        .mockReturnValue(REPORT);

      await HarnessValidateCommand.run(["./built-package"], rootDir);

      expect(validate).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledWith("./built-package");
      expect(log).toHaveBeenCalledWith(
        `Validated built agent runtime package 'example-runtime' (1.2.3, sha256:${DIGEST}) without installing it.`,
      );
    },
  );

  it("returns the same path-free report through oclif JSON output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(harnessValidateCommandDependencies, "validateHarnessPackage").mockReturnValue(REPORT);

    const result = await HarnessValidateCommand.run(["./built-package", "--json"], rootDir);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

    expect(HarnessValidateCommand.enableJsonFlag).toBe(true);
    expect(result).toEqual(REPORT);
    expect(output).toEqual(REPORT);
    expect(JSON.stringify(output)).not.toContain("built-package");
  });

  it("requires one artifact directory before attempting validation", async () => {
    const validate = vi.spyOn(harnessValidateCommandDependencies, "validateHarnessPackage");

    await expect(HarnessValidateCommand.run([], rootDir)).rejects.toThrow();

    expect(validate).not.toHaveBeenCalled();
  });

  it("publishes one explicit public display row", () => {
    expect(PUBLIC_DISPLAY_ENTRIES["harness:validate"]).toEqual([
      {
        usage: "nemoclaw harness validate",
        description: "Validate one built agent runtime package without changing it",
        flags: "<artifact-directory> [--json]",
        group: "Getting Started",
        deprecated: undefined,
        hidden: undefined,
        scope: "global",
        order: 1.65,
      },
    ]);
  });
});
