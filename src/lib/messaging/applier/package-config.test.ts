// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";
import type { MessagingOpenShellRunner } from "./types";

describe("receipt-backed messaging package config", () => {
  it("applies an unknown package render beneath its declared config root", async () => {
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "future-sandbox",
      agent: "future-harness",
      workflow: "onboard",
      packageBuild: {
        configRoot: "~/.future-harness",
        packageManagers: [],
        renderFinalizers: ["allow-rendered-plugins"],
      },
      channels: [
        {
          channelId: "future-channel",
          displayName: "Future channel",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [
        {
          channelId: "future-channel",
          agent: "future-harness",
          renderId: "future-config",
          target: "~/.future-harness/config.json",
          kind: "json-fragment",
          path: "plugins.entries.future-plugin",
          value: { enabled: true },
          templateRefs: [],
        },
      ],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const files: Record<string, string> = {};
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      const target = String(args.at(-1));
      const reading = args.includes("cat") && options?.input === undefined;
      const writeInput = () => {
        files[target] = options!.input!;
        return { status: 0 };
      };
      return reading
        ? { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" }
        : options?.input !== undefined
          ? writeInput()
          : { status: 1 };
    };

    const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

    const target = "/sandbox/.future-harness/config.json";
    expect(result.appliedTargets).toEqual([target]);
    expect(JSON.parse(files[target] ?? "{}")).toEqual({
      plugins: {
        entries: { "future-plugin": { enabled: true } },
        allow: ["future-plugin"],
      },
    });
  });

  it("rejects a package render outside its declared config root", async () => {
    const plan = {
      schemaVersion: 1,
      sandboxName: "future-sandbox",
      agent: "future-harness",
      workflow: "onboard",
      packageBuild: { configRoot: "~/.future-harness", packageManagers: [] },
      channels: [
        {
          channelId: "future-channel",
          displayName: "Future channel",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [
        {
          channelId: "future-channel",
          agent: "future-harness",
          renderId: "escaped-config",
          target: "~/.other-harness/config.json",
          kind: "json-fragment",
          path: "enabled",
          value: true,
          templateRefs: [],
        },
      ],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    } satisfies SandboxMessagingPlan;

    await expect(
      MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
        runOpenshell: () => ({ status: 1 }),
      }),
    ).rejects.toThrow("must stay inside ~/.future-harness");
  });
});
