// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  AvailableHarnessPackageRecord,
  DamagedInstalledHarnessPackageRecord,
  HarnessPackageInventory,
  HealthyInstalledHarnessPackageRecord,
} from "./catalog";
import {
  createHarnessInventoryView,
  parseHarnessInventoryJson,
  renderHarnessInventoryJson,
  renderHarnessInventoryText,
} from "./inventory";
import type { HarnessPackageIdentity } from "./types";

const OPENCLAW_DIGEST = "a".repeat(64);
const HERMES_DIGEST = "b".repeat(64);
const OLDER_DIGEST = "c".repeat(64);

function packageIdentity(
  id: string,
  packageVersion: string,
  contentDigest: string,
): HarnessPackageIdentity {
  return { kind: "agent-runtime", id, packageVersion, contentDigest };
}

function availablePackage(
  id: string,
  displayName: string,
  packageVersion: string,
  contentDigest: string,
): AvailableHarnessPackageRecord {
  return {
    state: "available",
    id,
    displayName,
    description: "NVIDIA_API_KEY=must-not-render",
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    identity: packageIdentity(id, packageVersion, contentDigest),
    packageRoot: `/private/reviewed/${id}`,
  };
}

function healthyPackage(
  id: string,
  displayName: string,
  packageVersion: string,
  contentDigest: string,
  matchesAvailableIdentity: boolean,
): HealthyInstalledHarnessPackageRecord {
  return {
    state: "installed",
    id,
    displayName,
    description: "OPENAI_API_KEY=must-not-render",
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    identity: packageIdentity(id, packageVersion, contentDigest),
    packageRoot: `/private/store/${id}`,
    matchesAvailableIdentity,
  };
}

function damagedPackage(id: string, displayName: string): DamagedInstalledHarnessPackageRecord {
  return {
    state: "damaged",
    id,
    displayName,
    description: "ANTHROPIC_API_KEY=must-not-render",
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    reason: "installed-package-integrity-failed",
  };
}

function createView(inventory: HarnessPackageInventory) {
  const listHarnessPackageInventory = vi.fn(() => inventory);
  const view = createHarnessInventoryView({ listHarnessPackageInventory });
  expect(listHarnessPackageInventory).toHaveBeenCalledOnce();
  return view;
}

const OPENCLAW_AVAILABLE = availablePackage("openclaw", "OpenClaw", "0.1.0", OPENCLAW_DIGEST);
const HERMES_AVAILABLE = availablePackage("hermes", "Hermes Agent", "0.2.0", HERMES_DIGEST);

describe("harness package inventory presentation", () => {
  it("reports no installed harnesses while retaining the reviewed available inventory", () => {
    const view = createView({ installed: [], available: [OPENCLAW_AVAILABLE] });
    const text = renderHarnessInventoryText(view);
    const json = renderHarnessInventoryJson(view);

    expect(text).toBe(
      [
        "Installed",
        "  No harnesses are installed.",
        "",
        "Available",
        "  openclaw | OpenClaw | adapter 0.1.0 | digest aaaaaaaaaaaa… | not installed",
      ].join("\n"),
    );
    expect(view.available[0]?.installationState).toBe("not-installed");
    expect(json).not.toContain("/private/");
    expect(json).not.toContain("must-not-render");
  });

  it("keeps one healthy harness in separate installed and available rows", () => {
    const view = createView({
      installed: [healthyPackage("openclaw", "OpenClaw", "0.1.0", OPENCLAW_DIGEST, true)],
      available: [OPENCLAW_AVAILABLE],
    });
    const text = renderHarnessInventoryText(view);

    expect(view.installed).toEqual([
      {
        id: "openclaw",
        displayName: "OpenClaw",
        health: "healthy",
        identity: packageIdentity("openclaw", "0.1.0", OPENCLAW_DIGEST),
      },
    ]);
    expect(view.available).toEqual([
      {
        displayName: "OpenClaw",
        identity: packageIdentity("openclaw", "0.1.0", OPENCLAW_DIGEST),
        installationState: "active",
      },
    ]);
    expect(parseHarnessInventoryJson(renderHarnessInventoryJson(view))).toEqual(view);
    expect(text).toContain("digest aaaaaaaaaaaa… | health healthy");
    expect(text).not.toContain(OPENCLAW_DIGEST);
  });

  it("renders an installed-only package without claiming bundled availability", () => {
    const view = createView({
      installed: [healthyPackage("future-harness", "Future Harness", "1.0.0", OLDER_DIGEST, false)],
      available: [OPENCLAW_AVAILABLE],
    });

    expect(view.installed).toEqual([
      {
        id: "future-harness",
        displayName: "Future Harness",
        health: "healthy",
        identity: packageIdentity("future-harness", "1.0.0", OLDER_DIGEST),
      },
    ]);
    expect(view.available).toHaveLength(1);
    expect(view.available[0]?.identity.id).toBe("openclaw");
    expect(renderHarnessInventoryText(view)).toContain("future-harness | Future Harness");
  });

  it("sorts multiple installed and available rows by canonical harness id", () => {
    const view = createView({
      installed: [
        healthyPackage("openclaw", "OpenClaw", "0.1.0", OPENCLAW_DIGEST, true),
        healthyPackage("hermes", "Hermes Agent", "0.2.0", HERMES_DIGEST, true),
      ],
      available: [OPENCLAW_AVAILABLE, HERMES_AVAILABLE],
    });

    expect(view.installed.map(({ id }) => id)).toEqual(["hermes", "openclaw"]);
    expect(view.available.map(({ identity }) => identity.id)).toEqual(["hermes", "openclaw"]);
  });

  it("reports that an older installed identity differs from the reviewed bundle", () => {
    const view = createView({
      installed: [healthyPackage("openclaw", "OpenClaw", "0.0.9", OLDER_DIGEST, false)],
      available: [OPENCLAW_AVAILABLE],
    });
    const text = renderHarnessInventoryText(view);

    expect(view.installed[0]?.identity).toEqual(packageIdentity("openclaw", "0.0.9", OLDER_DIGEST));
    expect(view.available[0]?.installationState).toBe("different");
    expect(text).toContain("installed identity differs");
  });

  it("reports damaged store state without substituting the bundled identity", () => {
    const view = createView({
      installed: [damagedPackage("openclaw", "OpenClaw")],
      available: [OPENCLAW_AVAILABLE],
    });
    const text = renderHarnessInventoryText(view);

    expect(view.installed).toEqual([
      { id: "openclaw", displayName: "OpenClaw", health: "damaged", identity: null },
    ]);
    expect(view.available[0]?.installationState).toBe("damaged");
    expect(text).toContain("damaged; installed identity could not be verified");
    expect(parseHarnessInventoryJson(renderHarnessInventoryJson(view))).toEqual(view);
  });

  it("filters terminal controls from catalogue display names", () => {
    const unsafeAvailable = availablePackage(
      "openclaw",
      "Open\u001b[31mClaw\nRuntime",
      "0.1.0",
      OPENCLAW_DIGEST,
    );
    const view = createView({ installed: [], available: [unsafeAvailable] });

    expect(view.available[0]?.displayName).toBe("OpenClaw Runtime");
    expect(renderHarnessInventoryText(view)).not.toContain("\u001b");
    expect(renderHarnessInventoryJson(view)).not.toContain("\\u001b");
  });

  it("rejects a machine identity that differs from its installed row", () => {
    const view = createView({
      installed: [healthyPackage("openclaw", "OpenClaw", "0.1.0", OPENCLAW_DIGEST, true)],
      available: [OPENCLAW_AVAILABLE],
    });
    const mismatched = renderHarnessInventoryJson(view).replace(
      '"id": "openclaw"',
      '"id": "other-runtime"',
    );

    expect(() => parseHarnessInventoryJson(mismatched)).toThrow(/does not match its row id/);
  });

  it.each([
    ["top-level", { unexpected: true }],
    ["installed row", { installedField: true }],
    ["available row", { availableField: true }],
    ["identity", { identityField: true }],
  ])("rejects an extra %s field in machine output", (_label, extra) => {
    const view = createView({
      installed: [healthyPackage("openclaw", "OpenClaw", "0.1.0", OPENCLAW_DIGEST, true)],
      available: [OPENCLAW_AVAILABLE],
    });
    const topLevel = { ...view, ...(_label === "top-level" ? extra : {}) };
    const installed = [
      {
        ...view.installed[0],
        ...(_label === "installed row" ? extra : {}),
        identity: {
          ...view.installed[0]?.identity,
          ...(_label === "identity" ? extra : {}),
        },
      },
    ];
    const available = [{ ...view.available[0], ...(_label === "available row" ? extra : {}) }];

    expect(() =>
      parseHarnessInventoryJson(JSON.stringify({ ...topLevel, installed, available })),
    ).toThrow(/fields do not match schema version 1/);
  });
});
