// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HarnessPackageIdentity } from "../package/types";
import { HarnessAdapterError } from "./loader";
import {
  createHarnessPackageAdapterInitializationQualifier,
  HarnessAdapterQualificationError,
  listRequiredHarnessAdapterContracts,
} from "./qualification";

const IDENTITY: HarnessPackageIdentity = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

describe("harness adapter initialization qualification", () => {
  it("maps every fixed manifest surface without treating the provider controller as an adapter", () => {
    const contracts = listRequiredHarnessAdapterContracts({
      mcp: { support: "bridge" },
      agent_roster: { support: "managed" },
      sessions: { operations: [] },
      provider_auth: { support: "managed" },
      provider_broker: { support: "managed" },
      state_files: [{ path: "config.json", restore: { merge: "package-config" } }],
    });

    expect(contracts.map(({ displayName }) => displayName)).toEqual([
      "configuration adapter",
      "messaging adapter",
      "startup plan",
      "startup profile",
      "MCP adapter",
      "agent roster adapter",
      "session adapter",
      "provider-auth adapter",
      "provider-broker adapter",
      "configuration restore adapter",
    ]);
    expect(contracts.map(({ modulePath }) => modulePath)).not.toContain(
      "host/provider-broker-control.cts",
    );
  });

  it("initializes one package identity once after successful qualification", () => {
    const initializeAdapter = vi.fn();
    const qualify = createHarnessPackageAdapterInitializationQualifier({ initializeAdapter });

    qualify(IDENTITY, {});
    const initializationCount = initializeAdapter.mock.calls.length;
    qualify(IDENTITY, {});

    expect(initializationCount).toBeGreaterThan(0);
    expect(initializeAdapter).toHaveBeenCalledTimes(initializationCount);
  });

  it("retries a package identity after initialization fails", () => {
    const contracts = listRequiredHarnessAdapterContracts({});
    const initializeAdapter = vi
      .fn<(_identity: HarnessPackageIdentity, contract: (typeof contracts)[number]) => void>()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new HarnessAdapterError("synthetic initialization failure");
      });
    const qualify = createHarnessPackageAdapterInitializationQualifier({ initializeAdapter });

    expect(() => qualify(IDENTITY, {})).toThrow(HarnessAdapterQualificationError);
    expect(() => qualify(IDENTITY, {})).not.toThrow();
    expect(initializeAdapter).toHaveBeenCalledTimes(2 + contracts.length);
  });

  it("requalifies when the package version or content digest changes", () => {
    const initializeAdapter = vi.fn();
    const qualify = createHarnessPackageAdapterInitializationQualifier({ initializeAdapter });
    const contractsPerPackage = listRequiredHarnessAdapterContracts({}).length;
    const changedVersion: HarnessPackageIdentity = {
      ...IDENTITY,
      packageVersion: "1.0.1",
    };
    const changedDigest: HarnessPackageIdentity = {
      ...IDENTITY,
      contentDigest: "b".repeat(64),
    };

    qualify(IDENTITY, {});
    qualify(changedVersion, {});
    qualify(changedDigest, {});

    expect(initializeAdapter).toHaveBeenCalledTimes(contractsPerPackage * 3);
  });

  it("rejects changed contract selection for a qualified package identity", () => {
    const initializeAdapter = vi.fn();
    const qualify = createHarnessPackageAdapterInitializationQualifier({ initializeAdapter });

    qualify(IDENTITY, {});
    const initializationCount = initializeAdapter.mock.calls.length;

    expect(() =>
      qualify(IDENTITY, {
        mcp: { support: "bridge" },
      }),
    ).toThrow(/contract selection changed/u);
    expect(initializeAdapter).toHaveBeenCalledTimes(initializationCount);
  });
});
