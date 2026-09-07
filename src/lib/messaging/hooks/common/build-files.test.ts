// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPackageBuildFilesHook } from "./build-files";

describe("common package build-file hook", () => {
  it("renders bounded inputs, generated values, optional fields, and dynamic keys", async () => {
    const hook = createPackageBuildFilesHook({ now: () => "2026-09-06T00:00:00.000Z" });
    const result = await hook({
      channelId: "future-channel",
      hookId: "future-build",
      phase: "post-agent-install",
      inputs: { accountId: "account-7", token: "credential-placeholder" },
      packageOperation: {
        hookId: "future-build",
        kind: "build-files",
        inputIds: ["accountId", "token", "optionalValue"],
        outputs: [
          {
            id: "accountFile",
            pathTemplate: "accounts/{{input:accountId}}.json",
            mode: "0600",
            content: {
              token: { $input: "token" },
              savedAt: { $generated: "iso-timestamp" },
              optional: { $input: "optionalValue", optional: true },
              accounts: { "{{input:accountId}}": { enabled: true } },
            },
          },
        ],
      },
    });

    expect(result.outputs?.accountFile).toEqual({
      kind: "build-file",
      value: {
        path: "accounts/account-7.json",
        mode: "0600",
        content: {
          token: "credential-placeholder",
          savedAt: "2026-09-06T00:00:00.000Z",
          accounts: { "account-7": { enabled: true } },
        },
      },
    });
  });

  it("rejects traversal supplied through a path input", async () => {
    const hook = createPackageBuildFilesHook();
    expect(() =>
      hook({
        channelId: "future-channel",
        hookId: "future-build",
        phase: "post-agent-install",
        inputs: { accountId: "../escape" },
        packageOperation: {
          hookId: "future-build",
          kind: "build-files",
          inputIds: ["accountId"],
          outputs: [
            {
              id: "accountFile",
              pathTemplate: "accounts/{{input:accountId}}.json",
              content: {},
            },
          ],
        },
      }),
    ).toThrow("safe segment input");
  });
});
