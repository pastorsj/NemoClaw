// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { inspectProviderAttachmentOwnership } from "./provider-ownership";

function sandboxList(...names: string[]): string {
  return JSON.stringify(
    names.map((name, index) => ({
      id: `sandbox-id-${index}`,
      name,
      labels: {},
      resource_version: 1,
      created_at: "2026-09-07T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    })),
  );
}

function providerTable(...names: string[]): string {
  return names.length === 0
    ? "No providers attached to sandbox."
    : ["NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS", ...names.map((name) => `${name} generic 1 0`)].join(
        "\n",
      );
}

describe("provider attachment ownership inspection", () => {
  it("enumerates every sandbox and reports attachments outside the allowed set", () => {
    const responses = new Map([
      ["sandbox list -o json", { status: 0, stdout: sandboxList("target", "foreign"), stderr: "" }],
      [
        "sandbox provider list target",
        { status: 0, stdout: providerTable("shared-provider"), stderr: "" },
      ],
      [
        "sandbox provider list foreign",
        { status: 0, stdout: providerTable("shared-provider"), stderr: "" },
      ],
    ]);
    const runOpenshell = vi.fn(
      (args: string[], _options?: unknown) =>
        responses.get(args.join(" ")) ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );

    expect(inspectProviderAttachmentOwnership("shared-provider", ["target"], runOpenshell)).toEqual(
      {
        kind: "foreign",
        attachedSandboxNames: ["target", "foreign"],
        foreignSandboxNames: ["foreign"],
      },
    );
    expect(runOpenshell.mock.calls.map(([args]) => args.join(" "))).toEqual([
      "sandbox list -o json",
      "sandbox provider list target",
      "sandbox provider list foreign",
    ]);
    expect(runOpenshell.mock.calls[0]?.[1]).toMatchObject({
      maxBuffer: 64 * 1024,
      suppressOutput: true,
      timeout: 5_000,
    });
  });

  it("accepts attachments confined to the allowed set", () => {
    const responses = new Map([
      ["sandbox list -o json", { status: 0, stdout: sandboxList("target", "other"), stderr: "" }],
      [
        "sandbox provider list target",
        { status: 0, stdout: providerTable("owned-provider"), stderr: "" },
      ],
      ["sandbox provider list other", { status: 0, stdout: providerTable(), stderr: "" }],
    ]);
    const runOpenshell = vi.fn(
      (args: string[]) =>
        responses.get(args.join(" ")) ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );

    expect(inspectProviderAttachmentOwnership("owned-provider", ["target"], runOpenshell)).toEqual({
      kind: "authorized",
      attachedSandboxNames: ["target"],
    });
  });

  it.each([
    {
      condition: "sandbox listing fails",
      result: { status: 1, stdout: "[]", stderr: "gateway unavailable" },
    },
    {
      condition: "sandbox listing emits diagnostics on stderr",
      result: { status: 0, stdout: "[]", stderr: "partial result" },
    },
    {
      condition: "sandbox listing is malformed",
      result: { status: 0, stdout: '[{"name":"target"}]', stderr: "" },
    },
    {
      condition: "sandbox listing exceeds the output limit",
      result: { status: 0, stdout: "x".repeat(64 * 1024 + 1), stderr: "" },
    },
  ])("fails closed when $condition", ({ result }) => {
    expect(inspectProviderAttachmentOwnership("owned-provider", ["target"], () => result)).toEqual({
      kind: "indeterminate",
    });
  });

  it("fails closed when any sandbox attachment inventory is malformed", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args[1] === "list"
        ? { status: 0, stdout: sandboxList("target"), stderr: "" }
        : { status: 0, stdout: "unexpected output", stderr: "" },
    );

    expect(inspectProviderAttachmentOwnership("owned-provider", ["target"], runOpenshell)).toEqual({
      kind: "indeterminate",
    });
  });
});
