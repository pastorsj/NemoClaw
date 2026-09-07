// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { migrationOnlyEnvTargets } from "./credential-env-cleanup";

function futurePackagePlan() {
  return {
    agent: "future-harness",
    packageBuild: { receiptBacked: true },
    credentialBindings: [
      {
        channelId: "telegram",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
      },
    ],
    agentRender: [
      { kind: "env-lines", target: "~/.future-harness/channels.env" },
      { kind: "json-fragment", target: "~/.future-harness/config.json" },
    ],
  } as const;
}

describe("migrationOnlyEnvTargets", () => {
  it("uses a receipt-backed package's declared env target without knowing its identity", () => {
    expect(migrationOnlyEnvTargets(futurePackagePlan(), new Set())).toEqual([
      "~/.future-harness/channels.env",
    ]);
  });

  it("does not revisit an env target already reached by the current render", () => {
    expect(
      migrationOnlyEnvTargets(futurePackagePlan(), new Set(["~/.future-harness/channels.env"])),
    ).toEqual([]);
  });

  it("does not infer a package target when the plan declares only structured config", () => {
    expect(
      migrationOnlyEnvTargets(
        {
          ...futurePackagePlan(),
          agentRender: [{ kind: "json-fragment", target: "~/.future-harness/config.json" }],
        },
        new Set(),
      ),
    ).toEqual([]);
  });

  it("does not touch any target when the plan owns no messaging credential", () => {
    expect(
      migrationOnlyEnvTargets({ ...futurePackagePlan(), credentialBindings: [] }, new Set()),
    ).toEqual([]);
  });
});
