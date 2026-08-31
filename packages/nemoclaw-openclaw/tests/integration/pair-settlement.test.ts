// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { settleOrdinaryOpenClawPairing } from "../../../../src/lib/onboard/machine/finalization-deps";
import { createAutoPairPythonScript } from "../helpers/pair-bootstrap";
import { createCanonicalCliPairingFixture } from "../helpers/pair-settlement";
import { readOpenClawAutoPairSource } from "../helpers/startup";

type SettlementDependencies = NonNullable<Parameters<typeof settleOrdinaryOpenClawPairing>[1]>;
type RaceTiming = "watcher-first" | "host-first";

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    expect(Date.now(), `Timed out waiting for ${label}.`).toBeLessThan(deadline);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("OpenClaw pairing settlement ownership", () => {
  const autoPairSource = readOpenClawAutoPairSource();

  it.each([
    ["watcher settles before the host observes the request", "watcher-first"],
    ["host observes the request before the watcher settles", "host-first"],
  ] as const)(
    "keeps the watcher as the only scope approver when %s (#10269)",
    async (_label, timing: RaceTiming) => {
      const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-single-approver-"),
      );
      const fakeOpenClawPath = path.join(temporaryDirectory, "openclaw");
      const stateDirectory = path.join(temporaryDirectory, "state");
      const phasePath = path.join(temporaryDirectory, "phase");
      const listLogPath = path.join(temporaryDirectory, "list.log");
      const approvalLogPath = path.join(temporaryDirectory, "approvals.log");
      const statusPath = path.join(temporaryDirectory, "auto-pair-status.json");
      const requestId = "scope-upgrade";
      const canonicalCli = createCanonicalCliPairingFixture(stateDirectory);
      const pairingOnlyCli = {
        ...canonicalCli,
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: {
          operator: {
            role: "operator",
            revokedAtMs: null,
            scopes: ["operator.pairing"],
          },
        },
      };
      const pendingRequest = {
        requestId,
        deviceId: canonicalCli.deviceId,
        publicKey: canonicalCli.publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.write"],
        isRepair: false,
      };
      const pairingOnlyList = JSON.stringify({ pending: [], paired: [pairingOnlyCli] });
      const pendingList = JSON.stringify({
        pending: [pendingRequest],
        paired: [pairingOnlyCli],
      });
      const settledList = JSON.stringify({ pending: [], paired: [canonicalCli] });
      fs.writeFileSync(phasePath, "pairing-only");
      fs.writeFileSync(
        fakeOpenClawPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf 'list\n' >> ${JSON.stringify(listLogPath)}
  phase="$(cat ${JSON.stringify(phasePath)})"
  if [ "$phase" = "pairing-only" ]; then printf '%s\n' ${JSON.stringify(pairingOnlyList)}
  elif [ "$phase" = "scope-upgrade-pending" ]; then printf '%s\n' ${JSON.stringify(pendingList)}
  else printf '%s\n' ${JSON.stringify(settledList)}; fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  printf 'watcher:%s\n' "$3" >> ${JSON.stringify(approvalLogPath)}
  [ "$3" = ${JSON.stringify(requestId)} ] || exit 7
  printf 'settled' > ${JSON.stringify(phasePath)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
        { mode: 0o755 },
      );

      let watcher: ReturnType<typeof spawn> | undefined;
      let watcherOutput = "";
      let hostApprovalAttempts = 0;
      let warmupRuns = 0;
      let reportPendingObserved = () => {};
      const pendingObserved = new Promise<void>((resolve) => {
        reportPendingObserved = resolve;
      });
      const startWatcher = () => {
        const child = spawn(
          "python3",
          [
            "-u",
            "-c",
            createAutoPairPythonScript(autoPairSource, temporaryDirectory, {
              realTime: true,
              statusPath,
            }),
          ],
          {
            env: {
              ...process.env,
              OPENCLAW_BIN: fakeOpenClawPath,
              OPENCLAW_STATE_DIR: stateDirectory,
              NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "6",
              NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "0.05",
              NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.05",
              NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout?.on("data", (chunk) => {
          watcherOutput += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          watcherOutput += String(chunk);
        });
        return child;
      };
      const timingStrategy = {
        "watcher-first": {
          prepare: async () => {
            watcher = startWatcher();
            await waitForCondition(
              () => fs.existsSync(listLogPath),
              "the watcher's first observation",
            );
          },
          afterWarmup: async () => {
            await waitForCondition(
              () => fs.readFileSync(phasePath, "utf-8").trim() === "settled",
              "the watcher to settle before host observation",
            );
          },
          afterSettlementStarted: async () => {},
        },
        "host-first": {
          prepare: async () => {},
          afterWarmup: async () => {},
          afterSettlementStarted: async () => {
            await pendingObserved;
            watcher = startWatcher();
          },
        },
      } satisfies Record<
        RaceTiming,
        {
          prepare(): Promise<void>;
          afterWarmup(): Promise<void>;
          afterSettlementStarted(): Promise<void>;
        }
      >;

      try {
        await timingStrategy[timing].prepare();
        const target = {
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "fingerprint-1",
          stateDirectory,
          version: "2026.7.1",
        };
        const dependencies: SettlementDependencies & { runApproval(): void } = {
          getTarget: () => target,
          observePairing: () => {
            const state = fs.readFileSync(phasePath, "utf-8").trim() as
              | "pairing-only"
              | "scope-upgrade-pending"
              | "settled";
            if (state === "scope-upgrade-pending") {
              reportPendingObserved();
            }
            return { state, deviceIdentitySha256: canonicalCli.deviceId };
          },
          runWarmup: async () => {
            warmupRuns += 1;
            fs.writeFileSync(phasePath, "scope-upgrade-pending");
            await timingStrategy[timing].afterWarmup();
            return "request-issued" as const;
          },
          readWatcherStatus: () => ({
            schemaVersion: 1 as const,
            state: "approval-completed" as const,
            watcherActive: true,
          }),
          withSandboxLock: async (_name, operation) => operation(),
          withGatewayLock: async (_name, operation) => operation(),
          now: () => performance.now(),
          sleep: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          },
          // This legacy dependency deliberately fails the test if host
          // settlement ever becomes a second approval owner again.
          runApproval: () => {
            hostApprovalAttempts += 1;
            fs.appendFileSync(approvalLogPath, `host:${requestId}\n`);
            fs.writeFileSync(phasePath, "settled");
          },
        };

        const settlement = settleOrdinaryOpenClawPairing("alpha", dependencies);
        await timingStrategy[timing].afterSettlementStarted();
        await expect(settlement).resolves.toEqual({ kind: "settled" });

        const approvalReceipt = `[auto-pair] approved request=${requestId} client=cli mode=cli`;
        await waitForCondition(
          () => watcherOutput.includes(approvalReceipt),
          "the watcher approval receipt",
        );
        expect(warmupRuns).toBe(1);
        expect(hostApprovalAttempts).toBe(0);
        expect(fs.readFileSync(phasePath, "utf-8").trim()).toBe("settled");
        expect(fs.readFileSync(approvalLogPath, "utf-8").trim().split("\n")).toEqual([
          `watcher:${requestId}`,
        ]);
        const publishedStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<
          string,
          unknown
        >;
        expect(Object.keys(publishedStatus).sort()).toEqual(["schemaVersion", "state"]);
        expect(publishedStatus.schemaVersion).toBe(1);
        expect(["approval-completed", "canonical-settled"]).toContain(publishedStatus.state);
      } finally {
        watcher?.kill("SIGTERM");
        const watcherClosed =
          watcher?.exitCode === null
            ? new Promise<void>((resolve) => watcher?.once("close", () => resolve()))
            : Promise.resolve();
        await Promise.race([
          watcherClosed,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
