// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveUnpackagedOnboardAgent } from "./unpackaged-agent";

describe("resolveUnpackagedOnboardAgent", () => {
  it("keeps NemoCUA behind its existing explicit feature gate", () => {
    assert.throws(() => resolveUnpackagedOnboardAgent("nemocua", {}), /NemoCUA is disabled/u);

    const definition = resolveUnpackagedOnboardAgent("nemocua", {
      NEMOCLAW_CUA_ENABLED: "1",
    });

    assert.equal(definition?.name, "nemocua");
    assert.equal(resolveUnpackagedOnboardAgent("openclaw", {}), null);
  });
});
