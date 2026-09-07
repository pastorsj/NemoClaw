// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HarnessMessagingSupportedIntegration } from "@nvidia/nemoclaw-harness-contract";

import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { compactSandboxMessagingPlanForPersistence } from "../../../messaging/persistence";
import type { SandboxEntry } from "../../../state/registry";
import {
  detachPreparedReceiptProviders,
  prepareReceiptProviderCleanup,
  removePreparedReceiptProviders,
} from "./providers";

const PROVIDER_NAME = "alpha-discord-bridge";
const WEB_SEARCH_PROVIDER_NAME = "alpha-brave-search";
const EXACT_PROVIDER = [
  "Id: provider-id-1",
  `Name: ${PROVIDER_NAME}`,
  "Type: nemoclaw-mcp-v1",
  "Credential keys: DISCORD_BOT_TOKEN",
  "Config keys: <none>",
].join("\n");
const HARNESS_PACKAGE = Object.freeze({
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});
const MESSAGING_INTEGRATION = Object.freeze({
  kind: "channels" as const,
  packageId: "openclaw",
  channels: Object.freeze([
    Object.freeze({
      channelId: "discord",
      config: Object.freeze({ renders: Object.freeze([]), visibility: Object.freeze([]) }),
      policy: Object.freeze([]),
      lifecycle: Object.freeze({ hookIds: Object.freeze([]) }),
    }),
  ]),
  build: Object.freeze({ configRoot: "/sandbox/.openclaw", packageManagers: Object.freeze([]) }),
}) satisfies HarnessMessagingSupportedIntegration;
const PACKAGE_PROVIDER = Object.freeze({
  profilePath: "provider-profiles/discord-v2.yaml",
  profileSha256: "a".repeat(64),
  profileId: "package-discord-v2",
  credentialEnv: "DISCORD_BOT_TOKEN",
  sourceInputId: "botToken",
});
const WEB_SEARCH_PROVIDER = Object.freeze({
  provider: "brave" as const,
  credential_env: "BRAVE_API_KEY",
  profile_type: "brave",
  config_verification: Object.freeze({
    path: "/sandbox/config.json" as const,
    format: "json" as const,
    assertions: Object.freeze([]),
    credential_paths: Object.freeze([]),
  }),
  egress_verification: Object.freeze({
    method: "GET" as const,
    url: "https://example.test/search" as const,
    parameters: Object.freeze([]),
    credential: Object.freeze({ kind: "header" as const, name: "X-Key", prefix: "none" as const }),
    result_array_path: Object.freeze(["results"]),
  }),
});
const PACKAGE_MESSAGING_INTEGRATION = Object.freeze({
  ...MESSAGING_INTEGRATION,
  channels: Object.freeze([
    Object.freeze({
      ...MESSAGING_INTEGRATION.channels[0],
      credentialProvider: PACKAGE_PROVIDER,
    }),
  ]),
}) satisfies HarnessMessagingSupportedIntegration;

function discordMessagingPlan() {
  return makeMessagingPlan({
    sandboxName: "alpha",
    agent: "openclaw",
    channels: ["discord"],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: PROVIDER_NAME,
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "non-secret-test-hash",
      },
    ],
    providerReceipts: [
      {
        channelId: "discord",
        providerName: PROVIDER_NAME,
        providerId: "provider-id-1",
        createdByNemoClaw: true,
        attachmentAddedByNemoClaw: true,
      },
    ],
  });
}

describe("receipt-backed provider cleanup authority", () => {
  it("hydrates compact same-id state from the exact package provider declaration", () => {
    const plan = {
      ...discordMessagingPlan(),
      packageBuild: PACKAGE_MESSAGING_INTEGRATION.build,
      channels: discordMessagingPlan().channels.map((channel) => ({
        ...channel,
        credentialProvider: {
          ...PACKAGE_PROVIDER,
          sourceSecretEnv: "DISCORD_BOT_TOKEN",
        },
      })),
    };
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: HARNESS_PACKAGE,
      messaging: {
        schemaVersion: 1,
        plan: compactSandboxMessagingPlanForPersistence(plan) as typeof plan,
      },
    };
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: EXACT_PROVIDER.replace("nemoclaw-mcp-v1", "package-discord-v2"),
      stderr: "",
    }));

    const prepared = prepareReceiptProviderCleanup("alpha", sandbox, {
      getSandbox: () => sandbox,
      loadMessagingIntegration: () => PACKAGE_MESSAGING_INTEGRATION,
      runOpenshell,
    });

    expect(prepared.bindings).toEqual([
      {
        channelId: "discord",
        name: PROVIDER_NAME,
        type: "package-discord-v2",
        credentialKey: "DISCORD_BOT_TOKEN",
        credentialShape: "only",
        providerId: "provider-id-1",
        createdByNemoClaw: true,
        attachmentAddedByNemoClaw: true,
      },
    ]);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "corrupt"])(
    "fails closed before provider inspection when package authority is %s",
    (condition) => {
      const plan = {
        ...discordMessagingPlan(),
        packageBuild: MESSAGING_INTEGRATION.build,
      };
      const sandbox: SandboxEntry = {
        name: "alpha",
        agent: "openclaw",
        harnessPackage: HARNESS_PACKAGE,
        messaging: {
          schemaVersion: 1,
          plan: compactSandboxMessagingPlanForPersistence(plan) as typeof plan,
        },
      };
      const runOpenshell = vi.fn();

      expect(() =>
        prepareReceiptProviderCleanup("alpha", sandbox, {
          getSandbox: () => sandbox,
          loadMessagingIntegration: () => {
            throw new Error(`${condition} package messaging authority`);
          },
          runOpenshell,
        }),
      ).toThrow(`${condition} package messaging authority`);
      expect(runOpenshell).not.toHaveBeenCalled();
    },
  );

  it("rejects a same-id plan when the loaded messaging profile belongs to another package", () => {
    const plan = {
      ...discordMessagingPlan(),
      packageBuild: MESSAGING_INTEGRATION.build,
    };
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: HARNESS_PACKAGE,
      messaging: {
        schemaVersion: 1,
        plan: compactSandboxMessagingPlanForPersistence(plan) as typeof plan,
      },
    };
    const runOpenshell = vi.fn();

    expect(() =>
      prepareReceiptProviderCleanup("alpha", sandbox, {
        getSandbox: () => sandbox,
        loadMessagingIntegration: () => ({
          ...MESSAGING_INTEGRATION,
          packageId: "hermes",
        }),
        runOpenshell,
      }),
    ).toThrow("belongs to 'hermes', not 'openclaw'");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("detaches and deletes only the exact provider persisted by the package plan", () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: HARNESS_PACKAGE,
      messaging: { schemaVersion: 1, plan: discordMessagingPlan() },
    };
    let providerExists = true;
    const runOpenshell = vi.fn((args: string[]) => {
      const command = args.join(" ");
      const handlers: Record<string, () => { status: number; stdout: string; stderr: string }> = {
        [`provider get ${PROVIDER_NAME}`]: () =>
          providerExists
            ? { status: 0, stdout: EXACT_PROVIDER, stderr: "" }
            : {
                status: 1,
                stdout: "",
                stderr: `Error: provider '${PROVIDER_NAME}' not found`,
              },
        [`sandbox provider detach alpha ${PROVIDER_NAME}`]: () => ({
          status: 0,
          stdout: "",
          stderr: "",
        }),
        [`provider delete ${PROVIDER_NAME}`]: () => {
          providerExists = false;
          return { status: 0, stdout: "", stderr: "" };
        },
      };
      expect(handlers[command], `Unexpected OpenShell command: ${command}`).toBeDefined();
      return handlers[command]!();
    });
    const deps = {
      getSandbox: () => sandbox,
      loadMessagingIntegration: () => MESSAGING_INTEGRATION,
      runOpenshell,
    };

    const prepared = prepareReceiptProviderCleanup("alpha", sandbox, deps);
    expect(prepared.bindings.map(({ name }) => name)).toEqual([PROVIDER_NAME]);
    expect(detachPreparedReceiptProviders(prepared, deps)).toEqual({
      detached: [PROVIDER_NAME],
      failures: [],
    });
    removePreparedReceiptProviders(prepared, deps);

    const commands = runOpenshell.mock.calls.map(([args]) => args.join(" "));
    expect(commands).toContain(`sandbox provider detach alpha ${PROVIDER_NAME}`);
    expect(commands).toContain(`provider delete ${PROVIDER_NAME}`);
    expect(commands.every((command) => !command.includes("telegram-bridge"))).toBe(true);
  });

  it("rejects an unrelated provider that has the same name but different metadata", () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: HARNESS_PACKAGE,
      messaging: { schemaVersion: 1, plan: discordMessagingPlan() },
    };
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: EXACT_PROVIDER.replace("DISCORD_BOT_TOKEN", "UNRELATED_TOKEN"),
      stderr: "",
    }));

    expect(() =>
      prepareReceiptProviderCleanup("alpha", sandbox, {
        getSandbox: () => sandbox,
        loadMessagingIntegration: () => MESSAGING_INTEGRATION,
        runOpenshell,
      }),
    ).toThrow("does not match its persisted binding");
    expect(
      runOpenshell.mock.calls.some(
        ([args]) => args[0] === "sandbox" || (args[0] === "provider" && args[1] === "delete"),
      ),
    ).toBe(false);
  });

  function webSearchSandbox(
    ownership: Partial<NonNullable<SandboxEntry["webSearchProviderOwnership"]>> = {},
  ): SandboxEntry {
    return {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: HARNESS_PACKAGE,
      webSearchEnabled: true,
      webSearchProvider: "brave",
      webSearchProviderOwnership: {
        schemaVersion: 1,
        purpose: "web-search",
        providerName: WEB_SEARCH_PROVIDER_NAME,
        providerId: "web-provider-id-1",
        providerType: "brave",
        credentialEnv: "BRAVE_API_KEY",
        createdByNemoClaw: true,
        attachmentAddedByNemoClaw: true,
        ...ownership,
      },
    };
  }

  function webSearchCleanupHarness(sandbox: SandboxEntry) {
    let providerExists = true;
    const detach = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const deleteProvider = vi.fn(() => {
      providerExists = false;
      return {
        ok: true,
        status: 0,
        stdout: "",
        stderr: "",
        recoveryFailures: [],
      };
    });
    const deps = {
      getSandbox: () => sandbox,
      loadWebSearchProviderBinding: () => WEB_SEARCH_PROVIDER,
      inspectCredentialOnly: () => ({ kind: providerExists ? "exact" : "missing" }) as const,
      inspectProviderMetadata: () =>
        providerExists
          ? {
              id: "web-provider-id-1",
              name: WEB_SEARCH_PROVIDER_NAME,
              type: "brave",
              credentialKeys: ["BRAVE_API_KEY"],
              configKeys: [],
            }
          : null,
      deleteProvider,
      runOpenshell: detach,
    };
    return { deps, detach, deleteProvider };
  }

  it("detaches and deletes a created web-search provider under its stable receipt", () => {
    const sandbox = webSearchSandbox();
    const { deps, detach, deleteProvider } = webSearchCleanupHarness(sandbox);

    const prepared = prepareReceiptProviderCleanup("alpha", sandbox, deps);
    expect(prepared.bindings).toMatchObject([
      {
        channelId: "web-search",
        name: WEB_SEARCH_PROVIDER_NAME,
        providerId: "web-provider-id-1",
        createdByNemoClaw: true,
        attachmentAddedByNemoClaw: true,
      },
    ]);
    detachPreparedReceiptProviders(prepared, deps);
    removePreparedReceiptProviders(prepared, deps);

    expect(detach).toHaveBeenCalledWith(
      ["sandbox", "provider", "detach", "alpha", WEB_SEARCH_PROVIDER_NAME],
      expect.any(Object),
    );
    expect(deleteProvider).toHaveBeenCalledExactlyOnceWith(WEB_SEARCH_PROVIDER_NAME, {
      allowedSandboxes: ["alpha"],
      runOpenshell: detach,
    });
  });

  it.each([
    {
      label: "attachment added by NemoClaw",
      ownership: { createdByNemoClaw: false, attachmentAddedByNemoClaw: true },
      detachCount: 1,
    },
    {
      label: "pre-existing attachment",
      ownership: { createdByNemoClaw: false, attachmentAddedByNemoClaw: false },
      detachCount: 0,
    },
  ])("does not delete an adopted provider with $label", ({ ownership, detachCount }) => {
    const sandbox = webSearchSandbox(ownership);
    const { deps, detach, deleteProvider } = webSearchCleanupHarness(sandbox);

    const prepared = prepareReceiptProviderCleanup("alpha", sandbox, deps);
    detachPreparedReceiptProviders(prepared, deps);
    removePreparedReceiptProviders(prepared, deps);

    expect(detach).toHaveBeenCalledTimes(detachCount);
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("fails before inspection when enabled web search has no ownership receipt", () => {
    const sandbox = webSearchSandbox();
    delete sandbox.webSearchProviderOwnership;
    const inspectCredentialOnly = vi.fn();

    expect(() =>
      prepareReceiptProviderCleanup("alpha", sandbox, {
        getSandbox: () => sandbox,
        loadWebSearchProviderBinding: () => WEB_SEARCH_PROVIDER,
        inspectCredentialOnly,
        runOpenshell: vi.fn(),
      }),
    ).toThrow(/no stable ownership receipt/u);
    expect(inspectCredentialOnly).not.toHaveBeenCalled();
  });

  it("fails before mutation when the stable web-search provider identity drifts", () => {
    const sandbox = webSearchSandbox();
    const deleteProvider = vi.fn();

    expect(() =>
      prepareReceiptProviderCleanup("alpha", sandbox, {
        getSandbox: () => sandbox,
        loadWebSearchProviderBinding: () => WEB_SEARCH_PROVIDER,
        inspectCredentialOnly: () => ({ kind: "exact" }),
        inspectProviderMetadata: () => ({
          id: "replacement-provider-id",
          name: WEB_SEARCH_PROVIDER_NAME,
          type: "brave",
          credentialKeys: ["BRAVE_API_KEY"],
          configKeys: [],
        }),
        deleteProvider,
        runOpenshell: vi.fn(),
      }),
    ).toThrow(/changed from its recorded stable identity/u);
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("rejects orphaned and package-drifted web-search receipts before inspection", () => {
    const orphaned = { ...webSearchSandbox(), webSearchEnabled: false };
    const inspectCredentialOnly = vi.fn();
    expect(() =>
      prepareReceiptProviderCleanup("alpha", orphaned, {
        getSandbox: () => orphaned,
        loadWebSearchProviderBinding: () => WEB_SEARCH_PROVIDER,
        inspectCredentialOnly,
        runOpenshell: vi.fn(),
      }),
    ).toThrow(/orphaned/u);

    const drifted = webSearchSandbox({ providerType: "replacement-profile" });
    expect(() =>
      prepareReceiptProviderCleanup("alpha", drifted, {
        getSandbox: () => drifted,
        loadWebSearchProviderBinding: () => WEB_SEARCH_PROVIDER,
        inspectCredentialOnly,
        runOpenshell: vi.fn(),
      }),
    ).toThrow(/disagrees with its package declaration/u);
    expect(inspectCredentialOnly).not.toHaveBeenCalled();
  });
});
