// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { MessagingProviderApplyError } from "../messaging/applier/openshell-provider";
import { MessagingSetupApplier } from "../messaging/applier/setup-applier";
import type { Session } from "../state/onboard-session";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "./credential-provider-registration";
import { MESSAGING_BRIDGE_PENDING_VALUE } from "./messaging-bridge-provider";
import type { MessagingTokenDef } from "./messaging-prep";

function providerMetadata(
  name: string,
  type: string,
  credentialKey: string,
): { status: number; stdout: string; stderr: string } {
  return {
    status: 0,
    stdout: [
      `Id: provider-${name}`,
      `Name: ${name}`,
      `Type: ${type}`,
      "Resource version: 1",
      `Credential keys: ${credentialKey}`,
      "Config keys: <none>",
    ].join("\n"),
    stderr: "",
  };
}

function registrationDeps(
  runOpenshellMock: ReturnType<typeof vi.fn>,
  session: Session,
): CredentialProviderRegistrationDeps {
  return {
    root: "/repo",
    runOpenshell: runOpenshellMock as unknown as CredentialProviderRegistrationDeps["runOpenshell"],
    getGatewayName: () => "test-gateway",
    getCredential: () => null,
    updateSession: vi.fn(
      (mutator: (current: Session) => Session | void): Session => mutator(session) ?? session,
    ),
    loadSession: () => session,
    stagedLegacyValues: new Map(),
    migratedLegacyKeys: new Set(),
    persistMigratedLegacyKeys: vi.fn(),
  };
}

function requiredBindings(tokenDefs: readonly MessagingTokenDef[]) {
  return tokenDefs.map((tokenDef) => ({
    name: tokenDef.name,
    type: tokenDef.providerType || "generic",
    credentialEnv: tokenDef.envKey,
  }));
}

function sandboxInput(bindings: ReturnType<typeof requiredBindings>) {
  return {
    sandboxName: "alpha",
    enabledChannels: ["googlechat"],
    webSearchConfig: null,
    agent: {},
    requiredBindings: bindings,
  };
}

function bridgeRefreshCleanupScenario(deleteStatus: number, deleteError: string) {
  const session = { stagedCredentialProviders: [] } as unknown as Session;
  let providerExists = false;
  const commandHandlers = new Map<string, () => ReturnType<typeof providerMetadata>>([
    [
      "get",
      () =>
        providerExists
          ? providerMetadata(
              "alpha-googlechat-bridge",
              "google-chat-bridge",
              "GOOGLE_CHAT_ACCESS_TOKEN",
            )
          : {
              status: 1,
              stdout: "",
              stderr:
                "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
            },
    ],
    [
      "create",
      () => {
        providerExists = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    ],
    [
      "delete",
      () => {
        providerExists = deleteStatus !== 0;
        return { status: deleteStatus, stdout: "", stderr: deleteError };
      },
    ],
  ]);
  const runOpenshell = vi.fn(
    (args: string[]) =>
      commandHandlers.get(args[1] ?? "")?.() ?? { status: 0, stdout: "", stderr: "" },
  );
  const registration = createCredentialProviderRegistration(
    registrationDeps(runOpenshell, session),
  );
  const tokenDef: MessagingTokenDef = {
    name: "alpha-googlechat-bridge",
    envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
    token: MESSAGING_BRIDGE_PENDING_VALUE,
    providerType: "google-chat-bridge",
  };
  const apply = vi
    .spyOn(MessagingSetupApplier, "applyCredentialsAtOpenShell")
    .mockImplementation(() => {
      providerExists = true;
      return Promise.reject(
        new MessagingProviderApplyError({
          message: "token minting failed",
          mutatedProviderNames: [tokenDef.name],
          createdProviderNames: [tokenDef.name],
        }),
      );
    });
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

  return {
    errorLog,
    providerExists: () => providerExists,
    registration,
    restore: () => {
      errorLog.mockRestore();
      exit.mockRestore();
      apply.mockRestore();
    },
    runOpenshell,
    session,
    tokenDef,
  };
}

describe("credential provider cleanup", () => {
  it("removes a newly created bridge provider when refresh configuration fails", async () => {
    const scenario = bridgeRefreshCleanupScenario(0, "");
    try {
      const failure = await scenario.registration
        .stageSandboxCredentialProviders(
          sandboxInput(requiredBindings([scenario.tokenDef])),
          async () => ({ messagingTokenDefs: [scenario.tokenDef] }),
        )
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ message: expect.stringContaining("token minting failed") });
      expect(scenario.runOpenshell).toHaveBeenCalledWith(
        ["provider", "delete", "-g", "test-gateway", "alpha-googlechat-bridge"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(scenario.session.stagedCredentialProviders).toEqual([]);
      expect(scenario.providerExists()).toBe(false);
      expect(scenario.errorLog.mock.calls.flat().join("\n")).not.toContain(
        "Automatic cleanup could not remove",
      );
    } finally {
      scenario.restore();
    }
  });

  it("reports a newly created bridge provider when refresh cleanup fails", async () => {
    const scenario = bridgeRefreshCleanupScenario(1, "gateway unavailable");
    try {
      const failure = await scenario.registration
        .stageSandboxCredentialProviders(
          sandboxInput(requiredBindings([scenario.tokenDef])),
          async () => ({ messagingTokenDefs: [scenario.tokenDef] }),
        )
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        createdProviderNames: ["alpha-googlechat-bridge"],
        mutatedProviderNames: ["alpha-googlechat-bridge"],
      });
      expect(scenario.runOpenshell).toHaveBeenCalledWith(
        ["provider", "delete", "-g", "test-gateway", "alpha-googlechat-bridge"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(scenario.session.stagedCredentialProviders).toEqual([]);
      expect(scenario.providerExists()).toBe(true);
      const diagnostics = String((failure as Error).message);
      expect(diagnostics).toContain("Automatic cleanup could not remove");
      expect(diagnostics).toContain("alpha-googlechat-bridge");
      expect(diagnostics).toContain("gateway unavailable");
      expect(diagnostics).toContain(
        'openshell provider delete -g "test-gateway" "alpha-googlechat-bridge"',
      );
      expect(diagnostics.match(/Automatic cleanup could not remove/gu)).toHaveLength(1);
    } finally {
      scenario.restore();
    }
  });
});
