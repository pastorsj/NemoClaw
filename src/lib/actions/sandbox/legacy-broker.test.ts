// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { ensureLegacyHermesToolBroker } from "./legacy-broker";

function brokerEntry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    hermesToolGateways: ["managed-tool"],
    ...overrides,
  } as SandboxEntry;
}

describe("legacy interactive Hermes tool broker", () => {
  it("does not load native broker behavior for a synthetic package receipt", () => {
    const ensureBroker = vi.fn();
    const loadBroker = vi.fn(() => ({
      ensureHermesToolGatewayBrokerForSandboxEntry: ensureBroker,
    }));
    const entry = brokerEntry({
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0",
        contentDigest: "a".repeat(64),
      },
    });

    ensureLegacyHermesToolBroker(entry, loadBroker);

    expect(loadBroker).not.toHaveBeenCalled();
    expect(ensureBroker).not.toHaveBeenCalled();
  });

  it("does not load native broker behavior for a migrated package authority", () => {
    const loadBroker = vi.fn();
    const entry = brokerEntry({
      harnessPackageMigration: {
        schemaVersion: 1,
        source: "legacy-current-bundle",
        legacyAgent: "hermes",
        migratedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    ensureLegacyHermesToolBroker(entry, loadBroker);

    expect(loadBroker).not.toHaveBeenCalled();
  });

  it("preserves the broker for a matching no-receipt sandbox", () => {
    const ensureBroker = vi.fn();
    const loadBroker = vi.fn(() => ({
      ensureHermesToolGatewayBrokerForSandboxEntry: ensureBroker,
    }));
    const entry = brokerEntry();

    ensureLegacyHermesToolBroker(entry, loadBroker);

    expect(loadBroker).toHaveBeenCalledOnce();
    expect(ensureBroker).toHaveBeenCalledWith(entry);
  });

  it("keeps a legacy broker failure non-fatal", () => {
    const loadBroker = vi.fn(() => {
      throw new Error("broker unavailable");
    });

    expect(() => ensureLegacyHermesToolBroker(brokerEntry(), loadBroker)).not.toThrow();
  });
});
