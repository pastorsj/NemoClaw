// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createPostRestoreAgentAuthority,
  createPostRestoreInput,
  createPostRestoreOnboardSession,
  createPostRestoreRegistryEntry,
  type RebuildPostRestoreAgent,
} from "../../../../test/helpers/rebuild-post-restore-fixture";
import * as mutableConfigPerms from "../../sandbox/mutable-config-perms";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import { installRebuildPostRestoreTestHooks } from "../../../../test/helpers/rebuild-hooks";

describe("rebuilt runtime posture", () => {
  let agentName: RebuildPostRestoreAgent;
  let agentExpectedVersion: string | undefined;
  let order: string[];

  function currentAgentAuthority() {
    return createPostRestoreAgentAuthority(agentName, agentExpectedVersion);
  }

  function currentRegistryEntry() {
    return createPostRestoreRegistryEntry(currentAgentAuthority());
  }

  function currentOnboardSession() {
    return createPostRestoreOnboardSession(currentAgentAuthority());
  }

  function input() {
    return createPostRestoreInput(currentAgentAuthority());
  }

  installRebuildPostRestoreTestHooks({
    currentAgentAuthority,
    currentOnboardSession,
    currentRegistryEntry,
    recordOrder: (event) => order.push(event),
    reset: () => {
      agentName = "openclaw";
      agentExpectedVersion = undefined;
      order = [];
    },
  });

  it("does not claim mutable Hermes posture without the exact sandbox proof", async () => {
    agentName = "hermes";
    vi.mocked(mutableConfigPerms.inspectMutableHermesConfigPerms).mockReturnValue({
      verified: false,
      errors: ["config.yaml remains read-only"],
    });
    const args = input();

    const verification = await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(verification).toEqual({ mutableConfigPermissionsVerified: false });
    expect(args.log).toHaveBeenCalledWith(
      "Hermes mutable config posture was not verified: config.yaml remains read-only",
    );
  });

  it.each(["langchain-deepagents-code", "pi"] as const)(
    "proves the rebuilt %s terminal-agent posture from exact generic completion",
    async (terminalAgent) => {
      agentName = terminalAgent;

      const verification = await runRebuildPostRestorePhase(input());

      expect(verification).toEqual({ mutableConfigPermissionsVerified: true });
      expect(mutableConfigPerms.inspectMutableHermesConfigPerms).not.toHaveBeenCalled();
    },
  );
});
