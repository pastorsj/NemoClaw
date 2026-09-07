// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import type { HarnessPackageIdentity } from "../../../agent-runtime/package/identity";
import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import {
  beginSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
} from "../../sandbox-recreate-transaction";
import { handleSandboxState } from "./sandbox";
import { baseOptions, bindJournaledRecreate, createDeps } from "./sandbox-test-fixtures";

const DRIFTED_PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "9.9.9",
  contentDigest: "d".repeat(64),
};

const SOURCE_ENTRY: SandboxEntry = {
  name: "saved",
  agent: "openclaw",
  provider: "provider",
  model: "model",
  endpointUrl: null,
  preferredInferenceApi: "openai-completions",
  webSearchEnabled: false,
  toolDisclosure: "progressive",
  fromDockerfile: null,
  hermesAuthMethod: null,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("rejects package authority drift before the journal-open mutation", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  const journal = bindJournaledRecreate(session);
  const createSandbox = vi.fn(journal.completeCreate);
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: () => {
        // Change authority after the compare-and-swap predicate captured its
        // opening identity but before that write builds the next checkpoint.
        session.harnessPackage = DRIFTED_PACKAGE;
        return journal.observe();
      },
      getSandboxRegistryEntry: () => SOURCE_ENTRY,
      createSandbox,
    },
    session,
  );

  await expect(
    handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    }),
  ).rejects.toThrow(/package authority/u);

  expect(createSandbox).not.toHaveBeenCalled();
  expect(calls.removeSandbox).not.toHaveBeenCalled();
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it("rejects replacement package drift immediately before clearing the handler journal", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  const journal = bindJournaledRecreate(session);
  let replacementCreated = false;
  const createSandbox = vi.fn(async (...args: unknown[]) => {
    const name = await journal.completeCreate(...args);
    replacementCreated = true;
    return name;
  });
  const { deps } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: journal.observe,
      getSandboxRegistryEntry: () =>
        replacementCreated ? { ...SOURCE_ENTRY, harnessPackage: DRIFTED_PACKAGE } : SOURCE_ENTRY,
      createSandbox,
    },
    session,
  );

  await expect(
    handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    }),
  ).rejects.toThrow("Registry package authority does not match its onboarding Session");

  expect(createSandbox).toHaveBeenCalledOnce();
  expect(session.checkpoint?.sandboxRecreate?.phase).toBe("registry_committing");
});

it("preserves the hashed target fingerprint of a package-migrated v1 handler journal", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  const journal = bindJournaledRecreate(session);
  let legacyTargetIntentFingerprint: string | null = null;
  const resolveSandboxCreateIntent = vi.fn(
    async (input: {
      sandboxName: string;
      inferenceProvider?: string | null;
      extraProviders: readonly string[];
      staleExtraProviders: readonly string[];
    }) => {
      const resolved = {
        sandboxName: input.sandboxName,
        inferenceProvider: input.inferenceProvider ?? null,
        activeMessagingChannels: [],
        messagingProviderRequests: [],
        reusableMessagingProviders: [],
        extraProviders: [...input.extraProviders],
        staleExtraProviders: [...input.staleExtraProviders],
        hermesToolGateways: [],
        policy: {
          basePolicyPath: "/repo/policy.yaml",
          activeMessagingChannels: [],
          options: {
            directGpu: false,
            additionalPresets: [],
            policyTier: null,
          },
        },
        gpuCreateArgs: [],
        resourceCreateArgs: [],
        gpuRoutePlan: "none" as const,
        sandboxGpuLogMessage: null,
        disabledChannelNames: [],
        extraPlaceholderKeys: [],
      };
      const {
        extraProviders: _extraProviders,
        staleExtraProviders: _staleExtraProviders,
        policy: _policy,
        ...durableCreateIntent
      } = resolved;
      const lightFingerprint = [
        "saved",
        "provider",
        "model",
        "openai-completions",
        "",
        JSON.stringify({ sandboxGpuEnabled: false, mode: "0" }),
        "",
      ].join("|");
      legacyTargetIntentFingerprint = fingerprintSandboxRecreateValue(
        `${lightFingerprint}|${JSON.stringify(durableCreateIntent)}`,
      );
      beginSandboxRecreateTransaction(session, {
        sandboxName: "saved",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        sourceEntry: SOURCE_ENTRY,
        observation: journal.observe(),
        targetIntentFingerprint: legacyTargetIntentFingerprint,
      });
      return resolved;
    },
  );
  const { deps } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: journal.observe,
      getSandboxRegistryEntry: () => SOURCE_ENTRY,
      resolveSandboxCreateIntent,
      createSandbox: journal.completeCreate,
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
  });

  expect(resolveSandboxCreateIntent).toHaveBeenCalledOnce();
  expect(legacyTargetIntentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect((journal.completeCreate.mock.calls[0] as unknown[] | undefined)?.[15]).toMatchObject({
    recreateTransaction: {
      targetIntentFingerprint: legacyTargetIntentFingerprint,
    },
  });
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});
