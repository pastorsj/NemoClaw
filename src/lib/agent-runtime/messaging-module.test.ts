// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelManifestRegistry } from "../messaging/manifest/registry";
import {
  HarnessMessagingSupportError,
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
} from "../messaging/profile-authority";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";
import { HarnessMessagingModuleError, loadHarnessMessagingIntegration } from "./messaging-module";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-messaging-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  }),
});
const VALID_MODULE = `
module.exports = {
  describeMessagingIntegration(request) {
    return {
      kind: "channels",
      packageId: request.packageId,
      channelIds: ["future-channel"],
    };
  },
};
`;

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writeFuturePackage(
  moduleSource = VALID_MODULE,
  messagingDeclaration = "  support: channels\n  channels:\n    - future-channel",
): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      manifest: "packages/nemoclaw-future-harness/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/manifest.yaml",
    `name: future-harness\ndisplay_name: Future Harness\nmessaging:\n${messagingDeclaration}\n`,
  );
  writeFixtureFile("runtime/payload.txt", "future runtime\n");
  writeFixtureFile("packages/nemoclaw-future-harness/host/messaging-adapter.cts", moduleSource);
}

function installFuturePackage(
  moduleSource = VALID_MODULE,
  messagingDeclaration?: string,
): InstalledHarnessPackage {
  writeFuturePackage(moduleSource, messagingDeclaration);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function installFuturePackageWithoutAdapter(): InstalledHarnessPackage {
  writeFuturePackage();
  fs.rmSync(path.join(sourceRoot, "packages/nemoclaw-future-harness/host/messaging-adapter.cts"));
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function futureChannelService(supportedAgents: readonly string[] = ["future-harness"]) {
  return {
    schemaVersion: 1 as const,
    id: "future-channel",
    displayName: "Future Channel",
    supportedAgents,
    auth: { mode: "none" as const },
    inputs: [],
    credentials: [],
    render: [],
    hooks: [],
  };
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness messaging module", () => {
  it("loads a synthetic package through the fixed typed profile", () => {
    const installed = installFuturePackage();

    expect(loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toEqual({
      kind: "channels",
      packageId: "future-harness",
      channelIds: ["future-channel"],
    });
  });

  it("resolves an unknown package id without a core package dispatch table", () => {
    const installed = installFuturePackage();
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const registry = new ChannelManifestRegistry([futureChannelService() as never]);

    expect(authority.agent.name).toBe("future-harness");
    expect(authority.packageAuthority.harnessPackage).toEqual(installed.identity);
    expect(listMessagingChannelsForProfile(authority, registry).map(({ id }) => id)).toEqual([
      "future-channel",
    ]);
  });

  it("returns a typed disabled profile without inventing channel behavior", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return { kind: "disabled", packageId: request.packageId, reason: "No bridge." };
        },
      };`,
      "  support: disabled",
    );
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );

    expect(authority.integration).toEqual({
      kind: "disabled",
      packageId: "future-harness",
      reason: "No bridge.",
    });
    expect(listMessagingChannelsForProfile(authority, new ChannelManifestRegistry())).toEqual([]);
  });

  it("rejects a package channel without a compatible core service", () => {
    const installed = installFuturePackage();
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const registry = new ChannelManifestRegistry([
      futureChannelService(["other-harness"]) as never,
    ]);

    expect(() => listMessagingChannelsForProfile(authority, registry)).toThrow(
      HarnessMessagingSupportError,
    );
  });

  it("rejects an adapter result for a different package id", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration() {
          return { kind: "channels", packageId: "other-harness", channelIds: ["future-channel"] };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /does not match its package identity/u,
    );
  });

  it("rejects disagreement between the manifest and adapter channel lists", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return { kind: "channels", packageId: request.packageId, channelIds: ["other-channel"] };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /does not match its manifest declaration/u,
    );
  });

  it("rejects credential-shaped fields at the static adapter boundary", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return {
            kind: "channels",
            packageId: request.packageId,
            channelIds: ["future-channel"],
            token: "not-allowed",
          };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /returned an invalid messaging integration/u,
    );
  });

  it("rejects a missing fixed adapter before package support can be used", () => {
    const installed = installFuturePackageWithoutAdapter();

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      HarnessMessagingModuleError,
    );
  });

  it("rejects adapter bytes that no longer match the package receipt", () => {
    const installed = installFuturePackage();
    fs.appendFileSync(
      path.join(
        installed.packageRoot,
        "packages/nemoclaw-future-harness/host/messaging-adapter.cts",
      ),
      "\n",
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /integrity validation/u,
    );
  });
});
