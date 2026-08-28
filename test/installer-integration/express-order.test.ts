// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runAcceptedStationMain } from "../helpers/express-main";

describe("installer Express and harness ordering", () => {
  it.each([
    ["DeepSeek selection", { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" }, ["--station-deepseek"]],
    [
      "forced Station selection",
      {
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        EXPRESS_RELEASE_STATE: "unsupported-dgx-os",
      },
      ["--force-station-install"],
    ],
  ])("selects %s before package and host mutation", (_case, extraEnvironment, argumentsText) => {
    const run = runAcceptedStationMain(extraEnvironment, argumentsText);

    expect(run.result.status, run.output).toBe(0);
    expect(run.output).toMatch(/Using express install for DGX Station/u);
    expect(run.calls).toEqual(
      expect.arrayContaining([
        "express-selection",
        "prepare-current-cli",
        "harness-reconcile",
        "resolve-wsl",
        "station-pair",
        "setup-jetson",
        "station-host-prep",
        "ensure-docker",
      ]),
    );
    expect(run.calls.indexOf("express-selection")).toBeLessThan(
      run.calls.indexOf("prepare-current-cli"),
    );
    expect(run.calls.indexOf("harness-reconcile")).toBeLessThan(run.calls.indexOf("resolve-wsl"));
    expect(run.calls.indexOf("resolve-wsl")).toBeLessThan(run.calls.indexOf("station-pair"));
    expect(run.calls.indexOf("station-pair")).toBeLessThan(run.calls.indexOf("setup-jetson"));
    expect(run.calls.indexOf("setup-jetson")).toBeLessThan(run.calls.indexOf("station-host-prep"));
    expect(run.calls.indexOf("station-host-prep")).toBeLessThan(run.calls.indexOf("ensure-docker"));
  });
});
