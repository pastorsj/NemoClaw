// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCredential } from "../../../security/credential-hash";
import {
  decisionDeclined,
  decisionSelected,
  decisionUnset,
} from "../../../state/onboard-checkpoint-decision";
import { CHECKPOINT_SCHEMA_VERSION } from "../../../state/onboard-checkpoint-types";
import { createSession, type Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  bindJournaledRecreate,
  createDeps,
  makeMinimalPlan,
  testWebSearchBinding,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

// Sandbox state tests own orchestration, not installed-package integrity. Keep
// receipt-backed cases at the messaging-profile boundary; store validation has
// dedicated package-authority coverage.
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

const detectMessagingChannelsFromEnvMock = vi.mocked(detectMessagingChannelsFromEnv);

function dcodeRegistryEntry(name: string, observabilityEnabled?: boolean) {
  return {
    name,
    agent: "langchain-deepagents-code",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    toolDisclosure: "progressive" as const,
    ...(typeof observabilityEnabled === "boolean" ? { observabilityEnabled } : {}),
  };
}

describe("handleSandboxState", () => {
  beforeEach(() => {
    detectMessagingChannelsFromEnvMock.mockReturnValue([]);
  });

  it("creates a sandbox and records messaging/web search state", async () => {
    const { deps, calls } = createDeps({
      configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
    });
    calls.setupMessaging.mockResolvedValue(["telegram"]);
    const result = await handleSandboxState({ ...baseOptions(deps), fresh: true });
    expect(calls.startStep).toHaveBeenCalledWith("sandbox", {
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
    });
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, null, "my-assistant");
    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true },
      ["telegram"],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
      null,
      expect.objectContaining({ sessionId: expect.any(String), selection: expect.any(Object) }),
      {
        resolved: expect.any(Object),
        recreate: false,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        endpointSource: null,
        extraProviders: [],
      },
      undefined,
    );
    expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ model: "model", provider: "provider" }),
    );
    expect(
      calls.updateSandbox.mock.calls.some(
        ([sandboxName, patch]) =>
          sandboxName === "my-assistant" && Object.prototype.hasOwnProperty.call(patch, "agent"),
      ),
    ).toBe(false);
    // Default-marking is deferred to finalization (#4614) — the sandbox step must not set it.
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ sandboxName: "my-assistant" }),
    );
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      webSearchConfigChanged: true,
      webSearchSupported: true,
    });
    expect(result.session?.sandboxName).toBe("my-assistant");
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "openclaw",
      transitionKind: "branch",
      updates: undefined,
      metadata: { state: "sandbox", sandboxName: "my-assistant", agent: "openclaw" },
    });
    expect(result.session?.checkpoint?.webSearch).toEqual(decisionSelected({ fetchEnabled: true }));
    expect(result.session?.checkpoint?.messaging).toEqual(decisionDeclined());
  });

  it("preserves a null endpoint source for fresh host-local inference-only creation (#9203)", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      fresh: true,
      endpointUrl: "http://host.openshell.internal:11435/v1",
      endpointSource: null,
      hostLocalInferenceRouteOnly: true,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ endpointSource: null });
  });

  it("records credential-provider bindings and the resource-profile decision in the checkpoint (#7022)", async () => {
    const { deps } = createDeps({
      configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
      stageSandboxCredentialProviders: vi.fn(async () => [
        { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      ]),
      providerMatchesGatewayCredential: (name, type, credentialEnv) =>
        name === "my-assistant-brave-search" &&
        type === "brave" &&
        credentialEnv === "BRAVE_API_KEY",
      selectResourceProfileForSandbox: vi.fn(async () => ({ cpu: "2", memory: "4Gi" })),
    });

    const result = await handleSandboxState(baseOptions(deps));

    expect(result.session?.checkpoint?.bindings.registeredProviders).toEqual([
      { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
    ]);
    expect(result.session?.checkpoint?.bindings.credentialEnvs).toEqual(["BRAVE_API_KEY"]);
    expect(result.session?.checkpoint?.resourceProfile).toEqual(
      decisionSelected({ cpu: "2", memory: "4Gi" }),
    );
  });

  it("skips re-registering a provider whose effect-group receipt and live postcondition both hold (#7022)", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      harnessPackage: null,
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionUnset(),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: "my-assistant-brave-search",
        },
      },
      bindings: {
        credentialEnvs: [],
        registeredProviders: [
          { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
        ],
      },
      sandboxRecreate: null,
    };
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const stageSandboxCredentialProviders = vi.fn(async () => [
      { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
    ]);
    const { deps } = createDeps({
      updateSession,
      configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
      stageSandboxCredentialProviders,
      providerMatchesGatewayCredential: (name, type, credentialEnv) =>
        name === "my-assistant-brave-search" &&
        type === "brave" &&
        credentialEnv === "BRAVE_API_KEY",
    });

    await handleSandboxState({ ...baseOptions(deps, session), sandboxName: "my-assistant" });

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
  });

  it("does not auto-enable web search from ambient credentials during authoritative rebuild", async () => {
    const configureWebSearch = vi.fn(async () => ({ fetchEnabled: true as const }));
    const { deps, calls } = createDeps({ configureWebSearch });

    const result = await handleSandboxState({
      ...baseOptions(deps),
      authoritativeResumeConfig: true,
      env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
    });

    expect(configureWebSearch).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[5]).toBeNull();
    expect(result.webSearchConfig).toBeNull();
  });
  it("carries an authoritative rebuild tier in the sandbox create intent", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      agent: { name: "langchain-deepagents-code" },
      authoritativeResumeConfig: true,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({});
  });

  it("does not persist an authoritative policy tier in sandbox create state", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      agent: { name: "langchain-deepagents-code" },
      authoritativeResumeConfig: true,
    });

    expect(calls.resolveCreateIntent.mock.calls[0]?.[0]).not.toHaveProperty("policyTier");
    expect(calls.createSandbox.mock.calls[0]?.at(-2)).not.toHaveProperty("policyTier");
  });

  it("rejects observability for a selected non-DCode agent", async () => {
    const { deps, calls } = createDeps();

    await expect(
      handleSandboxState({
        ...baseOptions(deps),
        agent: { name: "hermes" },
        requestedObservabilityEnabled: true,
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      "  --observability is supported only with --agent langchain-deepagents-code.",
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("preserves recorded observability when a new onboard run omits the flag", async () => {
    const session = createSession({ observabilityEnabled: false });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      sandboxName: "saved",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
      observabilityEnabled: true,
    });
    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(false);
  });

  it.each(["openclaw", "hermes"])(
    "requires an explicit observability disable when switching DCode to %s",
    async (agentName) => {
      const session = createSession({
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
      });
      const { deps, calls } = createDeps({
        getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
        updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
          return mutator(session) ?? session;
        }),
      });

      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          agent: { name: agentName },
          sandboxName: "saved",
        }),
      ).rejects.toThrow("exit 1");

      expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("--no-observability"));
      expect(calls.createSandbox).not.toHaveBeenCalled();
      expect(session.observabilityEnabled).toBe(true);
    },
  );

  it("requires an explicit disable when resumed session state has observability enabled", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
    });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, false),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        agent: { name: "hermes" },
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("--no-observability"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("clears DCode observability during an explicitly acknowledged agent switch", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
    });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "hermes" },
      sandboxName: "saved",
      requestedObservabilityEnabled: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
      observabilityEnabled: false,
      observabilityRequestedExplicitly: true,
    });
    expect(session.observabilityEnabled).toBe(false);
    expect(session.observabilityRequestedExplicitly).toBe(true);
  });

  it("records an explicit request even when its enabled value already matches", async () => {
    const session = createSession({ observabilityEnabled: true });
    const updateSession = vi.fn((mutator: (value: Session) => Session | void) => {
      return mutator(session) ?? session;
    });
    const { deps } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      sandboxName: "saved",
      requestedObservabilityEnabled: true,
    });

    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(true);
    expect(updateSession).toHaveBeenCalled();
  });

  it.each([
    { recorded: true, requested: false },
    { recorded: false, requested: true },
  ])(
    "gives current explicit observability=$requested precedence on resume",
    async ({ recorded, requested }) => {
      const session = createSession({
        sandboxName: "saved",
        observabilityEnabled: recorded,
        observabilityRequestedExplicitly: true,
      });
      session.steps.sandbox.status = "complete";
      const { deps, calls } = createDeps({
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, recorded),
        updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
          return mutator(session) ?? session;
        }),
      });

      await handleSandboxState({
        ...baseOptions(deps, session),
        agent: { name: "langchain-deepagents-code" },
        resume: true,
        sandboxName: "saved",
        requestedObservabilityEnabled: requested,
      });

      expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
        recreate: true,
        observabilityEnabled: requested,
      });
      expect(calls.note).toHaveBeenCalledWith(
        "  [resume] Observability configuration changed; recreating sandbox.",
      );
      expect(session.observabilityEnabled).toBe(requested);
      expect(session.observabilityRequestedExplicitly).toBe(true);
    },
  );

  it.each([
    { recorded: false, requested: true },
    { recorded: true, requested: false },
  ])(
    "preserves interrupted explicit observability=$requested over registry=$recorded",
    async ({ recorded, requested }) => {
      const session = createSession({
        sandboxName: "saved",
        observabilityEnabled: requested,
        observabilityRequestedExplicitly: true,
      });
      session.steps.sandbox.status = "complete";
      const { deps, calls } = createDeps({
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, recorded),
        updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
          return mutator(session) ?? session;
        }),
      });

      await handleSandboxState({
        ...baseOptions(deps, session),
        agent: { name: "langchain-deepagents-code" },
        resume: true,
        sandboxName: "saved",
      });

      expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
        recreate: true,
        observabilityEnabled: requested,
      });
      expect(session.observabilityEnabled).toBe(requested);
      expect(session.observabilityRequestedExplicitly).toBe(true);
    },
  );

  it("does not treat an interrupted omitted request as an explicit disable", async () => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: false,
      observabilityRequestedExplicitly: false,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(false);
  });

  it("recreates a ready DCode sandbox before opting out from unknown legacy state", async () => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: false,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
      requestedObservabilityEnabled: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
      recreate: true,
      observabilityEnabled: false,
    });
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Observability configuration changed; recreating sandbox.",
    );
  });

  it("removes the conflicting Hermes nous-web gateway when Tavily is selected", async () => {
    const session = createSession();
    const { deps, calls } = createDeps(
      { selectedAgentSupportsWebSearchProvider: () => true },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "hermes", displayName: "Hermes" },
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      hermesToolGateways: ["nous-web", "nous-audio"],
    });

    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true, provider: "tavily" },
      [],
      null,
      { name: "hermes", displayName: "Hermes" },
      null,
      expect.anything(),
      null,
      ["nous-audio"],
      null,
      expect.objectContaining({ sessionId: expect.any(String), selection: expect.any(Object) }),
      {
        resolved: expect.any(Object),
        recreate: false,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        endpointSource: null,
        extraProviders: [],
      },
      undefined,
    );
    expect(result.hermesToolGateways).toEqual(["nous-audio"]);
    expect(calls.note).toHaveBeenCalledWith(
      "  Tavily Search replaces Hermes managed Web search/extract and removes the conflicting nous-web selection.",
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ hermesToolGateways: ["nous-audio"] }),
    );
  });

  it("uses an unknown receipt-backed package declaration for web-search conflicts", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    };
    const session = createSession({ agent: "future-harness", harnessPackage });
    const { deps, calls } = createDeps(
      {
        revalidateHarnessPackageAuthority: () => ({
          harnessPackage,
          harnessPackageMigration: null,
        }),
      },
      session,
    );
    const agent = {
      name: "future-harness",
      displayName: "Future Harness",
      web_search: {
        support: "providers" as const,
        providers: [testWebSearchBinding("tavily")],
        tool_gateway_conflicts: [{ provider: "tavily" as const, tool_gateway: "future-search" }],
      },
    };

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      agent,
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      toolGatewaySelections: ["future-search", "future-audio"],
      hermesToolGateways: [],
    });

    expect(result.toolGatewaySelections).toEqual(["future-audio"]);
    expect(result.hermesToolGateways).toEqual([]);
    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true, provider: "tavily" },
      [],
      null,
      agent,
      null,
      expect.anything(),
      null,
      ["future-audio"],
      null,
      expect.objectContaining({ sessionId: session.sessionId, selection: expect.any(Object) }),
      expect.objectContaining({ resolved: expect.any(Object) }),
      undefined,
    );
    expect(calls.note).not.toHaveBeenCalledWith(expect.stringContaining("Hermes"));
  });

  it("does not apply Hermes web-search rules to a receipt-backed package with that ID", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "1.0.0",
      contentDigest: "b".repeat(64),
    };
    const session = createSession({ agent: "hermes", harnessPackage });
    const { deps } = createDeps(
      {
        revalidateHarnessPackageAuthority: () => ({
          harnessPackage,
          harnessPackageMigration: null,
        }),
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      agent: {
        name: "hermes",
        web_search: { support: "providers", providers: [testWebSearchBinding("brave")] },
      },
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      toolGatewaySelections: ["nous-web"],
      hermesToolGateways: [],
    });

    expect(result.webSearchConfig).toEqual({ fetchEnabled: true, provider: "brave" });
    expect(result.toolGatewaySelections).toEqual(["nous-web"]);
    expect(result.hermesToolGateways).toEqual([]);
  });

  it("reuses a Ready sandbox from the registry without reading an invalid environment plan", async () => {
    const registryPlan = makeMinimalPlan("saved", "openclaw", ["telegram"]);
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const skippedSession = createSession({ sandboxName: "saved-after-skip" });
    const recordStateSkipped = vi.fn(async () => skippedSession);
    const readMessagingPlanFromEnv = vi.fn(() => {
      throw new Error("invalid environment plan");
    });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        pendingRouteReservation: true,
        reservationSessionId: session.sessionId,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
      readMessagingPlanFromEnv,
      recordStateSkipped,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(readMessagingPlanFromEnv).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.finalizeRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "saved",
      session.sessionId,
      { harnessPackage: null, harnessPackageMigration: null },
    );
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved", "reuse");
    expect(recordStateSkipped).toHaveBeenCalledWith("sandbox", {
      reason: "resume",
      sandboxName: "saved",
    });
    expect(result.selectedMessagingChannels).toEqual(["telegram"]);
    expect(result.webSearchConfigChanged).toBe(false);
    expect(result.session).toBe(skippedSession);
  });

  it("treats checkpoint machine-state progress past sandbox as step-complete even when the legacy step status is stale (#6228)", async () => {
    const session = createSession({
      sandboxName: "saved",
      machine: { version: 1, state: "agent_setup", stateEnteredAt: null, revision: 1 },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      harnessPackage: null,
      sessionId: session.sessionId,
      machineState: "agent_setup",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionUnset(),
      webSearch: decisionUnset(),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(session.steps.sandbox.status).not.toBe("complete");
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("does not let a stale legacy complete marker override a checkpoint still at sandbox (#7022)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      harnessPackage: null,
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionUnset(),
      webSearch: decisionUnset(),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("prefers the checkpointed web-search decision over a stale legacy completion flag (#7022)", async () => {
    const session = createSession({
      sandboxName: "saved",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      harnessPackage: null,
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing", updateSession });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[5]).toEqual({
      fetchEnabled: true,
      provider: "brave",
    });
  });

  it("prefers the checkpointed resource-profile decision over a stale legacy completion flag (#7022)", async () => {
    const session = createSession({
      sandboxName: "saved",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      harnessPackage: null,
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
      webSearch: decisionDeclined(),
      messaging: decisionDeclined(),
      resourceProfile: decisionSelected({ cpu: "4", memory: "8Gi" }),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing", updateSession });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[11]).toEqual({
      cpu: "4",
      memory: "8Gi",
    });
  });

  it("recreates a resumed Hermes sandbox when its compatible Anthropic frontend is stale", async () => {
    const session = createSession({
      agent: "hermes",
      sandboxName: "saved",
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: (name) => ({
          name,
          agent: "hermes",
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
          toolDisclosure: "progressive",
        }),
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      agent: { name: "hermes", displayName: "Hermes" },
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "openai-completions",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Inference route API configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "claude-sonnet-proxy",
      "compatible-anthropic-endpoint",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      { name: "hermes", displayName: "Hermes" },
      null,
      expect.anything(),
      null,
      [],
      null,
      expect.objectContaining({ sessionId: session.sessionId, selection: expect.any(Object) }),
      {
        resolved: expect.any(Object),
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        endpointSource: null,
        extraProviders: [],
      },
      undefined,
    );
  });

  it("backfills absent rebuild fidelity after validated sandbox reuse", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      hermesAuthMethod: "api_key",
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        selectedAgentSupportsWebSearchProvider: () => true,
        getSandboxRegistryEntry: (name) => ({
          name,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          nemoclawVersion: "0.1.0",
          toolDisclosure: "progressive",
        }),
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      hermesAuthMethod: "api_key",
    });

    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      webSearchEnabled: true,
      webSearchProvider: "brave",
      fromDockerfile: null,
      hermesAuthMethod: "api_key",
    });
  });

  it("marks web search changed when recreate implicitly enables Tavily", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps } = createDeps(
      {
        getSandboxReuseState: () => "not_ready",
        getSandboxRecreateObservation: journal.observe,
        configureWebSearch: vi.fn(async () => ({
          fetchEnabled: true as const,
          provider: "tavily" as const,
        })),
        createSandbox: journal.completeCreate,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(result.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(result.webSearchConfigChanged).toBe(true);
  });

  it("recreates when a saved web search sandbox is no longer supported", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps, calls } = createDeps(
      {
        agentSupportsWebSearch: () => false,
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        createSandbox: journal.completeCreate,
        updateSession: vi.fn(
          (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
        ),
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  Brave Search is not yet supported by this sandbox image. Clearing stale config.",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.note).not.toHaveBeenCalledWith(
      "  [resume] Reusing web search selection: disabled.",
    );
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it("recreates when an explicit web-search provider differs from saved state", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        createSandbox: journal.completeCreate,
        selectedAgentSupportsWebSearchProvider: () => true,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.validateBrave).toHaveBeenCalledWith({
      fetchEnabled: true,
      provider: "tavily",
    });
    expect(journal.completeCreate).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "saved",
      { fetchEnabled: true, provider: "tavily" },
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
      null,
      expect.objectContaining({ sessionId: session.sessionId, selection: expect.any(Object) }),
      expect.objectContaining({
        resolved: expect.any(Object),
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        endpointSource: null,
        extraProviders: [],
        reuseRegisteredCredentials: true,
        recreateTransaction: expect.objectContaining({
          id: expect.any(String),
          targetGeneration: expect.any(String),
          targetIntentFingerprint: expect.any(String),
        }),
      }),
      undefined,
    );
    expect(result.webSearchConfigChanged).toBe(true);
  });

  it("keeps registry state intact when replacement provider validation fails", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      selectedAgentSupportsWebSearchProvider: () => true,
      ensureValidatedWebSearchCredential: vi.fn(async () => {
        throw new Error("Tavily credential rejected");
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
        env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
      }),
    ).rejects.toThrow("Tavily credential rejected");

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("fails before credential or registry mutation when Tavily collides with managed MCP", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      selectedAgentSupportsWebSearchProvider: () => true,
      getSandboxRegistryEntry: (name: string) => ({
        name,
        mcp: {
          bridges: {
            search: {
              server: "search",
              agent: "openclaw",
              url: "https://mcp.example.com/mcp",
              env: ["TAVILY_API_KEY"],
              policyName: "saved-mcp-search",
              addedAt: "2026-07-03T00:00:00.000Z",
            },
          },
        },
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
        env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("already owns TAVILY_API_KEY"),
    );
    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("drops saved web search config when credential revalidation returns to provider selection", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });
    session.steps.sandbox.status = "complete";
    const backToSelection = Object.freeze({ kind: "NEMOCLAW_BACK_TO_SELECTION" });
    const journal = bindJournaledRecreate(session);
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "not_ready",
        getSandboxRecreateObservation: journal.observe,
        createSandbox: journal.completeCreate,
        selectedAgentSupportsWebSearchProvider: () => true,
        ensureValidatedWebSearchCredential: vi.fn(async () => backToSelection),
        isBackToSelection: vi.fn((value: unknown) => value === backToSelection),
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(journal.completeCreate).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
      null,
      expect.objectContaining({ sessionId: session.sessionId, selection: expect.any(Object) }),
      expect.objectContaining({
        resolved: expect.any(Object),
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        endpointSource: null,
        extraProviders: [],
        reuseRegisteredCredentials: true,
        recreateTransaction: expect.objectContaining({
          id: expect.any(String),
          targetGeneration: expect.any(String),
          targetIntentFingerprint: expect.any(String),
        }),
      }),
      undefined,
    );
    expect(result.webSearchConfig).toBeNull();
  });

  it("uses recorded messaging channels on non-interactive resume", async () => {
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["discord"]);
    const { deps, calls } = createDeps({ getRecordedMessagingChannelsForResume });

    const result = await handleSandboxState({ ...baseOptions(deps), resume: true });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(getRecordedMessagingChannelsForResume).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      "my-assistant",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [non-interactive] Reusing messaging channel configuration: discord",
    );
    expect(result.selectedMessagingChannels).toEqual(["discord"]);
  });

  it("persists plan from env into session after fresh messaging setup", async () => {
    const mockPlan = makeMinimalPlan("my-assistant");
    const { deps, getSession } = createDeps({
      readMessagingPlanFromEnv: () => mockPlan,
    });

    await handleSandboxState({ ...baseOptions(deps) });

    expect(getSession().messagingPlan).toEqual(mockPlan);
  });

  it("restores registry plan to env on non-interactive resume when env is empty", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
  });

  it("uses the registry plan without reading an invalid environment plan during sandbox creation", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const readMessagingPlanFromEnv = vi.fn(() => {
      throw new Error("invalid environment plan");
    });
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(readMessagingPlanFromEnv).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
    expect(getSession().messagingPlan).toEqual(registryPlan);
  });

  it("validates changed credentials before refreshing an env-staged rebuild plan", async () => {
    const oldHash = hashCredential("telegram-token-a");
    const newHash = hashCredential("telegram-token-b");
    const rebuiltPlan = withTelegramCredentialHash(
      makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      oldHash,
    );
    const validatedPlan = withTelegramCredentialHash(rebuiltPlan, newHash);
    let stagedPlan = rebuiltPlan;
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: rebuiltPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => stagedPlan,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
    });
    calls.setupMessaging.mockImplementation(async () => {
      stagedPlan = validatedPlan;
      return ["telegram"];
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      env: { TELEGRAM_BOT_TOKEN: "telegram-token-b" },
    });

    expect(calls.setupMessaging).toHaveBeenCalledOnce();
    expect(writePlanToEnv).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentialBindings: [
          expect.objectContaining({
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: newHash,
          }),
        ],
      }),
    );
    expect(getSession().messagingPlan?.credentialBindings[0]?.credentialHash).toBe(newHash);
  });

  it("validates changed credentials before refreshing a registry rebuild plan", async () => {
    const oldHash = hashCredential("telegram-token-a");
    const newHash = hashCredential("telegram-token-b");
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      oldHash,
    );
    const validatedPlan = withTelegramCredentialHash(registryPlan, newHash);
    let stagedPlan = registryPlan;
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => stagedPlan,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });
    calls.setupMessaging.mockImplementation(async () => {
      stagedPlan = validatedPlan;
      return ["telegram"];
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      env: { TELEGRAM_BOT_TOKEN: "telegram-token-b" },
    });

    expect(calls.setupMessaging).toHaveBeenCalledOnce();
    expect(writePlanToEnv).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentialBindings: [
          expect.objectContaining({
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: newHash,
          }),
        ],
      }),
    );
    expect(getSession().messagingPlan?.credentialBindings[0]?.credentialHash).toBe(newHash);
  });

  it("preserves an empty env-staged rebuild plan instead of rediscovering token-backed channels", async () => {
    const emptyRebuildPlan = makeMinimalPlan("my-assistant");
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: emptyRebuildPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => null);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => emptyRebuildPlan,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: emptyRebuildPlan }),
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(writePlanToEnv).toHaveBeenCalledWith(emptyRebuildPlan);
    expect(result.selectedMessagingChannels).toEqual([]);
    const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
    expect(createSandboxCall[6]).toEqual([]);
    expect(getSession().messagingPlan).toEqual(emptyRebuildPlan);
  });
});
