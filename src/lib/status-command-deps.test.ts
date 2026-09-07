// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHarnessPackageFixture } from "../../test/helpers/harness-packages";
import { makeMessagingPlan } from "../../test/helpers/messaging-plan-fixtures";
import { compactSandboxMessagingPlanForPersistence } from "./messaging/persistence";
import * as receiptAuthority from "./onboard/experimental/hermes-portable-receipt";
import * as registry from "./state/registry";
import { buildStatusCommandDeps } from "./status-command-deps";

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

function addDisabledOpenClawMessagingAdapter(
  fixture: ReturnType<typeof createHarnessPackageFixture>,
): void {
  const packageRoot = fixture.packageRoots.get("openclaw");
  expect(packageRoot, "OpenClaw fixture package root is unavailable").toBeDefined();
  const adapterPath = path.join(packageRoot!, "host/messaging-adapter.cts");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    adapterPath,
    `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
module.exports = {
  describeMessagingIntegration(request) {
    if (request.packageId !== "openclaw") throw new Error("package mismatch");
    return { kind: "disabled", packageId: "openclaw", reason: "fixture disabled" };
  },
};
`,
    { mode: 0o600 },
  );
}

function addTeamsOpenClawMessagingAdapter(
  fixture: ReturnType<typeof createHarnessPackageFixture>,
): void {
  const packageRoot = fixture.packageRoots.get("openclaw");
  expect(packageRoot, "OpenClaw fixture package root is unavailable").toBeDefined();
  const manifestPath = path.join(packageRoot!, "manifest.yaml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  fs.writeFileSync(
    manifestPath,
    manifest.replace(
      "messaging:\n  support: disabled\n",
      "messaging:\n  support: channels\n  channels:\n    - teams\n",
    ),
    { mode: 0o600 },
  );
  const adapterPath = path.join(packageRoot!, "host/messaging-adapter.cts");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    adapterPath,
    `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
module.exports = {
  describeMessagingIntegration(request) {
    return {
      kind: "channels",
      packageId: request.packageId,
      channelIds: ["teams"],
      profilePath: "messaging/profile.json",
      build: { configRoot: "~/.selected-openclaw", packageManagers: [] },
    };
  },
};
`,
    { mode: 0o600 },
  );
  const profilePath = path.join(packageRoot!, "messaging/profile.json");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    profilePath,
    `${JSON.stringify([
      {
        channelId: "teams",
        config: { renders: [], visibility: [] },
        policy: [],
        lifecycle: { hookIds: ["teams-host-forward-port-status"] },
      },
    ])}\n`,
    { mode: 0o600 },
  );
}

function compactReceiptTeamsPlan(name: string, port: number) {
  const plan = makeMessagingPlan({ sandboxName: name, channels: ["teams"] });
  return compactSandboxMessagingPlanForPersistence({
    ...plan,
    packageBuild: { configRoot: "~/.selected-openclaw", packageManagers: [] },
    channels: plan.channels.map((channel) => ({
      ...channel,
      inputs: [
        {
          channelId: "teams",
          inputId: "webhookPort",
          kind: "config" as const,
          required: false,
          sourceEnv: "MSTEAMS_PORT",
          statePath: "teamsConfig.webhookPort",
          value: String(port),
        },
      ],
      hostForward: {
        channelId: "teams",
        port,
        label: "selected package Teams forward",
      },
    })),
  });
}

describe("buildStatusCommandDeps", () => {
  let previousOverride: string | undefined;
  let previousHome: string | undefined;
  let tmp: string;
  let callsFile: string;
  let openshell: string;
  const packageFixtures: ReturnType<typeof createHarnessPackageFixture>[] = [];
  const packageHomes: string[] = [];

  beforeEach(() => {
    previousOverride = process.env.NEMOCLAW_OPENSHELL_BIN;
    previousHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-status-deps-"));
    callsFile = path.join(tmp, "openshell.calls");
    openshell = path.join(tmp, "openshell");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const fixture of packageFixtures.splice(0)) fixture.cleanup();
    for (const home of packageHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
    previousOverride === undefined
      ? Reflect.deleteProperty(process.env, "NEMOCLAW_OPENSHELL_BIN")
      : Object.assign(process.env, { NEMOCLAW_OPENSHELL_BIN: previousOverride });
    previousHome === undefined
      ? Reflect.deleteProperty(process.env, "HOME")
      : Object.assign(process.env, { HOME: previousHome });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies copied Hermes authority for status before probe migration (#10423)", () => {
    const classify = vi
      .spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthorityForClassification")
      .mockReturnValue({
        kind: "hermes",
        snapshot: {
          receipt: {
            phase: "active",
            sandboxName: "alpha",
            gatewayName: "nemoclaw",
            lifecycleGeneration: "generation-1",
            openshellExecutableAuthority: { version: "0.0.106" },
          },
        } as never,
      });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      openshellDriver: "docker",
      openshellVersion: "0.0.106",
    } as never);

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.getHermesPortablePhase?.("alpha")).toBe("active");
    expect(classify).toHaveBeenCalledOnce();
  });

  it("detects Telegram conflict signatures from the gateway log", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  printf 'getUpdates conflict\\n409 Conflict\\n409: Conflict\\n'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["telegram"])).toEqual([
      { channel: "telegram", conflicts: 3 },
    ]);
    expect(fs.readFileSync(callsFile, "utf-8")).toContain(
      "sandbox exec -n alpha -- sh -c tail -n 200 /tmp/gateway.log",
    );
    expect(fs.readFileSync(callsFile, "utf-8")).not.toContain("grep -cE");
  });

  it("skips gateway-log probes for non-Telegram channel sets", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["slack", "discord"])).toEqual([]);
    expect(fs.existsSync(callsFile)).toBe(false);
  });

  it("uses an exact same-id package profile instead of built-in OpenClaw status hooks", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  printf '409 Conflict\n'
fi
exit 0
`,
    );
    const packageHome = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules/.cache/nemoclaw-status-home-"),
    );
    packageHomes.push(packageHome);
    process.env.HOME = packageHome;
    const fixture = createHarnessPackageFixture({
      fixtureParent: path.join(packageHome, "fixtures"),
      storeRoot: path.join(packageHome, ".nemoclaw", "harnesses"),
    });
    packageFixtures.push(fixture);
    addDisabledOpenClawMessagingAdapter(fixture);
    const installed = fixture.install("openclaw");
    const damagedEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: installed.identity,
    } as never;
    vi.spyOn(registry, "getSandbox").mockReturnValue(damagedEntry);
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      sandboxes: [damagedEntry],
      defaultSandbox: "alpha",
    });

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["telegram"], "openclaw")).toEqual([]);
    expect(deps.findMessagingOverlaps!()).toEqual([]);
    expect(fs.existsSync(callsFile)).toBe(false);
  });

  it("rehydrates same-id receipt rows with the selected package Teams host forward", () => {
    const packageHome = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules/.cache/nemoclaw-status-home-"),
    );
    packageHomes.push(packageHome);
    process.env.HOME = packageHome;
    const storeRoot = path.join(packageHome, ".nemoclaw", "harnesses");
    const selectedFixture = createHarnessPackageFixture({
      fixtureParent: path.join(packageHome, "selected"),
      storeRoot,
    });
    packageFixtures.push(selectedFixture);
    addTeamsOpenClawMessagingAdapter(selectedFixture);
    const selected = selectedFixture.install("openclaw");

    const ambientFixture = createHarnessPackageFixture({
      fixtureParent: path.join(packageHome, "ambient"),
      storeRoot,
    });
    packageFixtures.push(ambientFixture);
    addDisabledOpenClawMessagingAdapter(ambientFixture);
    const ambientRoot = ambientFixture.packageRoots.get("openclaw");
    expect(ambientRoot, "Ambient OpenClaw fixture package root is unavailable").toBeDefined();
    const ambientDeclarationPath = path.join(ambientRoot!, "nemoclaw-package.json");
    const ambientDeclaration = JSON.parse(
      fs.readFileSync(ambientDeclarationPath, "utf8"),
    ) as Record<string, unknown>;
    fs.writeFileSync(
      ambientDeclarationPath,
      `${JSON.stringify({ ...ambientDeclaration, packageVersion: "0.2.0" })}\n`,
      { mode: 0o600 },
    );
    ambientFixture.install("openclaw");

    const sandboxes = ["alpha", "beta"].map((name) => ({
      name,
      agent: "openclaw",
      harnessPackage: selected.identity,
      messaging: {
        schemaVersion: 1,
        plan: compactReceiptTeamsPlan(name, 43978),
      },
    })) as never;
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      sandboxes,
      defaultSandbox: "alpha",
    });

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.findMessagingOverlaps!()).toContainEqual({
      channel: "teams",
      port: 43978,
      sandboxes: ["alpha", "beta"],
      reason: "host-forward-port",
      message: expect.stringContaining("Microsoft Teams webhook port"),
    });
  });

  it("fails closed before a status hook when the exact package receipt is unavailable", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );
    const packageHome = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules/.cache/nemoclaw-status-home-"),
    );
    packageHomes.push(packageHome);
    process.env.HOME = packageHome;
    const fixture = createHarnessPackageFixture({
      fixtureParent: path.join(packageHome, "fixtures"),
      storeRoot: path.join(packageHome, ".nemoclaw", "harnesses"),
    });
    packageFixtures.push(fixture);
    addDisabledOpenClawMessagingAdapter(fixture);
    const installed = fixture.install("openclaw");
    const damagedEntry = {
      name: "alpha",
      agent: "openclaw",
      harnessPackage: installed.identity,
    } as never;
    vi.spyOn(registry, "getSandbox").mockReturnValue(damagedEntry);
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      sandboxes: [damagedEntry],
      defaultSandbox: "alpha",
    });
    fs.rmSync(installed.packageRoot, { recursive: true, force: true });

    const deps = buildStatusCommandDeps(tmp);

    expect(() => deps.checkMessagingBridgeHealth!("alpha", ["telegram"], "openclaw")).toThrow(
      /integrity|package/u,
    );
    expect(() => deps.findMessagingOverlaps!()).toThrow(/integrity|package/u);
    expect(fs.existsSync(callsFile)).toBe(false);
  });

  it("returns null for empty gateway log tails and the log text otherwise", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  case "$*" in
    *"tail -n 10"*) printf 'line one\nline two\n'; exit 0 ;;
  esac
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);
    expect(deps.readGatewayLog?.("alpha")).toBe("line one\nline two");

    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );
    expect(deps.readGatewayLog?.("alpha")).toBeNull();
  });

  it("parses live gateway inference through the OpenShell override", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  echo 'Gateway inference:'
  echo '  Provider: nvidia-prod'
  echo '  Model: nvidia/nemotron'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.getLiveInference()).toEqual({ provider: "nvidia-prod", model: "nvidia/nemotron" });
    expect(fs.readFileSync(callsFile, "utf-8")).toContain("inference get");
  });
});
