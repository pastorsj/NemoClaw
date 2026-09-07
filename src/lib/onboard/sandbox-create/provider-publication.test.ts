// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import {
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
} from "./provider-publication";

const providerName = "my-assistant-telegram-bridge";
const target = { kind: "named", gatewayName: "nemoclaw" } as const;
const exactMetadata = {
  id: "provider-id-1",
  name: providerName,
  type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  credentialKeys: ["TELEGRAM_BOT_TOKEN"],
  configKeys: [],
} as const;

const FINAL_MESSAGING_PROVIDER_MISMATCHES = [
  {
    name: "custom static wrong type",
    exactValue: {
      ...exactMetadata,
      type: "discord-hermes-static-v1",
      credentialKeys: ["DISCORD_BOT_TOKEN"],
    },
    mismatchedValue: {
      ...exactMetadata,
      type: "generic",
      credentialKeys: ["DISCORD_BOT_TOKEN"],
    },
    credentialShape: "only",
    credentialKeys: ["DISCORD_BOT_TOKEN"],
  },
  {
    name: "custom static extra credential",
    exactValue: {
      ...exactMetadata,
      type: "discord-hermes-static-v1",
      credentialKeys: ["DISCORD_BOT_TOKEN"],
    },
    mismatchedValue: {
      ...exactMetadata,
      type: "discord-hermes-static-v1",
      credentialKeys: ["DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN_EXTRA"],
    },
    credentialShape: "only",
    credentialKeys: ["DISCORD_BOT_TOKEN"],
  },
  {
    name: "refresh family collision",
    exactValue: {
      ...exactMetadata,
      type: "google-chat-openclaw-v1",
      credentialKeys: ["GOOGLE_CHAT_ACCESS_TOKEN"],
    },
    mismatchedValue: {
      ...exactMetadata,
      type: "google-chat-openclaw-v1",
      credentialKeys: ["GOOGLE_CHAT_ACCESS_TOKEN", "UNRELATED_TOKEN"],
    },
    credentialShape: "family",
    credentialKeys: ["GOOGLE_CHAT_ACCESS_TOKEN"],
  },
] as const;

const FINAL_MESSAGING_PROVIDER_SEAMS = FINAL_MESSAGING_PROVIDER_MISMATCHES.flatMap((testCase) => [
  { ...testCase, phase: "before" as const },
  { ...testCase, phase: "after" as const },
]);

function typedProviderAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const adapter: OpenShellProviderAdapter = {
    listProviders: vi.fn(async () => ({ ok: true as const, value: { names: [] } })),
    createProvider: vi.fn(async () => ({ ok: true as const })),
    getProvider: vi.fn(async (request) => ({
      ok: true as const,
      value: { ...exactMetadata, name: request.providerName },
    })),
    updateProvider: vi.fn(async () => ({ ok: true as const })),
    importProviderProfile: vi.fn(async () => ({ ok: true as const })),
    inspectProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: [] },
    })),
    deleteProvider: vi.fn(async () => ({ ok: true as const })),
    detachProvider: vi.fn(async () => ({ ok: true as const })),
    attachProvider: vi.fn(async () => ({ ok: true as const })),
    configureProviderRefresh: vi.fn(async () => ({ ok: true as const })),
    getProviderRefreshStatus: vi.fn(async () => ({
      ok: true as const,
      value: { status: "refreshed" },
    })),
  };
  return { ...adapter, ...overrides };
}

function publicationInput(
  overrides: Partial<
    Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0]
  > = {},
): Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0] {
  return {
    openshellDriver: "docker",
    inferenceProvider: null,
    messagingProviders: [providerName],
    messagingProviderRequests: [
      {
        name: providerName,
        envKey: "TELEGRAM_BOT_TOKEN",
        providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialShape: "only",
        credentialKeys: ["TELEGRAM_BOT_TOKEN"],
        credentialConfigured: false,
        channel: "telegram",
      },
    ],
    extraProviders: [],
    gatewayName: "nemoclaw",
    ...overrides,
  };
}

function createHarness(adapter = typedProviderAdapter(), cleanupCreateSources = vi.fn()) {
  const runOpenshell = vi.fn(() => {
    throw new Error("Raw provider commands must stay behind OpenShellProviderAdapter.");
  });
  return {
    adapter,
    cleanupCreateSources,
    runOpenshell,
    deps: {
      cleanupCreateSources,
      providerAdapter: adapter,
      runOpenshell: runOpenshell as never,
    },
  };
}

async function prepareProviders(
  input: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0],
  deps: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[1],
): Promise<void> {
  await validateAttachedMessagingProvidersBeforeSandboxCreation(input, deps);
  await publishAttachedProvidersBeforeDockerSandboxCreation(input, deps);
}

describe("sandbox provider preparation", () => {
  it("prepares and verifies a messaging provider through exact adapter calls (#9806)", async () => {
    const harness = createHarness();

    await prepareProviders(publicationInput(), harness.deps);

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(1, {
      target,
      providerName,
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(3, {
      target,
      providerName,
    });
    expect(harness.adapter.createProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("rejects extra namespaced credentials on a static messaging provider (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        ...exactMetadata,
        name: request.providerName,
        credentialKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects an ambient endpoint before a named messaging profile operation (#9806)", async () => {
    const cleanupCreateSources = vi.fn();
    const runOpenshell = vi.fn();

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), {
        cleanupCreateSources,
        environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://untrusted.example.test" },
        runOpenshell: runOpenshell as never,
      }),
    ).rejects.toThrowError(
      "OPENSHELL_GATEWAY_ENDPOINT is set, so OpenShell may bypass the gateway recorded for this sandbox.",
    );

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("surfaces a safe profile preparation failure before provider lookup (#9806)", async () => {
    const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = vi.fn(
      async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "profile import rejected request 17",
        },
      }),
    );
    const harness = createHarness(typedProviderAdapter({ importProviderProfile }));

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(
      "Could not prepare the OpenShell messaging credential profile: profile import rejected request 17",
    );
    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider type", { ...exactMetadata, type: "generic" }],
    ["credential key", { ...exactMetadata, credentialKeys: ["WRONG_TOKEN"] }],
    [
      "credential family",
      {
        ...exactMetadata,
        credentialKeys: ["TELEGRAM_BOT_TOKEN", "UNRELATED_TOKEN"],
      },
    ],
    ["configuration", { ...exactMetadata, configKeys: ["UNEXPECTED_CONFIG"] }],
  ])(
    "rejects a messaging binding with the wrong %s before publication (#9875)",
    async (_case, value) => {
      const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
        ok: true as const,
        value,
      }));
      const harness = createHarness(typedProviderAdapter({ getProvider }));

      await expect(
        validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
      ).rejects.toThrowError(
        `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
      );
      expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
        target,
        providerName,
      });
      expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
      expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    },
  );

  it.each(FINAL_MESSAGING_PROVIDER_SEAMS)(
    "rejects a $name $phase final messaging-provider seam",
    async ({ exactValue, mismatchedValue, credentialShape, credentialKeys, phase }) => {
      const request = {
        name: providerName,
        envKey: credentialKeys[0],
        providerType: exactValue.type,
        credentialShape,
        credentialKeys,
        credentialConfigured: true,
        channel: "telegram",
      } as const;
      const input = publicationInput({ messagingProviderRequests: [request] });

      const getProvider: OpenShellProviderAdapter["getProvider"] =
        phase === "before"
          ? vi.fn(async () => ({ ok: true as const, value: mismatchedValue }))
          : vi
              .fn()
              .mockResolvedValueOnce({ ok: true as const, value: exactValue })
              .mockResolvedValueOnce({ ok: true as const, value: exactValue })
              .mockResolvedValueOnce({ ok: true as const, value: mismatchedValue });
      const harness = createHarness(typedProviderAdapter({ getProvider }));
      const operation =
        phase === "before"
          ? validateAttachedMessagingProvidersBeforeSandboxCreation(input, harness.deps)
          : prepareProviders(input, harness.deps);

      await expect(operation).rejects.toThrowError(
        `OpenShell did not confirm messaging provider '${providerName}' ${
          phase === "before" ? "before sandbox creation" : "after publication"
        }.`,
      );
      expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    },
  );

  it("keeps identity mismatch distinct during messaging provider inspection (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "transport" as const,
        reason: "identity_mismatch" as const,
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(
      `Could not inspect messaging provider '${providerName}' before sandbox creation: The selected OpenShell gateway identity does not match the recorded identity.`,
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({ target, providerName });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("publishes an existing inference provider through exact adapter calls (#9806)", async () => {
    const harness = createHarness();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("skips optional publication only when exact lookup reports absence (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "not_found" as const,
        message: "OpenShell provider 'inference' was not found.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("surfaces a safe optional lookup failure without updating (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "transport" as const,
        reason: "unreachable" as const,
        message: "OpenShell could not reach gateway 'nemoclaw'.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(
        publicationInput({
          inferenceProvider: "inference",
          messagingProviders: [],
          messagingProviderRequests: [],
        }),
        harness.deps,
      ),
    ).rejects.toThrowError(
      "Could not inspect attached provider 'inference' before publication: OpenShell could not reach gateway 'nemoclaw'.",
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("surfaces a safe update failure after the exact lookup (#9806)", async () => {
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "provider update rejected request 23",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ updateProvider }));

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(
        publicationInput({
          inferenceProvider: "inference",
          messagingProviders: [],
          messagingProviderRequests: [],
        }),
        harness.deps,
      ),
    ).rejects.toThrowError(
      "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 23",
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("reports provider and temporary-source cleanup failures together (#9806)", async () => {
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "provider update rejected request 25",
      },
    }));
    const cleanupFailure = new AggregateError(
      [new Error("The temporary sandbox build context could not be removed.")],
      "Temporary sandbox create sources remain.",
    );
    const cleanupCreateSources = vi.fn(() => {
      throw cleanupFailure;
    });
    const harness = createHarness(typedProviderAdapter({ updateProvider }), cleanupCreateSources);

    const failure = await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message:
        "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 25 Temporary sandbox create-source cleanup also failed.",
    });
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message:
          "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 25",
      }),
      cleanupFailure,
    ]);
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(cleanupCreateSources).toHaveBeenCalledOnce();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("reruns publication from desired state after a partial failure (#9806)", async () => {
    let updateAttempt = 0;
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () =>
      (updateAttempt += 1) === 2
        ? {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "failed" as const,
              message: "provider update rejected request 24",
            },
          }
        : { ok: true as const },
    );
    const harness = createHarness(typedProviderAdapter({ updateProvider }));
    const input = publicationInput({
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: ["first-provider", "second-provider"],
    });

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(input, harness.deps),
    ).rejects.toThrowError(/provider update rejected request 24/u);
    expect(harness.adapter.updateProvider).toHaveBeenCalledTimes(2);
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "first-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "second-provider",
      credentials: [],
      config: [],
    });

    vi.mocked(harness.adapter.updateProvider).mockClear();
    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(input, harness.deps),
    ).resolves.toEqual(new Map());

    expect(harness.adapter.updateProvider).toHaveBeenCalledTimes(2);
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "first-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "second-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects a messaging binding that changes during publication (#9875)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: exactMetadata })
      .mockResolvedValueOnce({ ok: true as const, value: exactMetadata })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { ...exactMetadata, type: "generic" },
      });
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(prepareProviders(publicationInput(), harness.deps)).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' after publication.`,
    );
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(1, { target, providerName });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(3, { target, providerName });
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects an extra static credential introduced during publication", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: exactMetadata })
      .mockResolvedValueOnce({ ok: true as const, value: exactMetadata })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          ...exactMetadata,
          credentialKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
        },
      });
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(prepareProviders(publicationInput(), harness.deps)).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' after publication.`,
    );
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
      credentials: [],
      config: [],
    });
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("publishes a provider outside the messaging credential profile without a lookup (#9875)", async () => {
    const harness = createHarness();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["operator-provider"],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "operator-provider",
      credentials: [],
      config: [],
    });
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("validates the messaging profile before portable Hermes provider adoption (#9875)", async () => {
    const harness = createHarness();

    await validateAttachedMessagingProvidersBeforeSandboxCreation(
      publicationInput({ openshellDriver: "native" }),
      harness.deps,
    );

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({ target, providerName });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });
});
