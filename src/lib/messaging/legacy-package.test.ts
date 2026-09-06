// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  legacyHasManagedToolGateways,
  legacyUsesNpmPolicyCompatibility,
  legacyUsesTeamsOutlookSharedLogin,
} from "./legacy-package";

describe("pre-package messaging compatibility", () => {
  it("keeps historical behavior for no-receipt rows", () => {
    expect(legacyUsesTeamsOutlookSharedLogin({ agent: null })).toBe(true);
    expect(legacyUsesNpmPolicyCompatibility({ agent: "openclaw" })).toBe(true);
    expect(
      legacyHasManagedToolGateways({ agent: "hermes", hermesToolGateways: ["managed-tool"] }),
    ).toBe(true);
  });

  it.each([
    { harnessPackage: { id: "future-harness" } },
    { harnessPackageMigration: { source: "legacy-current-bundle" } },
  ])("rejects native behavior when package authority is present", (authority) => {
    const entry = {
      agent: "hermes",
      hermesToolGateways: ["managed-tool"],
      ...authority,
    };

    expect(legacyUsesTeamsOutlookSharedLogin(entry)).toBe(false);
    expect(legacyUsesNpmPolicyCompatibility(entry)).toBe(false);
    expect(legacyHasManagedToolGateways(entry)).toBe(false);
  });
});
