// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type CommittedManagedStartupApplication,
  type PreparedManagedStartupApplication,
  type PrepareManagedStartupApplicationInput,
} from "./managed-startup/application";
import {
  coordinateManagedStartupApplication,
  type ManagedStartupAgentAdapter,
  type ManagedStartupCoordinatorDependencies,
} from "./managed-startup/coordinator";
import { type ManagedStartupAgent, type ManagedStartupProfile } from "./managed-startup/profile";

function inputFor(agent: ManagedStartupAgent): PrepareManagedStartupApplicationInput {
  return { encodedProfile: `encoded-${agent}`, expectedAgent: agent };
}

function preparedFor(
  agent: ManagedStartupAgent,
  status: PreparedManagedStartupApplication["status"] = "prepared",
): PreparedManagedStartupApplication {
  return {
    status,
    stateDirectory: "/var/lib/nemoclaw/startup-profile",
    generationDirectory: `/var/lib/nemoclaw/startup-profile/generation-${"a".repeat(64)}`,
    profilePath: `/var/lib/nemoclaw/startup-profile/generation-${"a".repeat(64)}/profile.json`,
    corporateCaPath: null,
    fingerprint: "a".repeat(64),
    expectedAgent: agent,
    profile: { agent } as ManagedStartupProfile,
  };
}

function committedFrom(
  prepared: PreparedManagedStartupApplication,
): CommittedManagedStartupApplication {
  const { status: _status, ...application } = prepared;
  return { ...application, status: "committed" };
}

function dependenciesFor(
  prepared: PreparedManagedStartupApplication,
  order: string[] = [],
): ManagedStartupCoordinatorDependencies & {
  prepareApplication: ReturnType<typeof vi.fn>;
  commitApplication: ReturnType<typeof vi.fn>;
} {
  return {
    prepareApplication: vi.fn(async () => {
      order.push("prepare");
      return prepared;
    }),
    commitApplication: vi.fn(async (application: PreparedManagedStartupApplication) => {
      order.push("commit");
      return committedFrom(application);
    }),
  };
}

function adapterFor(
  packageId: string,
  order: string[] = [],
): ManagedStartupAgentAdapter & { readonly apply: ReturnType<typeof vi.fn> } {
  return {
    packageId,
    apply: vi.fn(async () => {
      order.push(`apply:${packageId}`);
    }),
  };
}

describe("managed startup coordinator", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code", "pi"] as const)(
    "applies the selected %s package before commit",
    async (agent) => {
      const order: string[] = [];
      const prepared = preparedFor(agent);
      const dependencies = dependenciesFor(prepared, order);
      const adapter = adapterFor(agent, order);

      const result = await coordinateManagedStartupApplication(
        inputFor(agent),
        adapter,
        dependencies,
      );

      expect(result.adapterApplied).toBe(true);
      expect(result.application.status).toBe("committed");
      expect(order).toEqual(["prepare", `apply:${agent}`, "commit"]);
      expect(adapter.apply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agent,
          profile: prepared.profile,
          fingerprint: prepared.fingerprint,
        }),
      );
    },
  );

  it("does not reapply mutable configuration for an already committed profile", async () => {
    const prepared = preparedFor("openclaw", "already-committed");
    const dependencies = dependenciesFor(prepared);
    const adapter = adapterFor("openclaw");

    const result = await coordinateManagedStartupApplication(
      inputFor("openclaw"),
      adapter,
      dependencies,
    );

    expect(result.adapterApplied).toBe(false);
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(dependencies.commitApplication).toHaveBeenCalledExactlyOnceWith(prepared);
  });

  it("rejects a mismatched package before preparing state", async () => {
    const dependencies = dependenciesFor(preparedFor("openclaw"));
    await expect(
      coordinateManagedStartupApplication(inputFor("openclaw"), adapterFor("hermes"), dependencies),
    ).rejects.toThrow(/adapter for hermes cannot apply openclaw/u);
    expect(dependencies.prepareApplication).not.toHaveBeenCalled();
  });

  it("accepts a syntactically valid future package without a shipped-package registry", async () => {
    const dependencies = dependenciesFor(preparedFor("openclaw"));
    const adapter = adapterFor("future-harness") as ManagedStartupAgentAdapter;
    await expect(
      coordinateManagedStartupApplication(
        { ...inputFor("openclaw"), expectedAgent: "future-harness" as ManagedStartupAgent },
        adapter,
        dependencies,
      ),
    ).rejects.toThrow(/targets openclaw, expected future-harness/u);
    expect(dependencies.prepareApplication).toHaveBeenCalledOnce();
  });

  it("fails closed instead of cross-dispatching a mismatched prepared profile", async () => {
    const prepared = {
      ...preparedFor("openclaw"),
      profile: { agent: "hermes" } as ManagedStartupProfile,
    };
    const dependencies = dependenciesFor(prepared);
    const adapter = adapterFor("openclaw");
    await expect(
      coordinateManagedStartupApplication(inputFor("openclaw"), adapter, dependencies),
    ).rejects.toThrow(/targets hermes, expected openclaw/u);
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(dependencies.commitApplication).not.toHaveBeenCalled();
  });

  it("does not commit an adapter failure and can retry the pending profile", async () => {
    const prepared = preparedFor("hermes");
    const dependencies = dependenciesFor(prepared);
    const adapter = adapterFor("hermes");
    adapter.apply.mockRejectedValueOnce(new Error("adapter failed"));

    await expect(
      coordinateManagedStartupApplication(inputFor("hermes"), adapter, dependencies),
    ).rejects.toThrow("adapter failed");
    expect(dependencies.commitApplication).not.toHaveBeenCalled();

    const retried = await coordinateManagedStartupApplication(
      inputFor("hermes"),
      adapter,
      dependencies,
    );
    expect(retried.application.status).toBe("committed");
    expect(adapter.apply).toHaveBeenCalledTimes(2);
  });

  it("does not reapply after a durable commit loses its acknowledgement", async () => {
    const prepared = preparedFor("langchain-deepagents-code");
    const recovered = preparedFor("langchain-deepagents-code", "already-committed");
    const dependencies = dependenciesFor(prepared);
    const adapter = adapterFor("langchain-deepagents-code");
    dependencies.prepareApplication
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(recovered);
    dependencies.commitApplication.mockRejectedValueOnce(
      new Error("simulated lost commit acknowledgement"),
    );

    await expect(
      coordinateManagedStartupApplication(
        inputFor("langchain-deepagents-code"),
        adapter,
        dependencies,
      ),
    ).rejects.toThrow("simulated lost commit acknowledgement");

    const retried = await coordinateManagedStartupApplication(
      inputFor("langchain-deepagents-code"),
      adapter,
      dependencies,
    );
    expect(retried.adapterApplied).toBe(false);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(dependencies.commitApplication).toHaveBeenCalledTimes(2);
  });
});
