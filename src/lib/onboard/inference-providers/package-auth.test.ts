// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessProviderAuthMethod,
  HarnessProviderSelectionDeclaration,
} from "@nvidia/nemoclaw-harness-contract";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { setupPackageProviderInference, type PackageProviderAuthDeps } from "./package-auth";

const identity: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
};
const selection: HarnessProviderSelectionDeclaration = {
  key: "futureProvider",
  aliases: ["future"],
  label: "Future Provider",
  provider_name: "future-provider",
  provider_type: "openai",
  endpoint_url: "https://inference.example.com/v1",
  help_url: "https://example.com/keys",
  default_model: "future/default",
  models: ["future/default"],
  preferred_inference_api: "openai-completions",
};
const apiKeyMethod: HarnessProviderAuthMethod = {
  id: "api-key",
  label: "Future API key",
  kind: "api-key",
  credential_env: "FUTURE_API_KEY",
  source_env: "FUTURE_API_KEY",
  prompt_label: "Future API key",
};
const oauthMethod: HarnessProviderAuthMethod = {
  id: "browser-login",
  label: "Future browser login",
  kind: "oauth-device-code",
  credential_env: "FUTURE_TOKEN",
  device_code: {
    portal_base_url: "https://login.example.com",
    client_id: "future-cli",
    scope: "inference",
    minimum_credential_ttl_seconds: 600,
  },
};

function ownedBrokerSandbox() {
  return {
    name: "future-box",
    harnessPackage: identity,
    providerBroker: {
      schemaVersion: 1 as const,
      harnessPackage: identity,
      providerName: "future-box-tools",
      providerType: "generic" as const,
      credentialEnv: "FUTURE_REFRESH",
    },
  };
}

function dependencies(overrides: Partial<PackageProviderAuthDeps> = {}) {
  const runOpenshell = vi.fn((args: string[]) =>
    args[0] === "provider" && args[1] === "get"
      ? {
          status: 1,
          stdout: "",
          stderr: `Error: provider '${String(args[2])}' not found`,
        }
      : {
          status: args[0] === "provider" || args[0] === "inference" ? 0 : 1,
          stdout: "",
          stderr: "",
        },
  );
  const upsertProvider = vi.fn(() => ({ ok: true }));
  const verifyInferenceRoute = vi.fn();
  const verifyOnboardInferenceSmoke = vi.fn();
  const updateSandbox = vi.fn(() => true);
  const deps: PackageProviderAuthDeps = {
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive: () => true,
    registry: { updateSandbox, getSandbox: () => null },
    exitProcess: (code) => {
      throw new Error(`exit ${String(code)}`);
    },
    error: vi.fn(),
    log: vi.fn(),
    providerExistsInGateway: () => false,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    redact: (value) => value.replaceAll("secret", "[REDACTED]"),
    compactText: (value) => value.trim().replace(/\s+/gu, " "),
    ...overrides,
  };
  return { deps, runOpenshell, upsertProvider, verifyInferenceRoute, updateSandbox };
}

afterEach(() => {
  delete process.env.FUTURE_API_KEY;
  delete process.env.NEMOCLAW_PROVIDER_KEY;
});

describe("receipt-backed package provider setup", () => {
  it("registers an API key with OpenShell and proves the route without persisting the secret", async () => {
    process.env.FUTURE_API_KEY = "future-secret";
    const { deps, runOpenshell, upsertProvider, verifyInferenceRoute, updateSandbox } =
      dependencies();

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_API_KEY",
          selection,
          method: apiKeyMethod,
          toolGatewaySelections: [],
        },
        deps,
      ),
    ).resolves.toEqual({ ok: true });

    expect(upsertProvider).toHaveBeenCalledWith(
      "future-provider",
      "openai",
      "FUTURE_API_KEY",
      selection.endpoint_url,
      { FUTURE_API_KEY: "future-secret" },
      { knownExists: false, requireExactBinding: false },
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "future-provider",
        "--model",
        "future/default",
      ],
      { ignoreError: true },
    );
    expect(verifyInferenceRoute).toHaveBeenCalledWith("future-provider", "future/default");
    expect(updateSandbox).toHaveBeenCalledWith("future-box", {
      provider: "future-provider",
      model: "future/default",
    });
  });

  it("drives OAuth from package data through the fixed core engine", async () => {
    const runDeviceCodeFlow = vi.fn(async () => ({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 900,
      token_type: "Bearer",
    }));
    const mintAgentKeyWithAccessToken = vi.fn(async () => ({
      api_key: "minted-secret",
      inference_base_url: selection.endpoint_url,
    }));
    const { deps, upsertProvider } = dependencies({
      isNonInteractive: () => false,
      oauth: { runDeviceCodeFlow, mintAgentKeyWithAccessToken },
    });

    await setupPackageProviderInference(
      {
        identity,
        sandboxName: "future-box",
        model: "future/default",
        provider: "future-provider",
        endpointUrl: selection.endpoint_url,
        credentialEnv: "FUTURE_TOKEN",
        selection,
        method: oauthMethod,
        toolGatewaySelections: [],
      },
      deps,
    );

    expect(runDeviceCodeFlow).toHaveBeenCalledWith({
      portalBaseUrl: "https://login.example.com",
      clientId: "future-cli",
      scope: "inference",
      providerLabel: "Future Provider",
    });
    expect(mintAgentKeyWithAccessToken).toHaveBeenCalledWith("access-secret", {
      portalBaseUrl: "https://login.example.com",
      minTtlSeconds: 600,
    });
    expect(upsertProvider).toHaveBeenCalledWith(
      "future-provider",
      "openai",
      "FUTURE_TOKEN",
      selection.endpoint_url,
      { FUTURE_TOKEN: "minted-secret" },
      { knownExists: false, requireExactBinding: false },
    );
  });

  it("rejects route fields that drift from the package declaration before mutation", async () => {
    const { deps, runOpenshell, upsertProvider } = dependencies();
    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "substituted-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_API_KEY",
          selection,
          method: apiKeyMethod,
          toolGatewaySelections: [],
        },
        deps,
      ),
    ).rejects.toThrow(/drifted/u);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("reuses only an exact non-secret provider binding without host credentials", async () => {
    const exactRunOpenshell = vi.fn((args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "provider" && args[1] === "get"
          ? "Name: future-provider\nType: openai\nCredential keys: FUTURE_API_KEY\nConfig keys: OPENAI_BASE_URL\n"
          : "",
      stderr: "",
    }));
    const { deps, upsertProvider, verifyInferenceRoute } = dependencies({
      runOpenshell: exactRunOpenshell,
    });

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_API_KEY",
          selection,
          method: apiKeyMethod,
          toolGatewaySelections: [],
        },
        deps,
      ),
    ).resolves.toEqual({ ok: true });

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(exactRunOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "future-provider",
        "--model",
        "future/default",
      ],
      { ignoreError: true },
    );
    expect(verifyInferenceRoute).toHaveBeenCalled();
  });

  it.each([
    {
      field: "type",
      metadata:
        "Name: future-provider\nType: anthropic\nCredential keys: FUTURE_API_KEY\nConfig keys: OPENAI_BASE_URL\n",
      environment: {},
    },
    {
      field: "credential",
      metadata:
        "Name: future-provider\nType: openai\nCredential keys: FOREIGN_KEY\nConfig keys: OPENAI_BASE_URL\n",
      environment: { FUTURE_API_KEY: "future-secret" },
    },
    {
      field: "config",
      metadata:
        "Name: future-provider\nType: openai\nCredential keys: FUTURE_API_KEY\nConfig keys: FOREIGN_BASE_URL\n",
      environment: { FUTURE_API_KEY: "future-secret" },
    },
  ])(
    "fails closed on an existing provider with a colliding $field binding",
    async ({ environment, metadata }) => {
      Object.assign(process.env, environment);
      const runOpenshell = vi.fn((args: string[]) => ({
        status: 0,
        stdout: args[0] === "provider" && args[1] === "get" ? metadata : "",
        stderr: "",
      }));
      const { deps, upsertProvider } = dependencies({ runOpenshell });

      await expect(
        setupPackageProviderInference(
          {
            identity,
            sandboxName: "future-box",
            model: "future/default",
            provider: "future-provider",
            endpointUrl: selection.endpoint_url,
            credentialEnv: "FUTURE_API_KEY",
            selection,
            method: apiKeyMethod,
            toolGatewaySelections: [],
          },
          deps,
        ),
      ).rejects.toThrow("exit 1");

      expect(upsertProvider).not.toHaveBeenCalled();
      expect(runOpenshell).not.toHaveBeenCalledWith(
        expect.arrayContaining(["inference", "set"]),
        expect.anything(),
      );
    },
  );

  it("fails closed on an indeterminate provider inspection even when a host key is present", async () => {
    process.env.FUTURE_API_KEY = "future-secret";
    const runOpenshell = vi.fn((args: string[]) =>
      args[0] === "provider" && args[1] === "get"
        ? { status: 1, stdout: "", stderr: "gateway unavailable" }
        : { status: 0, stdout: "", stderr: "" },
    );
    const { deps, upsertProvider } = dependencies({ runOpenshell });

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_API_KEY",
          selection,
          method: apiKeyMethod,
          toolGatewaySelections: [],
        },
        deps,
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("compensates exact broker resources when durable ownership cannot be recorded", async () => {
    const controllerOperations: string[] = [];
    const runProviderBrokerController = vi.fn((_identity, request) => {
      controllerOperations.push(request.operation);
      return request.operation === "register-refresh-provider"
        ? {
            ok: true as const,
            providerName: "future-box-tools",
            credentialEnv: "FUTURE_REFRESH",
            credentialValue: "opaque-broker-token",
          }
        : {
            ok: true as const,
            providerName: "future-box-tools",
            teardownComplete: true as const,
          };
    });
    const brokerProviderResponses = [
      {
        status: 1,
        stdout: "",
        stderr: "Error: provider 'future-box-tools' not found",
      },
      {
        status: 0,
        stdout:
          "Name: future-box-tools\nType: generic\nCredential keys: FUTURE_REFRESH\nConfig keys: <none>",
        stderr: "",
      },
    ];
    const providerResponses: Record<string, () => (typeof brokerProviderResponses)[number]> = {
      "provider get future-provider": () => ({
        status: 0,
        stdout:
          "Name: future-provider\nType: openai\nCredential keys: FUTURE_TOKEN\nConfig keys: OPENAI_BASE_URL",
        stderr: "",
      }),
      "provider get future-box-tools": () => brokerProviderResponses.shift()!,
    };
    const runOpenshell = vi.fn((args: string[]) => {
      return providerResponses[args.join(" ")]?.() ?? { status: 0, stdout: "", stderr: "" };
    });
    const { deps } = dependencies({
      isNonInteractive: () => false,
      runOpenshell,
      describeProviderBroker: () => "future-box-tools",
      runProviderBrokerController,
      registry: {
        updateSandbox: vi.fn(() => {
          throw new Error("registry unavailable");
        }),
        getSandbox: () => null,
      },
      oauth: {
        runDeviceCodeFlow: async () => ({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 900,
          token_type: "Bearer",
        }),
        mintAgentKeyWithAccessToken: async () => ({
          api_key: "agent-key",
          inference_base_url: selection.endpoint_url,
        }),
      },
    });

    await setupPackageProviderInference(
      {
        identity,
        sandboxName: "future-box",
        model: "future/default",
        provider: "future-provider",
        endpointUrl: selection.endpoint_url,
        credentialEnv: "FUTURE_TOKEN",
        selection,
        method: oauthMethod,
        toolGatewaySelections: ["search"],
      },
      deps,
    );

    expect(controllerOperations).toEqual(["register-refresh-provider", "teardown-broker"]);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "delete", "future-box-tools"],
      expect.any(Object),
    );
  });

  it("retains exact durable ownership when broker startup fails", async () => {
    const runProviderBrokerController = vi
      .fn()
      .mockReturnValueOnce({
        ok: true as const,
        providerName: "future-box-tools",
        credentialEnv: "FUTURE_REFRESH",
        credentialValue: "opaque-broker-token",
      })
      .mockImplementationOnce(() => {
        throw new Error("broker unavailable");
      });
    const { deps, updateSandbox } = dependencies({
      isNonInteractive: () => false,
      describeProviderBroker: () => "future-box-tools",
      runProviderBrokerController,
      oauth: {
        runDeviceCodeFlow: async () => ({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 900,
          token_type: "Bearer",
        }),
        mintAgentKeyWithAccessToken: async () => ({
          api_key: "agent-key",
          inference_base_url: selection.endpoint_url,
        }),
      },
    });

    await setupPackageProviderInference(
      {
        identity,
        sandboxName: "future-box",
        model: "future/default",
        provider: "future-provider",
        endpointUrl: selection.endpoint_url,
        credentialEnv: "FUTURE_TOKEN",
        selection,
        method: oauthMethod,
        toolGatewaySelections: ["search"],
      },
      deps,
    );

    expect(runProviderBrokerController.mock.calls.map(([, request]) => request.operation)).toEqual([
      "register-refresh-provider",
      "ensure-broker",
    ]);
    expect(updateSandbox).toHaveBeenCalledWith(
      "future-box",
      expect.objectContaining({
        providerBroker: expect.objectContaining({
          harnessPackage: identity,
          providerName: "future-box-tools",
          credentialEnv: "FUTURE_REFRESH",
        }),
      }),
    );
  });

  it("refuses an existing broker provider without a matching durable ownership receipt", async () => {
    const runProviderBrokerController = vi.fn();
    const runOpenshell = vi.fn((args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "provider" && args[1] === "get"
          ? args[2] === "future-provider"
            ? "Name: future-provider\nType: openai\nCredential keys: FUTURE_TOKEN\nConfig keys: OPENAI_BASE_URL"
            : "Name: future-box-tools\nType: generic\nCredential keys: FUTURE_REFRESH\nConfig keys: <none>"
          : "",
      stderr: "",
    }));
    const { deps, upsertProvider } = dependencies({
      runOpenshell,
      providerExistsInGateway: () => true,
      describeProviderBroker: () => "future-box-tools",
      runProviderBrokerController,
      registry: {
        updateSandbox: vi.fn(() => true),
        getSandbox: () => ({ name: "future-box", harnessPackage: identity }),
      },
    });

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_TOKEN",
          selection,
          method: oauthMethod,
          toolGatewaySelections: ["search"],
        },
        deps,
      ),
    ).rejects.toThrow("exit 1");

    expect(runProviderBrokerController).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "set"]),
      expect.anything(),
    );
  });

  it("reuses managed tools noninteractively only after exact receipt and broker inspection", async () => {
    const runDeviceCodeFlow = vi.fn();
    const runProviderBrokerController = vi.fn();
    const inspectProviderBroker = vi.fn(() => ({
      ok: true as const,
      providerName: "future-box-tools",
      brokerReady: true,
      sandboxRegistered: true,
    }));
    const runOpenshell = vi.fn((args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "provider" && args[1] === "get"
          ? args[2] === "future-provider"
            ? "Name: future-provider\nType: openai\nCredential keys: FUTURE_TOKEN\nConfig keys: OPENAI_BASE_URL"
            : "Name: future-box-tools\nType: generic\nCredential keys: FUTURE_REFRESH\nConfig keys: <none>"
          : "",
      stderr: "",
    }));
    const { deps, upsertProvider } = dependencies({
      runOpenshell,
      providerExistsInGateway: () => true,
      describeProviderBroker: () => "future-box-tools",
      inspectProviderBroker,
      runProviderBrokerController,
      registry: {
        updateSandbox: vi.fn(() => true),
        getSandbox: () => ownedBrokerSandbox(),
      },
      oauth: {
        runDeviceCodeFlow,
        mintAgentKeyWithAccessToken: vi.fn(),
      },
    });

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_TOKEN",
          selection,
          method: oauthMethod,
          toolGatewaySelections: ["search"],
        },
        deps,
      ),
    ).resolves.toEqual({ ok: true });

    expect(inspectProviderBroker).toHaveBeenCalledWith(identity, "future-box");
    expect(runDeviceCodeFlow).not.toHaveBeenCalled();
    expect(runProviderBrokerController).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("refuses noninteractive broker reuse when typed inspection reports it unready", async () => {
    const runProviderBrokerController = vi.fn();
    const runOpenshell = vi.fn((args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "provider" && args[1] === "get"
          ? args[2] === "future-provider"
            ? "Name: future-provider\nType: openai\nCredential keys: FUTURE_TOKEN\nConfig keys: OPENAI_BASE_URL"
            : "Name: future-box-tools\nType: generic\nCredential keys: FUTURE_REFRESH\nConfig keys: <none>"
          : "",
      stderr: "",
    }));
    const { deps, upsertProvider } = dependencies({
      runOpenshell,
      providerExistsInGateway: () => true,
      describeProviderBroker: () => "future-box-tools",
      inspectProviderBroker: () => ({
        ok: true,
        providerName: "future-box-tools",
        brokerReady: false,
        sandboxRegistered: false,
      }),
      runProviderBrokerController,
      registry: {
        updateSandbox: vi.fn(() => true),
        getSandbox: () => ownedBrokerSandbox(),
      },
    });

    await expect(
      setupPackageProviderInference(
        {
          identity,
          sandboxName: "future-box",
          model: "future/default",
          provider: "future-provider",
          endpointUrl: selection.endpoint_url,
          credentialEnv: "FUTURE_TOKEN",
          selection,
          method: oauthMethod,
          toolGatewaySelections: ["search"],
        },
        deps,
      ),
    ).rejects.toThrow("exit 1");

    expect(runProviderBrokerController).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "set"]),
      expect.anything(),
    );
  });
});
