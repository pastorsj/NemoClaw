// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";
import { hermesPortableReceiptDirectory } from "./hermes-portable-receipt";

let stateDir: string;
let policyPath: string;

function input() {
  return createHermesPortableTestInput(stateDir, policyPath);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-package-authority-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable package authority", () => {
  it("revalidates live package authority at every durable publication boundary", async () => {
    const operations: string[] = [];
    const fixture = createHermesPortableTransactionFixture(input(), {
      revalidateHarnessPackageAuthority: (operation) => operations.push(operation),
    });

    await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(operations).toEqual([
      "publish Hermes portable durable policy source",
      "publish Hermes portable pending lifecycle receipt",
      "publish Hermes portable configuring lifecycle receipt",
      "publish Hermes portable active lifecycle receipt",
      "publish Hermes portable successor lifecycle receipt",
    ]);
  });

  it.each([
    {
      boundary: "durable policy",
      createRevalidation: () =>
        vi.fn(() => {
          throw new Error("package drift");
        }),
      expectedAbsentPath: () => hermesPortableReceiptDirectory("alpha", stateDir),
    },
    {
      boundary: "pending lifecycle receipt",
      createRevalidation: () =>
        vi
          .fn()
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("package drift");
          }),
      expectedAbsentPath: () =>
        path.join(hermesPortableReceiptDirectory("alpha", stateDir), "pending.json"),
    },
  ])("refuses $boundary publication after package drift", async (scenario) => {
    const createSandbox = vi.fn(async () => ({ ready: true as const }));
    const fixture = createHermesPortableTransactionFixture(input(), {
      createSandbox,
      revalidateHarnessPackageAuthority: scenario.createRevalidation(),
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "package drift",
    );

    expect(fs.existsSync(scenario.expectedAbsentPath())).toBe(false);
    expect(createSandbox).not.toHaveBeenCalled();
  });
});
