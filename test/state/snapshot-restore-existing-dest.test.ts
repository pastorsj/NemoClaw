// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #3756: `snapshot restore --to <dst>` used to
// overwrite the destination silently when <dst> already existed. The new
// behaviour refuses by default and requires --force (with interactive confirm
// or --yes / NEMOCLAW_NON_INTERACTIVE=1) to delete-and-recreate the
// destination from the snapshot.
//
// The --force path preflights both the snapshot selector and the source pod
// image *before* deleting anything (#3756 P1 Codex). A bad selector, a
// missing snapshot, or an unresolvable source image must not be allowed to
// delete `dst` and only fail afterwards.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hashSnapshotBackupContent } from "../../src/lib/state/snapshot/content-digest.js";
import { installHomeHarnessPackageFixture } from "../helpers/harness-packages";
import { execTimeout } from "../helpers/timeouts";

const CLI = path.join(import.meta.dirname, "../..", "bin", "nemoclaw.js");

type CliRunResult = { code: number | null; out: string };

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): CliRunResult {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "status" in err) {
      const e = err as {
        status?: number | null;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const out = [e.stdout, e.stderr]
        .map((b) => (typeof b === "string" ? b : b ? b.toString("utf-8") : ""))
        .join("");
      return { code: typeof e.status === "number" ? e.status : null, out };
    }
    return { code: null, out: String(err) };
  }
}

interface MakeEnvOptions {
  /** When false, omit the snapshot manifest so getLatestBackup returns null. */
  withSnapshot?: boolean;
  /** When false, fake docker exec returns an empty image string. */
  withSourceImage?: boolean;
  /** Put dst on a registered non-default gateway and hide it from src's gateway list. */
  destinationGatewayPort?: number;
  /** When false, the scoped destination list fails before --force can delete it. */
  destinationGatewayListSucceeds?: boolean;
  /** When false, the scoped destination identity lookup fails before deletion. */
  destinationGatewayGetSucceeds?: boolean;
  /** Let the currently-active source gateway also report a same-named destination. */
  sourceGatewayListsDestination?: boolean;
}

/**
 * Build a temp HOME with:
 *  - registry containing `src` and `dst`
 *  - snapshot manifest for `src` at ~/.nemoclaw/rebuild-backups/src/<ts>/rebuild-manifest.json (unless withSnapshot=false)
 *  - fake openshell that:
 *    - `sandbox list -g <gateway>` reports live sandboxes for that gateway
 *      and omits `dst` from later source-gateway listings after deletion
 *    - `status` reports the gateway as Connected
 *    - `sandbox get -g <gateway> dst` returns a stable live identity
 *    - `sandbox delete -g <gateway> dst` exits 0 (and logs the call)
 *    - `sandbox create` exits non-zero (intentional; the integration tests
 *      only need to verify control flow reached/passed the delete step)
 *  - fake docker that:
 *    - `inspect ... State.Running` returns "true" (gateway up)
 *    - `exec ... kubectl get pod src ...` returns an image string (or empty
 *      when withSourceImage=false), exercising resolveSrcPodImage's preflight
 */
function makeExistingDestEnv(
  prefix: string,
  opts: MakeEnvOptions = {},
): { env: Record<string, string>; osLog: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const destinationGatewayName = opts.destinationGatewayPort
    ? `nemoclaw-${opts.destinationGatewayPort}`
    : null;

  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  const harnessPackage = installHomeHarnessPackageFixture(home, "openclaw").identity;
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        src: {
          name: "src",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          agent: null,
          harnessPackage,
        },
        dst: {
          name: "dst",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          agent: null,
          harnessPackage,
          ...(destinationGatewayName
            ? {
                gatewayName: destinationGatewayName,
                gatewayPort: opts.destinationGatewayPort,
              }
            : {}),
        },
      },
      defaultSandbox: "src",
    }),
    { mode: 0o600 },
  );

  if (opts.withSnapshot !== false) {
    const timestamp = "2026-05-19T12-34-56-789Z";
    const snapshotDir = path.join(registryDir, "rebuild-backups", "src", timestamp);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const manifest = {
      version: 2,
      sandboxName: "src",
      timestamp,
      agentType: "openclaw",
      agentVersion: "2026.4.24",
      expectedVersion: null,
      harnessPackage,
      stateDirs: [],
      failedBackupDirs: [],
      backupComplete: true,
      stateFiles: [],
      dir: snapshotDir,
      backupPath: snapshotDir,
      blueprintDigest: null,
      backupContentSha256: hashSnapshotBackupContent(snapshotDir),
    };
    fs.writeFileSync(path.join(snapshotDir, "rebuild-manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
  }

  const osLog = path.join(home, "openshell.log");
  const activeGateway = path.join(home, "active-gateway");
  const deletedDestination = path.join(home, "destination-deleted");
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(osLog)}`,
      `ACTIVE_GATEWAY=${JSON.stringify(activeGateway)}`,
      `DELETED_DESTINATION=${JSON.stringify(deletedDestination)}`,
      'if [ "$1 $2" = "policy get" ]; then',
      "  printf 'version: 1\\nnetwork_policies: {}\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "gateway" ] && [ "$2" = "select" ]; then',
      '  printf "%s\\n" "$3" > "$ACTIVE_GATEWAY"',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      '  gateway="$(if [ "$3" = "-g" ]; then printf "%s" "$4"; else cat "$ACTIVE_GATEWAY" 2>/dev/null || printf "%s" nemoclaw; fi)"',
      destinationGatewayName && opts.destinationGatewayListSucceeds === false
        ? `  if [ "$gateway" = ${JSON.stringify(destinationGatewayName)} ]; then echo "list failed" >&2; exit 17; fi`
        : "  :",
      destinationGatewayName
        ? `  if [ "$gateway" = ${JSON.stringify(destinationGatewayName)} ]; then if [ -e "$DELETED_DESTINATION" ]; then printf "NAME STATUS\\n"; else printf "NAME STATUS\\ndst Ready\\n"; fi; else ${opts.sourceGatewayListsDestination ? 'printf "NAME STATUS\\nsrc Ready\\ndst Ready\\n"' : 'printf "NAME STATUS\\nsrc Ready\\n"'}; fi`
        : '  if [ -e "$DELETED_DESTINATION" ]; then printf "NAME STATUS\nsrc Ready\n"; else printf "NAME STATUS\nsrc Ready\ndst Ready\n"; fi',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
      '  gateway="$(if [ "$3" = "-g" ]; then printf "%s" "$4"; else cat "$ACTIVE_GATEWAY" 2>/dev/null || printf "%s" nemoclaw; fi)"',
      '  sandbox="$(if [ "$3" = "-g" ]; then printf "%s" "$5"; else printf "%s" "$3"; fi)"',
      destinationGatewayName && opts.destinationGatewayGetSucceeds === false
        ? `  if [ "$gateway" = ${JSON.stringify(destinationGatewayName)} ] && [ "$sandbox" = "dst" ]; then echo "get failed" >&2; exit 17; fi`
        : "  :",
      '  if [ "$sandbox" = "dst" ] && [ -e "$DELETED_DESTINATION" ]; then echo "Not found" >&2; exit 1; fi',
      '  printf "Name: %s\\nId: fixture-%s\\nPhase: Ready\\n" "$sandbox" "$sandbox"',
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      '  printf "Status: Connected\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
      '  [ "$3" = "-g" ] || { echo "delete was not gateway-scoped" >&2; exit 42; }',
      destinationGatewayName
        ? `  [ "$4" = ${JSON.stringify(destinationGatewayName)} ] || { echo "delete on wrong gateway: $4" >&2; exit 42; }`
        : '  [ "$4" = "nemoclaw" ] || { echo "delete on wrong gateway: $4" >&2; exit 42; }',
      '  [ "$5" = "dst" ] || { echo "unexpected delete target: $5" >&2; exit 42; }',
      '  touch "$DELETED_DESTINATION"',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "create" ]; then',
      // Intentional non-zero: the test only needs to confirm delete fired
      // and create was reached; not exercising the full create stream.
      '  echo "fake-openshell: sandbox create not mocked end-to-end" >&2',
      "  exit 1",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  const sourceImageOutput =
    opts.withSourceImage === false ? "" : "ghcr.io/nvidia/nemoclaw/sandbox-src:test";
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1" = "inspect" ]; then',
      '  echo "true"',
      "  exit 0",
      "fi",
      'if [ "$1" = "exec" ]; then',
      // The action calls `docker exec <gateway> kubectl get pod <src> ...`.
      // Return the configured image (or an empty string to simulate
      // "image cannot be resolved", which #3756 P1 says must abort before
      // we touch the destination).
      `  printf '%s' ${JSON.stringify(sourceImageOutput)}`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    env: {
      HOME: home,
      NEMOCLAW_OPENSHELL_BIN: path.join(localBin, "openshell"),
      PATH: `${localBin}:${process.env.PATH ?? ""}`,
    },
    osLog,
  };
}

describe("snapshot restore --to existing destination (#3756)", () => {
  it("refuses by default when the destination sandbox already exists", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-refuse-");
    const r = runCli(["src", "snapshot", "restore", "--to", "dst"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Destination sandbox 'dst' already exists/);
    expect(r.out).toMatch(/Re-run with --force/);
    // Critically, no delete is attempted in the refuse path.
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("refuses by default when the destination is registered on another gateway", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-cross-refuse-", {
      destinationGatewayPort: 8090,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Destination sandbox 'dst' already exists/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("refuses by default before running source-image preflight per Codex P2 review (#3796)", () => {
    // Existing destination + unresolvable source image. The user must see the
    // precise "destination exists" error, not the "cannot resolve image"
    // misdirection that would land if the refusal came after preflight.
    const { env } = makeExistingDestEnv("nemoclaw-snap-restore-refuse-before-preflight-", {
      withSourceImage: false,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Destination sandbox 'dst' already exists/);
    expect(r.out).not.toMatch(/Cannot resolve image/);
  });

  it("deletes the destination when --force --yes is set, then proceeds (#3756)", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-force-");
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    // Auto-create is intentionally mocked to fail end-to-end (the fake
    // openshell exits non-zero on `sandbox create`); the test only proves the
    // new --force branch ran through the delete step.
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).toMatch(/sandbox delete -g nemoclaw dst/);
  });

  it("deletes a registered cross-gateway destination on its own gateway before recreating", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-cross-force-", {
      destinationGatewayPort: 8090,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Deleting existing destination 'dst'/);
    const lines = fs.readFileSync(osLog, "utf-8").trim().split("\n");
    const deleteIndex = lines.indexOf("sandbox delete -g nemoclaw-8090 dst");
    expect(deleteIndex).toBeGreaterThan(0);
    expect(lines.slice(0, deleteIndex)).toContain("sandbox list -g nemoclaw-8090");
    expect(lines.slice(0, deleteIndex)).toContain("sandbox get -g nemoclaw-8090 dst");
    expect(lines.slice(deleteIndex + 1)).toContain("gateway select nemoclaw");
  });

  it("aborts before deleting when a registered destination gateway cannot be verified", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-cross-unverified-", {
      destinationGatewayPort: 8090,
      destinationGatewayListSucceeds: false,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Cannot verify destination sandbox 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("aborts before deleting when scoped destination identity lookup fails even if the source gateway lists dst", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-cross-select-fails-", {
      destinationGatewayPort: 8090,
      destinationGatewayGetSucceeds: false,
      sourceGatewayListsDestination: true,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/live identity could not be captured/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).toMatch(/sandbox get -g nemoclaw-8090 dst/);
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("skips the prompt under NEMOCLAW_NON_INTERACTIVE=1 even without --yes", () => {
    const base = makeExistingDestEnv("nemoclaw-snap-restore-noninteractive-");
    const env = { ...base.env, NEMOCLAW_NON_INTERACTIVE: "1" };
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(base.osLog) ? fs.readFileSync(base.osLog, "utf-8") : "";
    expect(log).toMatch(/sandbox delete -g nemoclaw dst/);
  });

  // #3756 P1: preflight failures must not delete the destination.
  it("does NOT delete the destination when no snapshot is found (--force --yes)", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-no-snap-", {
      withSnapshot: false,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No snapshots found for 'src'/);
    expect(r.out).not.toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("does NOT delete the destination when the selector resolves to nothing (--force --yes)", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-bad-selector-");
    const r = runCli(
      ["src", "snapshot", "restore", "not-a-real-snap", "--to", "dst", "--force", "--yes"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No snapshot matching 'not-a-real-snap' found/);
    expect(r.out).not.toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });

  it("does NOT delete the destination when the source pod image cannot be resolved (--force --yes)", () => {
    const { env, osLog } = makeExistingDestEnv("nemoclaw-snap-restore-no-image-", {
      withSourceImage: false,
    });
    const r = runCli(["src", "snapshot", "restore", "--to", "dst", "--force", "--yes"], env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Cannot resolve image for source sandbox 'src'/);
    expect(r.out).toMatch(/aborting before deleting 'dst'/);
    expect(r.out).not.toMatch(/Deleting existing destination 'dst'/);
    const log = fs.existsSync(osLog) ? fs.readFileSync(osLog, "utf-8") : "";
    expect(log).not.toMatch(/sandbox delete/);
  });
});
