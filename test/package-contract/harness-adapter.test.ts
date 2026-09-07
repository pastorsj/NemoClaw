// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessMcpAdapterCommandPlan } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadHarnessAdapter } from "../../dist/lib/agent-runtime/adapter/loader.js";
import { HARNESS_CONFIG_ADAPTER_CONTRACT } from "../../dist/lib/agent-runtime/adapter/config.js";
import { HARNESS_MCP_ADAPTER_CONTRACT } from "../../dist/lib/agent-runtime/adapter/mcp.js";
import { installHarnessPackage } from "../../dist/lib/agent-runtime/package/install.js";
import { loadHarnessStartupProfileAdapterHostModule } from "../../dist/lib/agent-runtime/startup-module.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const COMPILED_HARNESS_ROOT = path.join(REPOSITORY_ROOT, "dist", "harnesses");
const COMPILED_PACKAGE_IDS = fs
  .readdirSync(COMPILED_HARNESS_ROOT, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.startsWith("nemoclaw-") &&
      fs.existsSync(path.join(COMPILED_HARNESS_ROOT, entry.name, "nemoclaw-package.json")),
  )
  .map((entry) => entry.name.slice("nemoclaw-".length))
  .sort();
const COMPILED_MCP_PACKAGE_IDS = COMPILED_PACKAGE_IDS.filter((packageId) => {
  const packageRoot = path.join(COMPILED_HARNESS_ROOT, `nemoclaw-${packageId}`);
  const envelope = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "nemoclaw-package.json"), "utf8"),
  ) as { manifest: string };
  const manifest = YAML.parse(
    fs.readFileSync(path.join(packageRoot, envelope.manifest), "utf8"),
  ) as {
    mcp?: { support?: string };
  };
  return manifest.mcp?.support === "bridge";
});
const TEST_PARENT = path.join(
  REPOSITORY_ROOT,
  "node_modules/.cache/nemoclaw-package-contract-adapter",
);
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "e".repeat(40),
  }),
});

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });
fs.chmodSync(TEST_PARENT, 0o700);

function expectNonEmptyMcpCommandPlan(command: HarnessMcpAdapterCommandPlan): void {
  expect(command.kind === "argv" ? command.argv.length : command.script.length).toBeGreaterThan(0);
  expect(command.kind === "argv" || command.shellTrust === "package-authored-code").toBe(true);
}

describe("compiled harness adapter boundary", () => {
  it.each(COMPILED_MCP_PACKAGE_IDS)(
    "loads %s MCP bridge through the same typed contract",
    (packageId) => {
      const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
      fs.chmodSync(fixtureRoot, 0o700);
      const storeRoot = path.join(fixtureRoot, "store");
      try {
        fs.mkdirSync(storeRoot, { mode: 0o700 });
        const packageRoot = path.join(
          REPOSITORY_ROOT,
          "dist",
          "harnesses",
          `nemoclaw-${packageId}`,
        );
        const installed = installHarnessPackage(
          { packageRoot, sourceIdentity: SOURCE_IDENTITY },
          { storeRoot },
        );
        const mcp = installed.packageManifest.manifest.mcp as
          | { readonly support?: unknown }
          | undefined;
        expect(mcp?.support).toBe("bridge");
        const adapter = loadHarnessAdapter(installed.identity, HARNESS_MCP_ADAPTER_CONTRACT, {
          storeRoot,
        });
        const entry = {
          server: "docs",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer openshell-placeholder" },
        };
        const registrationPlan = adapter.register({
          entry,
          managedEntries: [],
          replaceExisting: false,
          teardownRollback: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const removalPlan = adapter.remove({
          entry,
          force: false,
          adaptiveTeardown: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const inspectCommand = adapter.inspect({
          entry,
          failOnMismatch: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const mutationCapability = adapter.mutationCapability({ sandboxName: "contract-test" });
        const teardownCapability = adapter.teardownCapability({ sandboxName: "contract-test" });
        const runtimeIntent = (
          adapter as typeof adapter & {
            verifyRuntimeIntent(request: {
              entries: (typeof entry)[];
              managedServerNames: string[];
            }): { kind: string };
          }
        ).verifyRuntimeIntent({ entries: [entry], managedServerNames: [entry.server] });
        const runtimeCommand = adapter.runtime({ command: ["node", "probe.mjs"] });

        expectNonEmptyMcpCommandPlan(registrationPlan.execution.command);
        expect(Object.isFrozen(registrationPlan)).toBe(true);
        expectNonEmptyMcpCommandPlan(removalPlan.execution.command);
        expect(Object.isFrozen(removalPlan)).toBe(true);
        expectNonEmptyMcpCommandPlan(inspectCommand);
        expect(Object.isFrozen(mutationCapability)).toBe(true);
        expect(["command", "not-required"]).toContain(mutationCapability.kind);
        expect(Object.isFrozen(teardownCapability)).toBe(true);
        expect(["command", "not-required"]).toContain(teardownCapability.kind);
        expect(Object.isFrozen(runtimeIntent)).toBe(true);
        expect(["command", "not-required"]).toContain(runtimeIntent.kind);
        expect(runtimeCommand.command.length).toBeGreaterThan(0);
        expect(Array.isArray(runtimeCommand.environmentVariablesToRemove)).toBe(true);
        expect(Object.isFrozen(runtimeCommand)).toBe(true);
        expect(Object.keys(adapter).sort()).toEqual(
          Object.keys(HARNESS_MCP_ADAPTER_CONTRACT.operations).sort(),
        );
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("discovers at least one compiled MCP bridge declaration", () => {
    expect(COMPILED_MCP_PACKAGE_IDS.length).toBeGreaterThan(0);
  });

  it("prepares OpenClaw startup through its receipt-pinned VM adapter", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "startup-fixture-"));
    fs.chmodSync(fixtureRoot, 0o700);
    const storeRoot = path.join(fixtureRoot, "store");
    try {
      fs.mkdirSync(storeRoot, { mode: 0o700 });
      const installed = installHarnessPackage(
        {
          packageRoot: path.join(COMPILED_HARNESS_ROOT, "nemoclaw-openclaw"),
          sourceIdentity: SOURCE_IDENTITY,
        },
        { storeRoot },
      );
      const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });
      const result = adapter.prepareStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        phase: "initial",
        previousDesiredState: null,
        input: {
          inference: {
            selectedProvider: "nvidia-prod",
            model: "nvidia/test-model",
            endpointUrl: null,
            resolvedContextWindow: null,
            reasoningEnabled: null,
            reasoningEffort: null,
            candidates: [
              {
                requestedApi: null,
                routeProvider: "inference",
                routedBaseUrl: "https://inference.local/v1",
                api: "openai-completions",
                primaryModelRef: "inference/nvidia/test-model",
                compatibility: null,
              },
            ],
          },
          dashboard: {
            managed: true,
            url: "http://127.0.0.1:18789",
            port: 18_789,
            bindAddress: null,
            wslExposure: false,
            forwarding: { enabled: false, publicPort: null, internalPort: null, tuiEnabled: false },
          },
          webSearch: null,
          tools: { disclosure: "progressive", enabledGateways: [] },
          messagingPlan: null,
          approvalMode: "disabled",
          observabilityEnabled: false,
          proxy: {
            managedHost: "host.openshell.internal",
            managedPort: 3128,
            hostHttpUrl: null,
            hostHttpsUrl: null,
            hostNoProxy: [],
          },
          environment: {},
          corporateCa: { bundleSha256: null },
          credentialProxyPresent: false,
        },
      });

      expect(result).toMatchObject({
        kind: "prepared",
        desiredState: {
          configuration: { agent: "openclaw" },
          dashboard: { mode: "loopback" },
        },
      });
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(COMPILED_PACKAGE_IDS)(
    "loads %s configuration through the same compiled contract",
    (id) => {
      const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
      fs.chmodSync(fixtureRoot, 0o700);
      const storeRoot = path.join(fixtureRoot, "store");
      try {
        fs.mkdirSync(storeRoot, { mode: 0o700 });
        const packageRoot = path.join(REPOSITORY_ROOT, "dist", "harnesses", `nemoclaw-${id}`);
        const installed = installHarnessPackage(
          { packageRoot, sourceIdentity: SOURCE_IDENTITY },
          { storeRoot },
        );
        const adapter = loadHarnessAdapter(installed.identity, HARNESS_CONFIG_ADAPTER_CONTRACT, {
          storeRoot,
        });
        const config = installed.packageManifest.manifest.config as Record<string, unknown>;
        const configTarget = {
          directory: String(config.dir),
          file: String(config.config_file),
          format: String(config.format),
          sensitiveFiles: [],
        };
        const inference = adapter.describeInference({ target: configTarget });
        const urlPolicy = adapter.classifyUrl({
          config: {},
          key: "model.endpoint",
          relativePath: [],
        });
        const mutable = adapter.describeMutable({
          target: configTarget,
          sandboxUid: null,
          sandboxGid: null,
        });

        expect(["mutable", "unsupported"]).toContain(inference.kind);
        expect(urlPolicy).toMatchObject({
          allowPrivateUrls: expect.any(Boolean),
          allowOpenShellBridge: expect.any(Boolean),
        });
        expect(["stat", "probe", "not-required"]).toContain(mutable.kind);
        expect(Object.isFrozen(inference)).toBe(true);
        expect(Object.isFrozen(mutable)).toBe(true);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("publishes the adapter declarations", () => {
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/loader.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/mcp.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/config.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/contract.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/schema.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/config-module.d.ts")),
    ).toBe(true);
  });
});
