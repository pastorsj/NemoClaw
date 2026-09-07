// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  bindJournaledRecreate,
  createDeps,
  expectedSessionPackageAuthority,
} from "./sandbox-test-fixtures";

// These tests own startup-control composition. Package store and messaging
// profile integrity are exercised at their dedicated authority boundaries.
vi.mock("../../../messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../messaging")>();
  return {
    ...actual,
    resolveSandboxMessagingProfileAuthority: vi.fn((entry: { agent?: string }) => ({
      agent: { name: entry.agent },
    })),
    listMessagingChannelsForProfile: vi.fn(() => []),
  };
});

const FUTURE_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0-test",
  contentDigest: "f".repeat(64),
};

const DCODE_PACKAGE = {
  ...FUTURE_PACKAGE,
  id: "langchain-deepagents-code",
  contentDigest: "d".repeat(64),
};

function packageAgent(id: string, startupControls: readonly ("approval-mode" | "observability")[]) {
  return {
    name: id,
    packageRoot: `/var/lib/nemoclaw/harnesses/objects/${"a".repeat(64)}`,
    sandbox_create: { startup_controls: startupControls },
  };
}

function packageRegistryEntry(
  name: string,
  harnessPackage: typeof FUTURE_PACKAGE,
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  return {
    name,
    agent: harnessPackage.id,
    harnessPackage,
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions",
    toolDisclosure: "progressive",
    observabilityEnabled: false,
    approvalMode: "disabled",
    webSearchEnabled: false,
    webSearchProvider: null,
    fromDockerfile: null,
    hermesAuthMethod: null,
    ...overrides,
  };
}

function packageDeps(session: Session, overrides: Parameters<typeof createDeps>[0] = {}) {
  return createDeps(
    {
      revalidateHarnessPackageAuthority: () => expectedSessionPackageAuthority(session),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
      ...overrides,
    },
    session,
  );
}

describe("receipt-backed sandbox startup controls", () => {
  it("creates an unknown package through declared controls without a core harness branch", async () => {
    const session = createSession({ agent: FUTURE_PACKAGE.id, harnessPackage: FUTURE_PACKAGE });
    const { deps, calls } = packageDeps(session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      fresh: true,
      agent: packageAgent(FUTURE_PACKAGE.id, ["approval-mode", "observability"]),
      requestedObservabilityEnabled: true,
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    const createIntent = calls.createSandbox.mock.calls[0]?.at(-2);
    expect(createIntent).toMatchObject({
      approvalMode: "thread-opt-in",
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
    });
    expect(createIntent).not.toHaveProperty("dcodeAutoApprovalMode");
  });

  it("keeps DCode behavior while using the same receipt-backed fields", async () => {
    const session = createSession({ agent: DCODE_PACKAGE.id, harnessPackage: DCODE_PACKAGE });
    const { deps, calls } = packageDeps(session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      fresh: true,
      agent: packageAgent(DCODE_PACKAGE.id, ["approval-mode", "observability"]),
      requestedObservabilityEnabled: true,
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    const createIntent = calls.createSandbox.mock.calls[0]?.at(-2);
    expect(createIntent).toMatchObject({
      approvalMode: "thread-opt-in",
      observabilityEnabled: true,
    });
    expect(createIntent).not.toHaveProperty("dcodeAutoApprovalMode");
  });

  it("recreates an unknown ready package when a declared control changes", async () => {
    const session = createSession({
      agent: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      sandboxName: "saved",
    });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session, "saved", FUTURE_PACKAGE.id);
    const { deps, calls } = packageDeps(session, {
      getSandboxReuseState: () => "ready",
      getSandboxRecreateObservation: journal.observe,
      getSandboxRegistryEntry: (name: string) => packageRegistryEntry(name, FUTURE_PACKAGE),
      createSandbox: journal.completeCreate,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      agent: packageAgent(FUTURE_PACKAGE.id, ["approval-mode", "observability"]),
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    const createIntent = journal.completeCreate.mock.calls[0]?.at(-2);
    expect(createIntent).toMatchObject({
      recreate: true,
      approvalMode: "thread-opt-in",
    });
    expect(createIntent).not.toHaveProperty("dcodeAutoApprovalMode");
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Approval-mode configuration changed; recreating sandbox.",
    );
  });

  it("rejects controls that the receipt-backed package does not declare", async () => {
    const session = createSession({ agent: FUTURE_PACKAGE.id, harnessPackage: FUTURE_PACKAGE });
    const { deps, calls } = packageDeps(session);

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        agent: packageAgent(FUTURE_PACKAGE.id, []),
        requestedObservabilityEnabled: true,
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      "  The selected harness package does not declare the observability startup control.",
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
