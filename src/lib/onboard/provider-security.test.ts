// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

type RunResult = {
  error?: unknown;
  output?: string;
  signal?: unknown;
  status: number;
  stdout?: string;
  stderr?: string;
};

type RunOptions = {
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  maxBuffer?: number;
  stdio?: readonly unknown[];
  suppressOutput?: boolean;
  timeout?: number;
};

type RunOpenshell = (command: string[], options?: RunOptions) => RunResult;

const { upsertProvider } = require("./providers") as {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: RunOpenshell,
    options?: {
      knownExists?: boolean;
      allowedSandboxes?: readonly string[];
      expectedProviderId?: string;
    },
  ) => { ok: boolean; status?: number; message?: string; reason?: string };
};

const SUCCESS = { status: 0, stdout: "", stderr: "" } as const;

function sandboxRows(...names: string[]): string {
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

describe("provider mutation security", () => {
  it("refuses to update a receipt-owned provider attached to a foreign sandbox", () => {
    const commands: string[] = [];
    const metadata = [
      "Id: provider-id-a",
      "Name: shared-provider",
      "Type: generic",
      "Credential keys: SHARED_TOKEN",
      "Config keys: <none>",
      "",
    ].join("\n");
    const attachmentTable = [
      "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
      "shared-provider generic 1 0",
    ].join("\n");
    const exactResponses = new Map<string, RunResult>([
      ["provider get shared-provider", { status: 0, stdout: metadata, stderr: "" }],
      ["sandbox list -o json", { status: 0, stdout: sandboxRows("target", "foreign"), stderr: "" }],
    ]);
    const result = upsertProvider(
      "shared-provider",
      "generic",
      "SHARED_TOKEN",
      null,
      { SHARED_TOKEN: "new-secret" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        return (
          exactResponses.get(normalized) ??
          (normalized.startsWith("sandbox provider list ")
            ? { status: 0, stdout: attachmentTable, stderr: "" }
            : SUCCESS)
        );
      },
      {
        knownExists: true,
        expectedProviderId: "provider-id-a",
        allowedSandboxes: ["target"],
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "binding-conflict" });
    expect(result).toHaveProperty("message", expect.stringContaining("authorized sandbox set"));
    expect(
      commands.filter((command) => /^provider (?:create|update|refresh)\b/u.test(command)),
    ).toEqual([]);
  });

  it("rechecks receipt-owned provider attachments immediately before credential update", () => {
    const commands: string[] = [];
    let sandboxListCalls = 0;
    const metadata = [
      "Id: provider-id-a",
      "Name: shared-provider",
      "Type: generic",
      "Credential keys: SHARED_TOKEN",
      "Config keys: <none>",
      "",
    ].join("\n");
    const attachmentTable = [
      "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
      "shared-provider generic 1 0",
    ].join("\n");
    const responseByCommand: Record<string, () => RunResult> = {
      "provider get shared-provider": () => ({ status: 0, stdout: metadata, stderr: "" }),
      "sandbox list -o json": () => ({
        status: 0,
        stdout: ++sandboxListCalls === 1 ? sandboxRows("target") : sandboxRows("target", "foreign"),
        stderr: "",
      }),
    };
    const result = upsertProvider(
      "shared-provider",
      "generic",
      "SHARED_TOKEN",
      null,
      { SHARED_TOKEN: "new-secret" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        return (
          responseByCommand[normalized] ??
          (() =>
            normalized.startsWith("sandbox provider list ")
              ? { status: 0, stdout: attachmentTable, stderr: "" }
              : SUCCESS)
        )();
      },
      {
        knownExists: true,
        expectedProviderId: "provider-id-a",
        allowedSandboxes: ["target"],
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "binding-conflict" });
    expect(sandboxListCalls).toBe(2);
    expect(
      commands.filter((command) => /^provider (?:create|update|refresh)\b/u.test(command)),
    ).toEqual([]);
  });

  it("bounds provider mutations and removes exact credentials and terminal controls from failures", () => {
    const credential = "opaque-value-without-a-known-token-pattern";
    let mutationOptions: RunOptions | undefined;
    const mutationFailure = (options: RunOptions | undefined): RunResult => {
      mutationOptions = options;
      return {
        status: 1,
        stdout: "",
        stderr: `rejected ${credential}\u001b]52;c;clipboard-payload\u0007\u0000`,
      };
    };
    const result = upsertProvider(
      "bad-provider",
      "generic",
      "SOME_KEY",
      null,
      { SOME_KEY: credential },
      (command, options) =>
        command.includes("get") ? { status: 1, stdout: "", stderr: "" } : mutationFailure(options),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("rejected <REDACTED>");
    expect(result.message).not.toContain(credential);
    expect(result.message).not.toContain("clipboard-payload");
    expect(result.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    expect(mutationOptions).toMatchObject({
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
  });
});
