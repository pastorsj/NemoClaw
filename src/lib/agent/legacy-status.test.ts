// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { legacyStatusDefaults } from "./legacy-status";

describe("legacy status defaults", () => {
  it("preserves the implicit historical gateway display", () => {
    expect(legacyStatusDefaults("openclaw")).toEqual({
      displayName: "OpenClaw",
      tolerateMissingDefinition: true,
      retainLoadedDefinition: false,
    });
  });

  it("does not silently tolerate an explicitly named legacy definition", () => {
    expect(legacyStatusDefaults("future-terminal")).toEqual({
      displayName: "future-terminal",
      tolerateMissingDefinition: false,
      retainLoadedDefinition: true,
    });
  });
});
