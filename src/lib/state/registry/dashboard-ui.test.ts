// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { cloneSandboxDashboardUiState } from "./dashboard-ui";
import { migrateLegacyDashboardUiState } from "./legacy-dashboard";

describe("sandbox package dashboard state", () => {
  it("accepts only the finite neutral persisted shape", () => {
    expect(
      cloneSandboxDashboardUiState(
        { enabled: true, publicPort: 9_120, internalPort: 19_120, tuiEnabled: false },
        "load",
      ),
    ).toEqual({ enabled: true, publicPort: 9_120, internalPort: 19_120, tuiEnabled: false });
    expect(() =>
      cloneSandboxDashboardUiState(
        {
          enabled: true,
          publicPort: 9_120,
          internalPort: 19_120,
          tuiEnabled: false,
          packageHook: "run",
        },
        "load",
      ),
    ).toThrow(/invalid package dashboard state/u);
  });

  it("migrates old receipt rows without selecting a package ID", () => {
    expect(
      migrateLegacyDashboardUiState({
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9_120,
        hermesDashboardInternalPort: 19_120,
        hermesDashboardTui: true,
      }),
    ).toEqual({ enabled: true, publicPort: 9_120, internalPort: 19_120, tuiEnabled: true });
  });
});
