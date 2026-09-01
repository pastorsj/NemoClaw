// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import { normalizeInferenceSelection } from "../../inference/selection";
import { createSession } from "../../state/onboard-session";
import {
  revalidateSelectedHarnessPackageAuthority,
  withHarnessPackageRevalidation,
} from "./orchestration";

const HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.0.0-test",
  contentDigest: "a".repeat(64),
};

let packageRoot: string;

beforeEach(() => {
  packageRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-selected-package-")),
  );
});

afterEach(() => fs.rmSync(packageRoot, { recursive: true, force: true }));

function selectedPackageFixture() {
  const session = createSession({
    agent: null,
    harnessPackage: HARNESS_PACKAGE,
    harnessPackageMigration: null,
  });
  const effectiveAgent = { name: "openclaw", packageRoot } as AgentDefinition;
  const resolveSandboxAgent = vi.fn(() => ({
    recordedAgent: null,
    effectiveAgentId: "openclaw",
    definition: effectiveAgent,
    harnessPackage: HARNESS_PACKAGE,
    harnessPackageMigration: null,
  }));
  return { effectiveAgent, resolveSandboxAgent, session };
}

describe("sandbox create package authority", () => {
  it("revalidates package authority before checkpoint and verified-policy mutations", () => {
    const events: string[] = [];

    expect(
      withHarnessPackageRevalidation(
        "record verified policy",
        (operation) => events.push(`package:${operation}`),
        () => {
          events.push("mutation");
          return "recorded";
        },
      ),
    ).toBe("recorded");
    expect(events).toEqual(["package:record verified policy", "mutation"]);

    const mutation = vi.fn();
    expect(() =>
      withHarnessPackageRevalidation(
        "continue verified policy",
        () => {
          throw new Error("package drift");
        },
        mutation,
      ),
    ).toThrow("package drift");
    expect(mutation).not.toHaveBeenCalled();
  });

  it("accepts an exact route, Session, and pinned definition tuple", () => {
    const { effectiveAgent, resolveSandboxAgent, session } = selectedPackageFixture();

    expect(
      revalidateSelectedHarnessPackageAuthority(
        {
          expectedSession: session,
          routeAuthority: {
            sessionId: session.sessionId,
            selection: normalizeInferenceSelection(null),
            harnessPackage: HARNESS_PACKAGE,
            harnessPackageMigration: null,
          },
          effectiveAgent,
          operation: "create sandbox",
        },
        { loadSession: () => structuredClone(session), resolveSandboxAgent },
      ),
    ).toEqual({ harnessPackage: HARNESS_PACKAGE, harnessPackageMigration: null });
    expect(resolveSandboxAgent).toHaveBeenCalledOnce();
    expect(resolveSandboxAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ requireLifecycleEligibility: true }),
    );
  });

  it("rejects route package drift before sandbox mutation", () => {
    const { effectiveAgent, resolveSandboxAgent, session } = selectedPackageFixture();
    const createSandbox = vi.fn();

    expect(() => {
      revalidateSelectedHarnessPackageAuthority(
        {
          expectedSession: session,
          routeAuthority: {
            sessionId: session.sessionId,
            selection: normalizeInferenceSelection(null),
            harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "b".repeat(64) },
            harnessPackageMigration: null,
          },
          effectiveAgent,
          operation: "create sandbox",
        },
        { loadSession: () => structuredClone(session), resolveSandboxAgent },
      );
      createSandbox();
    }).toThrow(/selected harness package authority changed/u);

    expect(createSandbox).not.toHaveBeenCalled();
  });
});
