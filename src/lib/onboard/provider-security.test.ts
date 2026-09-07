// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

type RunResult = {
  error?: unknown;
  output?: string;
  signal?: unknown;
  status: number;
  stdout?: string;
  stderr?: string;
};

type RunOptions = {
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  maxBuffer?: number;
  stdio?: readonly unknown[];
  suppressOutput?: boolean;
  timeout?: number;
};

type RunOpenshell = (command: string[], options?: RunOptions) => RunResult;

type ProviderDefinition = {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
  expectedProviderId?: string;
};

type ProviderMutationReceipt = {
  readonly createdProviderNames: readonly string[];
  readonly mutatedProviderNames: readonly string[];
  readonly providerNames: readonly string[];
  readonly providerIds: Readonly<Record<string, string>>;
};

const messagingBridgeProvider =
  require("./messaging-bridge-provider") as typeof import("./messaging-bridge-provider");

const { upsertMessagingProviders, upsertProvider } = require("./providers") as {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: RunOpenshell,
    options?: {
      knownExists?: boolean;
      allowedSandboxes?: readonly string[];
      expectedProviderId?: string;
    },
  ) => { ok: boolean; status?: number; message?: string; reason?: string };
  upsertMessagingProviders: (
    tokenDefinitions: ProviderDefinition[],
    runOpenshell: RunOpenshell,
    options?: {
      bestEffort?: boolean;
      deferCreatedProviderCleanup?: boolean;
      requireExactBindings?: boolean;
      requireExistingProvider?: boolean;
      recordMutationReceipt?(receipt: ProviderMutationReceipt): void;
    },
  ) => string[];
};

const DISCORD_STATIC_PROFILE_EXPORT = JSON.stringify({
  id: "discord-hermes-static-v1",
  credentials: [
    {
      name: "bot_token",
      env_vars: ["DISCORD_BOT_TOKEN"],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

const SUCCESS = { status: 0, stdout: "", stderr: "" } as const;

function sandboxRows(...names: string[]): string {
  return JSON.stringify(
    names.map((name, index) => ({
      id: `sandbox-id-${index}`,
      name,
      labels: {},
      resource_version: 1,
      created_at: "2026-09-07T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    })),
  );
}

describe("provider mutation security", () => {
  it("refuses to update a receipt-owned provider attached to a foreign sandbox", () => {
    const commands: string[] = [];
    const metadata = [
      "Id: provider-id-a",
      "Name: shared-provider",
      "Type: generic",
      "Credential keys: SHARED_TOKEN",
      "Config keys: <none>",
      "",
    ].join("\n");
    const attachmentTable = [
      "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
      "shared-provider generic 1 0",
    ].join("\n");
    const exactResponses = new Map<string, RunResult>([
      ["provider get shared-provider", { status: 0, stdout: metadata, stderr: "" }],
      ["sandbox list -o json", { status: 0, stdout: sandboxRows("target", "foreign"), stderr: "" }],
    ]);
    const result = upsertProvider(
      "shared-provider",
      "generic",
      "SHARED_TOKEN",
      null,
      { SHARED_TOKEN: "new-secret" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        return (
          exactResponses.get(normalized) ??
          (normalized.startsWith("sandbox provider list ")
            ? { status: 0, stdout: attachmentTable, stderr: "" }
            : SUCCESS)
        );
      },
      {
        knownExists: true,
        expectedProviderId: "provider-id-a",
        allowedSandboxes: ["target"],
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "binding-conflict" });
    expect(result).toHaveProperty("message", expect.stringContaining("authorized sandbox set"));
    expect(
      commands.filter((command) => /^provider (?:create|update|refresh)\b/u.test(command)),
    ).toEqual([]);
  });

  it("rechecks receipt-owned provider attachments immediately before credential update", () => {
    const commands: string[] = [];
    let sandboxListCalls = 0;
    const metadata = [
      "Id: provider-id-a",
      "Name: shared-provider",
      "Type: generic",
      "Credential keys: SHARED_TOKEN",
      "Config keys: <none>",
      "",
    ].join("\n");
    const attachmentTable = [
      "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
      "shared-provider generic 1 0",
    ].join("\n");
    const responseByCommand: Record<string, () => RunResult> = {
      "provider get shared-provider": () => ({ status: 0, stdout: metadata, stderr: "" }),
      "sandbox list -o json": () => ({
        status: 0,
        stdout: ++sandboxListCalls === 1 ? sandboxRows("target") : sandboxRows("target", "foreign"),
        stderr: "",
      }),
    };
    const result = upsertProvider(
      "shared-provider",
      "generic",
      "SHARED_TOKEN",
      null,
      { SHARED_TOKEN: "new-secret" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        return (
          responseByCommand[normalized] ??
          (() =>
            normalized.startsWith("sandbox provider list ")
              ? { status: 0, stdout: attachmentTable, stderr: "" }
              : SUCCESS)
        )();
      },
      {
        knownExists: true,
        expectedProviderId: "provider-id-a",
        allowedSandboxes: ["target"],
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "binding-conflict" });
    expect(sandboxListCalls).toBe(2);
    expect(
      commands.filter((command) => /^provider (?:create|update|refresh)\b/u.test(command)),
    ).toEqual([]);
  });

  it("does not recreate a missing receipt-owned provider or configure refresh", () => {
    const configureRefreshes = vi.spyOn(
      messagingBridgeProvider,
      "configureMessagingBridgeRefreshes",
    );
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "missing-provider",
            envKey: "MISSING_TOKEN",
            token: "replacement-secret",
            expectedProviderId: "provider-id-a",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return { status: 1, stdout: "", stderr: "provider not found" };
        },
        { bestEffort: true, requireExistingProvider: true },
      ),
    ).toThrow(/missing; refusing to create a replacement identity/u);

    expect(commands).toEqual(["provider get missing-provider"]);
    expect(
      commands.filter((command) => /^provider (?:create|update|refresh)\b/u.test(command)),
    ).toEqual([]);
    expect(configureRefreshes).not.toHaveBeenCalled();
    configureRefreshes.mockRestore();
  });

  it("bounds provider mutations and removes exact credentials and terminal controls from failures", () => {
    const credential = "opaque-value-without-a-known-token-pattern";
    let mutationOptions: RunOptions | undefined;
    const mutationFailure = (options: RunOptions | undefined): RunResult => {
      mutationOptions = options;
      return {
        status: 1,
        stdout: "",
        stderr: `rejected ${credential}\u001b]52;c;clipboard-payload\u0007\u0000`,
      };
    };
    const result = upsertProvider(
      "bad-provider",
      "generic",
      "SOME_KEY",
      null,
      { SOME_KEY: credential },
      (command, options) =>
        command.includes("get") ? { status: 1, stdout: "", stderr: "" } : mutationFailure(options),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("rejected <REDACTED>");
    expect(result.message).not.toContain(credential);
    expect(result.message).not.toContain("clipboard-payload");
    expect(result.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    expect(mutationOptions).toMatchObject({
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
  });

  it("reports an attempted exact provider create when the transport fails after acceptance", () => {
    let created = false;
    const providerName = "alpha-discord-bridge";
    const exactProvider = {
      status: 0,
      stdout: [
        `Name: ${providerName}`,
        "Type: discord-hermes-static-v1",
        "Credential keys: DISCORD_BOT_TOKEN",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };
    const handlers: Record<string, () => RunResult> = {
      profile: () => ({ status: 0, stdout: DISCORD_STATIC_PROFILE_EXPORT, stderr: "" }),
      get: () =>
        created
          ? exactProvider
          : { status: 1, stdout: "", stderr: `provider '${providerName}' not found` },
      create: () => {
        created = true;
        throw new Error("transport closed after create");
      },
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: providerName,
            envKey: "DISCORD_BOT_TOKEN",
            token: "discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => (handlers[command[1] ?? ""] ?? (() => SUCCESS))(),
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_MUTATION_FAILURE",
        createdProviderNames: [],
        mutatedProviderNames: [providerName],
        providerIds: {},
      }),
    );
  });

  it("reports an attempted exact provider update without classifying it as created", () => {
    const providerName = "alpha-discord-bridge";
    const exactProvider = {
      status: 0,
      stdout: [
        `Name: ${providerName}`,
        "Type: discord-hermes-static-v1",
        "Credential keys: DISCORD_BOT_TOKEN",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };
    const handlers: Record<string, () => RunResult> = {
      profile: () => ({ status: 0, stdout: DISCORD_STATIC_PROFILE_EXPORT, stderr: "" }),
      get: () => exactProvider,
      update: () => {
        throw new Error("transport closed after update");
      },
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: providerName,
            envKey: "DISCORD_BOT_TOKEN",
            token: "rotated-discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => (handlers[command[1] ?? ""] ?? (() => SUCCESS))(),
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_MUTATION_FAILURE",
        createdProviderNames: [],
        mutatedProviderNames: [providerName],
      }),
    );
  });

  it("rejects a static provider whose successful mutation has the wrong readback", () => {
    let created = false;
    const providerName = "alpha-discord-bridge";
    const mismatchedProvider = {
      status: 0,
      stdout: [
        `Name: ${providerName}`,
        "Type: generic",
        "Credential keys: DISCORD_BOT_TOKEN",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };
    const handlers: Record<string, () => RunResult> = {
      profile: () => ({ status: 0, stdout: DISCORD_STATIC_PROFILE_EXPORT, stderr: "" }),
      create: () => {
        created = true;
        return SUCCESS;
      },
      get: () =>
        created
          ? mismatchedProvider
          : { status: 1, stdout: "", stderr: `provider '${providerName}' not found` },
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: providerName,
            envKey: "DISCORD_BOT_TOKEN",
            token: "discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => (handlers[command[1] ?? ""] ?? (() => SUCCESS))(),
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        createdProviderNames: [providerName],
        mutatedProviderNames: [providerName],
        message: expect.stringContaining("did not confirm"),
      }),
    );
  });

  it("defers receipt-backed refresh cleanup to exact outer reconciliation", () => {
    const commands: string[] = [];
    let created = false;
    const providerName = "alpha-googlechat-bridge";
    const ensureProfiles = vi
      .spyOn(messagingBridgeProvider, "ensureMessagingBridgeProfiles")
      .mockImplementation(() => undefined);
    const configureRefreshes = vi
      .spyOn(messagingBridgeProvider, "configureMessagingBridgeRefreshes")
      .mockImplementation(() => {
        throw new Error("refresh transport failed");
      });
    const exactProvider = {
      status: 0,
      stdout: [
        `Name: ${providerName}`,
        "Type: google-chat-bridge",
        "Credential keys: GOOGLE_CHAT_ACCESS_TOKEN",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };
    const handlers: Record<string, () => RunResult> = {
      get: () =>
        created
          ? exactProvider
          : { status: 1, stdout: "", stderr: `provider '${providerName}' not found` },
      create: () => {
        created = true;
        return SUCCESS;
      },
    };
    try {
      expect(() =>
        upsertMessagingProviders(
          [
            {
              name: providerName,
              envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
              token: messagingBridgeProvider.MESSAGING_BRIDGE_PENDING_VALUE,
              providerType: "google-chat-bridge",
            },
          ],
          (command) => {
            commands.push(command.join(" "));
            return (handlers[command[1] ?? ""] ?? (() => SUCCESS))();
          },
          {
            bestEffort: true,
            deferCreatedProviderCleanup: true,
            requireExactBindings: true,
          },
        ),
      ).toThrow(
        expect.objectContaining({
          createdProviderNames: [providerName],
          mutatedProviderNames: [providerName],
        }),
      );
      expect(commands.some((command) => command.includes("provider delete"))).toBe(false);
    } finally {
      configureRefreshes.mockRestore();
      ensureProfiles.mockRestore();
    }
  });

  it("rejects a static provider with an extra credential before mutating an earlier provider", () => {
    const commands: string[] = [];
    const missingAlpha = { status: 1, stdout: "", stderr: "provider not found" } as const;
    const mismatchedBeta = {
      status: 0,
      stdout: [
        "Name: beta-discord-bridge",
        "Type: discord-hermes-static-v1",
        "Credential keys: DISCORD_BOT_TOKEN, DISCORD_BOT_TOKEN_EXTRA",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "alpha-discord-test",
            providerType: "discord-hermes-static-v1",
          },
          {
            name: "beta-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "beta-discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command[1] === "get" && command[2] === "alpha-discord-bridge"
            ? missingAlpha
            : mismatchedBeta;
        },
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      }),
    );
    expect(commands.some((command) => /provider (create|update|delete)/u.test(command))).toBe(
      false,
    );
  });

  it("rejects an endpointless static provider with an extra credential before any mutation", () => {
    const commands: string[] = [];
    const missingAlpha = { status: 1, stdout: "", stderr: "provider not found" } as const;
    const mismatchedBeta = {
      status: 0,
      stdout: [
        "Name: beta-telegram-bridge",
        "Type: nemoclaw-mcp-v1",
        "Credential keys: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_EXTRA",
        "Config keys: <none>",
        "",
      ].join("\n"),
      stderr: "",
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "alpha-telegram-test",
            providerType: "nemoclaw-mcp-v1",
          },
          {
            name: "beta-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "beta-telegram-test",
            providerType: "nemoclaw-mcp-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command[1] === "get" && command[2] === "alpha-telegram-bridge"
            ? missingAlpha
            : mismatchedBeta;
        },
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      }),
    );
    expect(commands.some((command) => /provider (create|update|delete)/u.test(command))).toBe(
      false,
    );
  });
});
