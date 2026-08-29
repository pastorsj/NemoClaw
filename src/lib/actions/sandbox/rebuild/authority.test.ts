// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { REPOSITORY_ROOT } from "../../../core/repository-root";
import * as sandboxAgent from "../../../onboard/sandbox-agent";
import { makeRebuildAgentAuthority } from "../rebuild-flow-test-fixtures";
import { rebuildAgentAuthoritiesMatch, verifyRecreatedAgentAuthority } from "./authority";

function restoreEnvironmentValue(name: string, previous: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, previous === undefined ? {} : { [name]: previous });
}

describe("recreated rebuild agent authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function matchingAuthorityOwners(recordedAgent: string | null) {
    const authority = makeRebuildAgentAuthority(recordedAgent);
    return {
      authority,
      entry: {
        name: "alpha",
        agent: authority.recordedAgent,
        harnessPackage: authority.harnessPackage,
        harnessPackageMigration: authority.harnessPackageMigration,
      } as never,
      session: {
        sandboxName: "alpha",
        agent: authority.recordedAgent,
        harnessPackage: authority.harnessPackage,
        harnessPackageMigration: authority.harnessPackageMigration,
      } as never,
    };
  }

  it.each([null, "pi", "nemocua"])(
    "accepts exact package or qualified repository authority for %s",
    (recordedAgent) => {
      const owners = matchingAuthorityOwners(recordedAgent);
      const resolveAgent = vi
        .spyOn(sandboxAgent, "resolveSandboxAgent")
        .mockReturnValue(owners.authority);

      expect(
        verifyRecreatedAgentAuthority("alpha", owners.authority, owners.entry, owners.session),
      ).toBeNull();
      expect(resolveAgent).toHaveBeenCalledOnce();
      expect(owners.authority.harnessPackage === null).toBe(recordedAgent !== null);
    },
  );

  it("rejects durable package drift before resolving a harness definition", () => {
    const owners = matchingAuthorityOwners(null);
    const resolveAgent = vi.spyOn(sandboxAgent, "resolveSandboxAgent");
    const driftedEntry = {
      name: "alpha",
      agent: owners.authority.recordedAgent,
      harnessPackage: {
        ...owners.authority.harnessPackage!,
        contentDigest: "b".repeat(64),
      },
      harnessPackageMigration: owners.authority.harnessPackageMigration,
    } as never;

    expect(
      verifyRecreatedAgentAuthority("alpha", owners.authority, driftedEntry, owners.session),
    ).toContain("do not match the pinned rebuild target");
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it("rejects an installed package receipt that can no longer be verified", () => {
    const owners = matchingAuthorityOwners(null);
    vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation(() => {
      throw new Error("receipt object changed");
    });

    expect(
      verifyRecreatedAgentAuthority("alpha", owners.authority, owners.entry, owners.session),
    ).toContain("receipt or repository definition could not be verified");
  });

  it("rejects a qualified repository definition whose object root changed", () => {
    const owners = matchingAuthorityOwners("pi");
    const driftedAuthority = {
      ...owners.authority,
      definition: {
        ...owners.authority.definition,
        packageRoot: "/test/changed-repository",
      },
    };
    vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockReturnValue(driftedAuthority as never);

    expect(
      verifyRecreatedAgentAuthority("alpha", owners.authority, owners.entry, owners.session),
    ).toContain("do not match the pinned rebuild target");
    expect(owners.authority.harnessPackage).toBeNull();
  });

  it("rejects Pi after its repository qualification is removed", () => {
    const enableName = "NEMOCLAW_CANDIDATE_AGENTS";
    const receiptName = "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT";
    const previousEnable = process.env[enableName];
    const previousReceipt = process.env[receiptName];
    delete process.env[enableName];
    delete process.env[receiptName];

    try {
      const authority = sandboxAgent.resolveSandboxAgent(
        { agent: "pi" },
        {
          env: {
            [enableName]: "1",
            [receiptName]: path.join(
              REPOSITORY_ROOT,
              "ci/pi-agent-qualification-v1-linux-amd64.json",
            ),
          },
        },
      );
      const entry = { name: "alpha", agent: "pi" } as never;
      const session = { sandboxName: "alpha", agent: "pi" } as never;

      expect(verifyRecreatedAgentAuthority("alpha", authority, entry, session)).toContain(
        "receipt or repository definition could not be verified",
      );
    } finally {
      restoreEnvironmentValue(enableName, previousEnable);
      restoreEnvironmentValue(receiptName, previousReceipt);
    }
  });

  const authorityDrifts: Array<
    [
      string,
      {
        definition?: { expectedVersion: string };
        harnessPackage?: { contentDigest: string };
      },
    ]
  > = [
    ["definition", { definition: { expectedVersion: "changed" } }],
    ["package receipt", { harnessPackage: { contentDigest: "b".repeat(64) } }],
  ];

  it.each(authorityDrifts)(
    "detects %s drift between resolved and pinned authority",
    (_label, drift) => {
      const owners = matchingAuthorityOwners(null);
      const actual = {
        ...owners.authority,
        ...(drift.definition
          ? { definition: { ...owners.authority.definition, ...drift.definition } }
          : {}),
        ...(drift.harnessPackage
          ? { harnessPackage: { ...owners.authority.harnessPackage!, ...drift.harnessPackage } }
          : {}),
      };

      expect(rebuildAgentAuthoritiesMatch(owners.authority, owners.authority)).toBe(true);
      expect(rebuildAgentAuthoritiesMatch(actual as never, owners.authority)).toBe(false);
    },
  );
});
