// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { printLegacyHermesGatewayRestoreHint } from "./snapshot-hermes-gateway-hint";

describe("printLegacyHermesGatewayRestoreHint (#7312)", () => {
  it("recommends a gateway restart for a no-receipt legacy Hermes sandbox", () => {
    const writeLine = vi.fn();

    printLegacyHermesGatewayRestoreHint(
      "clone-test",
      { agent: "hermes" },
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine.mock.calls[0][0]).toContain("clone-test gateway restart");
  });

  it("does not apply the legacy hint to a receipt-backed package with the Hermes id", () => {
    const writeLine = vi.fn();

    printLegacyHermesGatewayRestoreHint(
      "clone-test",
      {
        agent: "hermes",
        harnessPackage: {
          id: "hermes",
          packageVersion: "1.0.0",
          contentDigest: "a".repeat(64),
        },
      },
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });

  it("does not print a restart hint for non-database Hermes state files", () => {
    const writeLine = vi.fn();

    printLegacyHermesGatewayRestoreHint(
      "clone-test",
      { agent: "hermes" },
      ["SOUL.md"],
      [
        { path: "SOUL.md", strategy: "copy" },
        { path: "runtime/state.db", strategy: "sqlite_backup" },
      ],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });

  it("does not print a Hermes restart hint for other agents", () => {
    const writeLine = vi.fn();

    printLegacyHermesGatewayRestoreHint(
      "clone-test",
      { agent: "openclaw" },
      ["openclaw.json"],
      [{ path: "openclaw.json", strategy: "copy" }],
      "nemoclaw",
      writeLine,
    );
    printLegacyHermesGatewayRestoreHint(
      "clone-test",
      {},
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });
});
