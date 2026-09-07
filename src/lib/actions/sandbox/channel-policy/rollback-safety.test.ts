// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayRuntime from "../../../gateway-runtime-action";
import * as credentialStore from "../../../credentials/store";
import * as policies from "../../../policy";
import {
  captureSandboxCommandAgentAuthority,
  type SandboxCommandAgentAuthority,
} from "../../../sandbox/command-agent";
import * as registry from "../../../state/registry";
import * as registryMessaging from "../../../state/registry-messaging";
import * as registryRead from "../../../state/registry/read";
import { createHarnessPackageFixture } from "../../../../../test/helpers/harness-packages";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { addSandboxChannel } from "../policy-channel";
import { policyChannelDependencies } from "../policy-channel-dependencies";
import * as policyContextRefresh from "../policy-context-refresh";

const commandAgentMocks = vi.hoisted(() => ({
  requireCurrentAuthority: vi.fn(),
}));

vi.mock("../../../sandbox/command-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sandbox/command-agent")>()),
  requireCurrentSandboxCommandAgentAuthority: commandAgentMocks.requireCurrentAuthority,
}));

const sandboxName = "alpha";
let authority: SandboxCommandAgentAuthority;
let policyContext: policies.PolicyMutationContext;

function contextWithPolicy(basePolicyDocument: string): policies.PolicyMutationContext {
  return {
    gatewayName: "test-gateway",
    inspection: {} as policies.PolicyMutationContext["inspection"],
    basePolicyDocument,
    agentAuthority: authority,
  };
}

beforeEach(() => {
  commandAgentMocks.requireCurrentAuthority.mockReset();

  vi.spyOn(registry, "getSandbox").mockReturnValue(null);
  vi.spyOn(registry, "getHydratedMessagingPlanFromEntry").mockReturnValue(null);
  vi.spyOn(registryRead, "getSandbox").mockImplementation((name) => registry.getSandbox(name));
  vi.spyOn(registryMessaging, "getHydratedMessagingPlanFromEntry").mockImplementation(
    (entry, options) => registry.getHydratedMessagingPlanFromEntry(entry, options),
  );
  vi.spyOn(policies, "inspectPolicyMutationContext").mockImplementation(() => policyContext);
  vi.spyOn(policies, "recheckPolicyMutationContext").mockImplementation(() => policyContext);
  vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
  vi.spyOn(policies, "logPresetScopeForState").mockImplementation(() => undefined);
  vi.spyOn(policies, "setPolicyDocument").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("receipt-backed add rollback safety", () => {
  it.each([
    {
      channelId: "telegram",
      failure: "bound-policy",
      providerCase: "created",
      expectedPolicySets: 4,
      expectedDetaches: 1,
      expectedDeletes: 1,
    },
    {
      channelId: "telegram",
      failure: "setter-throw",
      providerCase: "created",
      expectedPolicySets: 4,
      expectedDetaches: 1,
      expectedDeletes: 1,
    },
    {
      channelId: "telegram",
      failure: "registry",
      providerCase: "created",
      expectedPolicySets: 4,
      expectedDetaches: 1,
      expectedDeletes: 1,
    },
    {
      channelId: "whatsapp",
      failure: "registry",
      providerCase: "none",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "registry",
      providerCase: "existing",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "registry",
      providerCase: "collision",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "attach",
      providerCase: "existing",
      expectedPolicySets: 0,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "provider-upsert",
      providerCase: "created",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 1,
    },
    {
      channelId: "telegram",
      failure: "provider-upsert",
      providerCase: "existing",
      expectedPolicySets: 0,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "registry",
      providerCase: "policy-identity-drift",
      expectedPolicySets: 0,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "provider-upsert",
      providerCase: "collision",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "provider-upsert",
      providerCase: "indeterminate",
      expectedPolicySets: 2,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "provider-upsert",
      providerCase: "identity-drift",
      expectedPolicySets: 1,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
    {
      channelId: "telegram",
      failure: "registry",
      providerCase: "identity-drift",
      expectedPolicySets: 1,
      expectedDetaches: 0,
      expectedDeletes: 0,
    },
  ] as const)(
    "restores the exact original policy after fresh $channelId $failure failure with a $providerCase provider",
    async ({
      channelId,
      failure,
      providerCase,
      expectedPolicySets,
      expectedDetaches,
      expectedDeletes,
    }) => {
      const fixtureParent = path.join(
        process.cwd(),
        `node_modules/.cache/nemoclaw-channel-policy-${channelId}-${failure}`,
      );
      fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
      const home = fs.mkdtempSync(path.join(fixtureParent, "home-"));
      const fixture = createHarnessPackageFixture({
        fixtureParent: path.join(home, "fixture"),
        storeRoot: path.join(home, ".nemoclaw", "harnesses"),
        messaging: { packageId: "openclaw", channelIds: [channelId] },
      });
      try {
        const openclawRoot = fixture.packageRoots.get("openclaw");
        expect(openclawRoot).toBeDefined();
        const manifestPath = path.join(openclawRoot!, "manifest.yaml");
        fs.writeFileSync(
          manifestPath,
          fs
            .readFileSync(manifestPath, "utf8")
            .replace("  owned_presets: []", `  owned_presets:\n    - ${channelId}`),
          { mode: 0o600 },
        );
        const presetDirectory = path.join(openclawRoot!, "policies", "presets");
        fs.mkdirSync(presetDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(presetDirectory, `${channelId}.yaml`),
          fs.readFileSync(
            path.join(
              process.cwd(),
              "packages/nemoclaw-openclaw/policies/presets",
              `${channelId}.yaml`,
            ),
            "utf8",
          ),
          { mode: 0o600 },
        );
        const installed = fixture.install("openclaw");
        vi.stubEnv("HOME", home);
        vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
        vi.stubEnv("NEMOCLAW_SKIP_TELEGRAM_REACHABILITY", "1");
        vi.stubEnv("TELEGRAM_BOT_TOKEN", "fresh-token");

        const providerName = `${sandboxName}-telegram-bridge`;
        const hasPriorProviderReceipt = providerCase === "existing";
        const priorPlan = makeMessagingPlan({
          sandboxName,
          channels: hasPriorProviderReceipt ? ["telegram"] : [],
          disabledChannels: hasPriorProviderReceipt ? ["telegram"] : [],
          agent: "openclaw",
          providerReceipts: hasPriorProviderReceipt
            ? [
                {
                  channelId: "telegram",
                  providerName,
                  providerId: `${providerName}-id`,
                  createdByNemoClaw: false,
                  attachmentAddedByNemoClaw: false,
                },
              ]
            : [],
        });
        const entry: registry.SandboxEntry = {
          name: sandboxName,
          agent: "openclaw",
          gatewayName: "nemoclaw",
          harnessPackage: installed.identity,
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "f".repeat(64),
          messaging: { schemaVersion: 1, plan: priorPlan },
        };
        vi.mocked(registry.getSandbox).mockReturnValue(entry);
        vi.mocked(registry.getHydratedMessagingPlanFromEntry).mockReturnValue(priorPlan);
        vi.spyOn(registry, "listSandboxes").mockReturnValue({
          sandboxes: [entry],
          defaultSandbox: sandboxName,
        });
        vi.spyOn(registry, "updateSandbox").mockReturnValue(failure !== "registry");
        authority = captureSandboxCommandAgentAuthority(entry);
        const originalPolicy = "version: 1\nnetwork_policies: {}\n";
        policyContext = contextWithPolicy(originalPolicy);
        let livePolicy = originalPolicy;
        let policySubmission = 0;
        const policySubmissionOutcomes = {
          attach: ["accept"],
          "bound-policy": ["accept", "reject"],
          "provider-upsert": ["accept"],
          "setter-throw": ["accept", "throw"],
          registry: ["accept", "accept"],
        } as const;
        const applyPolicySubmissionOutcome = {
          accept: () => true,
          reject: () => false,
          throw: (): boolean => {
            throw new Error("synthetic setter threw after mutation");
          },
        } as const;
        vi.mocked(policies.inspectPolicyMutationContext).mockImplementation(() =>
          contextWithPolicy(livePolicy),
        );
        vi.mocked(policies.setPolicyDocument)
          .mockReset()
          .mockImplementation((_sandbox, desiredPolicy) => {
            policySubmission += 1;
            livePolicy = desiredPolicy;
            const outcome = policySubmissionOutcomes[failure][policySubmission - 1] ?? "accept";
            return applyPolicySubmissionOutcome[outcome]();
          });
        const legacyPresetLoad = vi.spyOn(policies, "loadPresetForSandbox");
        const legacyPresetApply = vi.spyOn(policies, "applyPreset");
        const legacyPresetRemove = vi.spyOn(policies, "removePreset");
        vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
        vi.spyOn(credentialStore, "getCredential").mockImplementation(
          (key) => process.env[key] ?? null,
        );
        vi.spyOn(credentialStore, "saveCredential").mockImplementation(() => undefined);
        vi.spyOn(credentialStore, "deleteCredential").mockReturnValue(true);
        vi.spyOn(policyContextRefresh, "refreshSandboxPolicyContextFile").mockReturnValue({
          outcome: "ok",
          written: true,
        });
        vi.spyOn(policyChannelDependencies, "revalidateChannelProviderPolicy").mockImplementation(
          () => undefined,
        );
        const providerNames = channelId === "telegram" ? [providerName] : [];
        const createdProviderNames = [
          "created",
          "collision",
          "indeterminate",
          "identity-drift",
        ].includes(providerCase)
          ? providerNames
          : [];
        const providerUpsert = vi
          .spyOn(policyChannelDependencies, "upsertMessagingProviders")
          .mockImplementation((_definitions, _gatewayName, options) => {
            const throwProviderMutationFailure = (): never => {
              throw Object.assign(new Error("transport failed after provider mutation"), {
                code: "NEMOCLAW_MESSAGING_PROVIDER_MUTATION_FAILURE",
                createdProviderNames,
                mutatedProviderNames: providerNames,
                providerIds: Object.fromEntries(providerNames.map((name) => [name, `${name}-id`])),
              });
            };
            const recordProviderMutation = () => {
              options?.recordMutationReceipt?.({
                createdProviderNames,
                mutatedProviderNames:
                  providerCase === "existing" ? providerNames : createdProviderNames,
                providerNames,
                providerIds: Object.fromEntries(providerNames.map((name) => [name, `${name}-id`])),
              });
              return providerNames;
            };
            return failure === "provider-upsert"
              ? throwProviderMutationFailure()
              : recordProviderMutation();
          });
        let targetInspectionCount = 0;
        vi.spyOn(
          policyChannelDependencies,
          "inspectMessagingProviderAttachmentTarget",
        ).mockImplementation(() => {
          targetInspectionCount += 1;
          const changedBeforePolicy =
            providerCase === "policy-identity-drift" && targetInspectionCount >= 2;
          const changedAfterPolicy =
            providerCase === "identity-drift" && targetInspectionCount >= 4;
          return changedBeforePolicy || changedAfterPolicy ? "0".repeat(64) : "f".repeat(64);
        });
        let providerDeleted = false;
        let providerAttached = false;
        vi.spyOn(policyChannelDependencies, "inspectMessagingProviderBinding").mockImplementation(
          () =>
            providerCase === "collision"
              ? { kind: "collision" }
              : providerCase === "indeterminate"
                ? { kind: "indeterminate" }
                : providerDeleted
                  ? { kind: "missing" }
                  : { kind: "exact" },
        );
        vi.spyOn(policyChannelDependencies, "inspectMessagingProviderMetadata").mockImplementation(
          (name) =>
            providerDeleted
              ? null
              : {
                  id: `${name}-id`,
                  name,
                  type: "nemoclaw-mcp-v1",
                  credentialKeys: ["TELEGRAM_BOT_TOKEN"],
                  configKeys: [],
                },
        );
        vi.spyOn(
          policyChannelDependencies,
          "inspectMessagingProviderAttachments",
        ).mockImplementation(() =>
          providerAttached
            ? [
                {
                  name: providerName,
                  providerId: `${providerName}-id`,
                  credentialKeys: ["TELEGRAM_BOT_TOKEN"],
                },
              ]
            : [],
        );
        vi.spyOn(policyChannelDependencies, "runOpenshell").mockImplementation(
          () =>
            ({
              status: failure === "attach" ? 1 : ((providerAttached = true), 0),
              stdout: "",
              stderr: failure === "attach" ? "transport failed after attach" : "",
            }) as never,
        );
        const detachProvider = vi
          .spyOn(policyChannelDependencies, "runGatewayOpenshell")
          .mockImplementation(() => {
            providerAttached = false;
            return { status: 0, stdout: "", stderr: "" } as never;
          });
        const deleteProvider = vi
          .spyOn(policyChannelDependencies, "deleteMessagingProviderWithRecovery")
          .mockImplementation(() => {
            providerDeleted = true;
            return { ok: true, status: 0, stdout: "", stderr: "" } as never;
          });
        vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
          recovered: true,
          attempted: false,
          before: {
            state: "healthy_named",
            status: "",
            gatewayInfo: "",
            activeGateway: "nemoclaw",
          },
          after: { state: "healthy_named", status: "", gatewayInfo: "", activeGateway: "nemoclaw" },
        });
        vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        await expect(addSandboxChannel(sandboxName, { channel: channelId })).rejects.toThrow(
          "process.exit(1)",
        );

        expect(policies.setPolicyDocument).toHaveBeenCalledTimes(expectedPolicySets);
        expect(isDeepStrictEqual(YAML.parse(livePolicy), YAML.parse(originalPolicy))).toBe(
          providerCase !== "identity-drift",
        );
        expect(legacyPresetLoad).not.toHaveBeenCalled();
        expect(legacyPresetApply).not.toHaveBeenCalled();
        expect(legacyPresetRemove).not.toHaveBeenCalled();
        expect(detachProvider).toHaveBeenCalledTimes(expectedDetaches);
        expect(deleteProvider).toHaveBeenCalledTimes(expectedDeletes);
        expect(
          providerCase !== "policy-identity-drift" || providerUpsert.mock.calls.length === 0,
        ).toBe(true);
        expect(
          providerCase !== "policy-identity-drift" ||
            vi.mocked(registry.updateSandbox).mock.calls.length === 0,
        ).toBe(true);
        const diagnostics = vi.mocked(console.error).mock.calls.flat().join("\n");
        expect(
          diagnostics.includes("Receipt-backed network policy rollback remains incomplete"),
        ).toBe(providerCase === "identity-drift");
        const expectedProviderResidualDiagnostic =
          providerCase === "existing" && failure !== "provider-upsert"
            ? failure === "registry"
              ? "gateway-providers"
              : "Partial provider state may remain"
            : null;
        expect(
          expectedProviderResidualDiagnostic === null ||
            diagnostics.includes(expectedProviderResidualDiagnostic),
        ).toBe(true);
      } finally {
        fixture.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
