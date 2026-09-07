// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessAgentCommandDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { buildPackageAgentCommandPlan } from "./command-plan";

const declaration = {
  argv: ["future-agent", "run"],
  output_mode: "bounded-text",
  selector_options: ["--session"],
  selector_required: true,
  value_options: ["--message", "--timeout"],
  boolean_options: ["--deliver"],
  json_output_option: "--json",
  timeout_option: "--timeout",
} satisfies HarnessAgentCommandDeclaration;

describe("package agent command plan", () => {
  it("returns the package command and bounded JSON mode for a selected invocation", () => {
    expect(
      buildPackageAgentCommandPlan(declaration, [
        "--session=s-1",
        "--message",
        "ping",
        "--json",
        "--timeout=45",
      ]),
    ).toEqual({
      kind: "dispatch",
      argv: ["future-agent", "run", "--session=s-1", "--message", "ping", "--json", "--timeout=45"],
      outputMode: "bounded-json",
      requestedTimeoutSeconds: 45,
    });
  });

  it("returns typed missing-selector state instead of dispatching", () => {
    expect(buildPackageAgentCommandPlan(declaration, ["--message", "ping"])).toEqual({
      kind: "missing-selector",
      argv: ["future-agent", "run", "--message", "ping"],
      selectors: ["--session"],
    });
  });

  it("does not accept a selector after the argv terminator", () => {
    expect(buildPackageAgentCommandPlan(declaration, ["--", "--session=s-1"])).toMatchObject({
      kind: "missing-selector",
    });
  });

  it("does not treat a selector-shaped option value as a selector", () => {
    expect(buildPackageAgentCommandPlan(declaration, ["--message", "--session"])).toMatchObject({
      kind: "missing-selector",
    });
  });

  it("does not interpret JSON when the token is an option value", () => {
    expect(
      buildPackageAgentCommandPlan(declaration, ["--session", "s-1", "--message", "--json"]),
    ).toMatchObject({ kind: "dispatch", outputMode: "bounded-text" });
  });

  it("keeps direct package output on the ordinary sandbox executor", () => {
    expect(
      buildPackageAgentCommandPlan({ argv: ["future-agent"], output_mode: "direct" }, ["--json"]),
    ).toEqual({
      kind: "dispatch",
      argv: ["future-agent", "--json"],
      outputMode: "direct",
      requestedTimeoutSeconds: null,
    });
  });

  it("selects an explicitly declared finite output interpretation", () => {
    expect(
      buildPackageAgentCommandPlan(
        {
          argv: ["openclaw", "agent"],
          output_mode: "bounded-text",
          output_interpretation: "structured-turn-envelope",
        },
        [],
      ),
    ).toMatchObject({
      kind: "dispatch",
      outputMode: "bounded-text",
      structuredTurnEnvelope: {
        output_interpretation: "structured-turn-envelope",
      },
    });
  });

  it("forwards package help through the declared command without selector or envelope parsing", () => {
    expect(
      buildPackageAgentCommandPlan(
        { ...declaration, output_interpretation: "structured-turn-envelope" },
        ["--help"],
      ),
    ).toEqual({
      kind: "dispatch",
      argv: ["future-agent", "run", "--help"],
      outputMode: "bounded-text",
      requestedTimeoutSeconds: null,
    });
  });

  it("does not treat a help token after the argv terminator as native help", () => {
    const plan = buildPackageAgentCommandPlan({ ...declaration, selector_required: false }, [
      "--",
      "--help",
    ]);
    expect(plan).toMatchObject({
      kind: "dispatch",
      argv: ["future-agent", "run", "--", "--help"],
    });
    expect(plan).not.toHaveProperty("structuredTurnEnvelope");
  });
});
