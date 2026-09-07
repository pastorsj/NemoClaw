// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";
import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
  runOnboardProcess,
  testRepoRoot,
  trailingJsonPayload,
} from "../helpers/onboard-child-process-harness";
import { onboardScriptMocksPath } from "../helpers/onboard-split-context";

const onboardPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "onboard.ts"));
const runnerPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "runner.ts"));
const registryPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "state", "registry.ts"));
const defsPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "agent", "defs.ts"));

describe("onboard sandbox create intent boundary", () => {
  it(
    "rejects stale credential capabilities before real create mutations (#6226)",
    {
      timeout: 60_000,
    },
    () => {
      const workspace = createOnboardProcessWorkspace("nemoclaw-intent-boundary-");
      try {
        const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const mutations = [];

const runStub = (command) => {
  mutations.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0 };
};
runner.run = runStub;
runner.runCapture = () => "";
const removeSandboxStub = (name) => { mutations.push("registry remove " + name); };
const updateSandboxStub = (name) => { mutations.push("registry update " + name); };
const registerSandboxStub = (entry) => { mutations.push("registry register " + entry.name); };
registry.removeSandbox = removeSandboxStub;
registry.updateSandbox = updateSandboxStub;
registry.registerSandbox = registerSandboxStub;
childProcess.spawn = () => { throw new Error("unexpected sandbox create"); };
if (runner.run !== runStub || registry.removeSandbox !== removeSandboxStub || registry.updateSandbox !== updateSandboxStub || registry.registerSandbox !== registerSandboxStub) {
  throw new Error("onboard mutation stubs were not installed");
}

const { createSandbox } = require(${onboardPath});
const resolved = {
  sandboxName: "my-assistant",
  activeMessagingChannels: [],
  messagingProviderRequests: [{
    name: "my-assistant-extra-telegram-bot-token-agent-a",
    envKey: "TELEGRAM_BOT_TOKEN_AGENT_A",
    providerType: "generic",
    credentialConfigured: true,
    channel: null,
  }],
  reusableMessagingProviders: [],
  extraProviders: [],
  staleExtraProviders: [],
  hermesToolGateways: [],
  policy: {
    basePolicyPath: "/unused/policy.yaml",
    activeMessagingChannels: [],
    options: { directGpu: false, additionalPresets: [], policyTier: null },
  },
  gpuCreateArgs: [],
  resourceCreateArgs: [],
  gpuRoutePlan: "none",
  sandboxGpuLogMessage: null,
  disabledChannelNames: [],
  extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
};

(async () => {
  try {
    await createSandbox(
      null,
      "gpt-5.4",
      "nvidia-prod",
      null,
      "my-assistant",
      null,
      [],
      null,
      null,
      null,
      null,
      null,
      [],
      null,
      null,
      {
        resolved,
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        extraProviders: [],
      },
    );
    throw new Error("create unexpectedly succeeded");
  } catch (error) {
    console.log(JSON.stringify({ error: String(error.message || error), mutations }));
  }
})();
`;
        const scriptPath = workspace.path("stale-binding.js");
        fs.writeFileSync(scriptPath, script);

        const result = runOnboardProcess(
          ["--require", JSON.parse(onboardScriptMocksPath), scriptPath],
          {
            env: minimalSpawnEnv(fs.realpathSync(workspace.homeDir), {
              TMPDIR: fs.realpathSync(workspace.root),
              NEMOCLAW_NON_INTERACTIVE: "1",
              NEMOCLAW_RECREATE_SANDBOX: "1",
              NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
            }),
            timeoutMs: 55_000,
          },
        );

        assert.equal(result.status, 0, result.stderr);
        const payload = trailingJsonPayload(result.stdout) as {
          error: string;
          mutations: string[];
        };
        assert.match(payload.error, /missing credential binding|credential binding set changed/);
        assert.deepEqual(payload.mutations, []);
      } finally {
        workspace.remove();
      }
    },
  );

  it(
    "refuses a selected bridge channel with no usable provider before deleting the sandbox",
    {
      timeout: 60_000,
    },
    () => {
      // Without the source secret there is nothing to mint for the selected
      // bridge channel. That has to stop the recreate before the delete.
      const workspace = createOnboardProcessWorkspace("nemoclaw-bridge-boundary-");
      try {
        const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const defs = require(${defsPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const childProcess = require("node:child_process");
const record = (text) => { console.log("CMD " + text); return text; };
const existingHarness = fixtureMocks.installOnboardProcessHarnessPackage("hermes");
const sourceEntry = {
  name: "my-assistant",
  dashboardPort: 18789,
  secondaryForwardPort: 8642,
  ...existingHarness.registryAuthority,
};
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  agentName: "hermes",
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  sourceEntry,
});

runner.run = (command) => {
  record(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0, stdout: "" };
};
runner.runCapture = (command) => {
  record(Array.isArray(command) ? command.join(" ") : String(command));
  return "";
};
registry.getSandbox = () => sourceEntry;
registry.removeSandbox = (name) => { record("registry remove " + name); };
registry.updateSandbox = (name) => { record("registry update " + name); };
registry.registerSandbox = (entry) => { record("registry register " + entry.name); };
childProcess.spawn = () => { throw new Error("unexpected sandbox create"); };

const { createSandbox } = require(${onboardPath});
const resolved = {
  sandboxName: "my-assistant",
  inferenceProvider: "nvidia-prod",
  activeMessagingChannels: ["googlechat"],
  messagingProviderRequests: [{
    name: "my-assistant-googlechat-bridge",
    envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
    providerType: "google-chat-hermes-bridge",
    credentialConfigured: false,
    channel: "googlechat",
  }],
  reusableMessagingProviders: [],
  extraProviders: [],
  staleExtraProviders: [],
  hermesToolGateways: [],
  policy: {
    basePolicyPath: "/unused/policy.yaml",
    activeMessagingChannels: ["googlechat"],
    options: { directGpu: false, additionalPresets: [], policyTier: null },
  },
  gpuCreateArgs: [],
  resourceCreateArgs: [],
  gpuRoutePlan: "none",
  sandboxGpuLogMessage: null,
  disabledChannelNames: [],
  extraPlaceholderKeys: ["GOOGLE_CHAT_ACCESS_TOKEN"],
};

(async () => {
  try {
    await createSandbox(
      ...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
        [
          null,
          "gpt-5.4",
          "nvidia-prod",
          null,
          "my-assistant",
          null,
          ["googlechat"],
          null,
          defs.loadAgent("hermes"),
          null,
          null,
          null,
          [],
          null,
          null,
          {
            resolved,
            recreate: true,
            toolDisclosure: "progressive",
            observabilityEnabled: false,
            extraProviders: [],
          },
        ],
        createFixture,
      ),
    );
    console.log("CREATE-RETURNED");
  } catch (error) {
    console.log("CREATE-THREW " + String(error.message || error));
  }
})();
`;
        const scriptPath = workspace.path("stale-bridge.js");
        fs.writeFileSync(scriptPath, script);
        // Keep the binary resolver on the controlled local boundary.
        const openshellStub = workspace.writeExecutable("openshell", "#!/bin/sh\nexit 0\n");

        const result = runOnboardProcess(
          ["--require", JSON.parse(onboardScriptMocksPath), scriptPath],
          {
            env: minimalSpawnEnv(fs.realpathSync(workspace.homeDir), {
              TMPDIR: fs.realpathSync(workspace.root),
              NEMOCLAW_NON_INTERACTIVE: "1",
              NEMOCLAW_RECREATE_SANDBOX: "1",
              NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
              NEMOCLAW_OPENSHELL_BIN: openshellStub,
            }),
            timeoutMs: 55_000,
          },
        );

        const output = result.output;
        assert.equal(result.error, undefined, output);
        assert.equal(result.signal, null, output);
        assert.equal(result.status, 0, output);
        assert.doesNotMatch(output, /CREATE-RETURNED/, output);
        assert.match(output, /CREATE-THREW.*GOOGLE_CHAT_ACCESS_TOKEN/, output);

        // Commands are read from the log the child emits as each one is issued.
        // Nothing may mutate before the refusal.
        const issued = output
          .split(String.fromCharCode(10))
          .filter((line) => line.startsWith("CMD "));
        const mutating = issued.filter((line) =>
          /sandbox delete|sandbox provider (?:attach|detach)|provider (?:create|update|delete)|registry (?:remove|update|register)/.test(
            line,
          ),
        );
        assert.deepEqual(mutating, [], output);
      } finally {
        workspace.remove();
      }
    },
  );
});
