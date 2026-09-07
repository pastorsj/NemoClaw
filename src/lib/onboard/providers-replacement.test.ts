// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

type RunResult = { status: number; stdout?: string; stderr?: string };
type RunOpenshell = (command: string[]) => RunResult;

const { upsertMessagingProviders } = require("./providers") as {
  upsertMessagingProviders: (
    tokenDefs: Array<{
      name: string;
      envKey: string;
      token: string | null;
      providerType?: string;
    }>,
    runOpenshell: RunOpenshell,
    options?: {
      allowedSandboxes?: readonly string[];
      bestEffort?: boolean;
      replaceExisting?: boolean;
    },
  ) => string[];
};

describe("onboard messaging provider replacement", () => {
  it("does not detach a sibling sandbox while replacing a recreate-owned provider (#9875)", () => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "spark-nemo-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "tg-test",
            providerType: "generic",
          },
        ],
        (command) => {
          const joined = command.join(" ");
          commands.push(joined);
          return joined === "provider delete spark-nemo-telegram-bridge"
            ? {
                status: 1,
                stdout: "",
                stderr:
                  "Error: status: FailedPrecondition, message: \"provider 'spark-nemo-telegram-bridge' is attached to sandbox(es): sibling-live\"",
              }
            : { status: 0, stdout: "", stderr: "" };
        },
        {
          replaceExisting: true,
          bestEffort: true,
          allowedSandboxes: ["spark-nemo"],
        },
      ),
    ).toThrow(/sibling-live/u);
    expect(commands).toEqual([
      "provider get spark-nemo-telegram-bridge",
      "provider delete spark-nemo-telegram-bridge",
    ]);
  });
});
