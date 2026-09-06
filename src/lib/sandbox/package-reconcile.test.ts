// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { HarnessInferenceConfigPostCommit } from "../agent-runtime/config-module";
import { installHarnessPackage } from "../agent-runtime/package/install";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { SandboxEntry } from "../state/registry";
import {
  PackageSandboxReconcileError,
  type PackageSandboxReconcileDependencies,
  reconcilePackageSandbox,
  resolvePackageRuntimeIdentity,
} from "./package-reconcile";

const IDENTITY = {
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
} as const satisfies HarnessPackageIdentity;

const DECLARATION = {
  kind: "command",
  trigger: "when-config-changes",
  command: ["/usr/local/lib/nemoclaw/inference-reconcile", "literal;not-shell"],
  timeoutSeconds: 30,
} as const satisfies Extract<
  HarnessInferenceConfigPostCommit["sandboxReconcile"],
  { readonly kind: "command" }
>;

function sandbox(identity: HarnessPackageIdentity | null = IDENTITY): SandboxEntry {
  return { name: "alpha", harnessPackage: identity } as SandboxEntry;
}

function dependencies(
  result: Partial<ReturnType<PackageSandboxReconcileDependencies["executeCommand"]>> = {},
): PackageSandboxReconcileDependencies & {
  executeCommand: ReturnType<typeof vi.fn>;
  getSandbox: ReturnType<typeof vi.fn>;
  resolveTarget: ReturnType<typeof vi.fn>;
} {
  const requestId = "b".repeat(64);
  return {
    getSandbox: vi.fn(() => sandbox()),
    randomRequestId: () => requestId,
    resolveRuntimeIdentity: vi.fn(() => ({ uid: 4321, gid: 4322 })),
    resolveTarget: vi.fn(() => ({ providerId: "docker", resourceHandle: "container-1" })),
    executeCommand: vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(`${JSON.stringify({ status: "converged", requestId })}\n`),
      stderr: Buffer.alloc(0),
      ...result,
    })),
  };
}

describe("package sandbox reconciliation", () => {
  it("pins the execution identity to the exact installed package receipt", () => {
    const parent = path.join(process.cwd(), "node_modules/.cache/nemoclaw-reconcile-tests");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const fixture = fs.mkdtempSync(path.join(parent, "fixture-"));
    const source = path.join(fixture, "source");
    const storeRoot = path.join(fixture, "store");
    const manifestPath = path.join(source, "packages/nemoclaw-future-harness/manifest.yaml");
    const metadataPath = path.join(source, "nemoclaw-package.json");
    const writePackage = (version: string, uid: number, gid: number) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "agent-runtime",
          id: "future-harness",
          displayName: "Future Harness",
          packageVersion: version,
          minimumNemoClawVersion: "0.0.113",
          maximumNemoClawVersionExclusive: "0.0.121",
          manifest: "packages/nemoclaw-future-harness/manifest.yaml",
        })}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(
        manifestPath,
        [
          "name: future-harness",
          "display_name: Future Harness",
          "managed_image:",
          "  repository: nvcr.io/nvidia/nemoclaw-future-harness",
          "  architectures: [linux/amd64]",
          "  runtime_identity:",
          `    uid: ${String(uid)}`,
          `    gid: ${String(gid)}`,
          "    workdir: /sandbox",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    };
    try {
      fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
      writePackage("1.0.0", 4321, 4322);
      const first = installHarnessPackage(
        {
          packageRoot: source,
          expectedId: "future-harness",
          sourceIdentity: { kind: "local" },
        },
        { storeRoot },
      );
      writePackage("2.0.0", 9001, 9002);
      const second = installHarnessPackage(
        {
          packageRoot: source,
          expectedId: "future-harness",
          sourceIdentity: { kind: "local" },
        },
        { storeRoot },
      );

      expect(resolvePackageRuntimeIdentity(first.identity, { storeRoot })).toEqual({
        uid: 4321,
        gid: 4322,
      });
      expect(resolvePackageRuntimeIdentity(second.identity, { storeRoot })).toEqual({
        uid: 9001,
        gid: 9002,
      });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("runs exact argv as the receipt-pinned numeric runtime identity", () => {
    const deps = dependencies();

    reconcilePackageSandbox("alpha", IDENTITY, DECLARATION, deps);

    expect(deps.executeCommand).toHaveBeenCalledWith("alpha", DECLARATION.command, {
      executionUser: { uid: 4321, gid: 4322 },
      expectedProviderId: "docker",
      expectedResourceHandle: "container-1",
      input: `${JSON.stringify({ requestId: "b".repeat(64) })}\n`,
      maxOutputBytes: 4096,
      sanitizeEnvironment: true,
      timeout: 30_000,
    });
  });

  it("refuses a changed package receipt before command execution", () => {
    const deps = dependencies();
    deps.getSandbox.mockReturnValue(sandbox({ ...IDENTITY, contentDigest: "c".repeat(64) }));

    expect(() => reconcilePackageSandbox("alpha", IDENTITY, DECLARATION, deps)).toThrow(
      PackageSandboxReconcileError,
    );
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.executeCommand).not.toHaveBeenCalled();
  });

  it("refuses a package receipt changed while the command runs", () => {
    const deps = dependencies();
    deps.getSandbox.mockReturnValueOnce(sandbox()).mockReturnValueOnce(sandbox(null));

    expect(() => reconcilePackageSandbox("alpha", IDENTITY, DECLARATION, deps)).toThrow(
      PackageSandboxReconcileError,
    );
    expect(deps.executeCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 1 },
    { signal: "SIGTERM" as NodeJS.Signals },
    { error: new Error("secret-token") },
    { stderr: Buffer.from("secret-token") },
    { stdout: Buffer.from('{"status":"converged","requestId":"stale"}\n') },
    {
      stdout: Buffer.from(
        `${JSON.stringify({ status: "converged", requestId: "b".repeat(64), detail: "extra" })}\n`,
      ),
    },
    {
      stdout: Buffer.from(
        `${JSON.stringify({ status: "converged", requestId: "b".repeat(64) })}\nextra\n`,
      ),
    },
  ])("fails closed for an invalid command result without surfacing diagnostics", (result) => {
    const deps = dependencies(result);

    let error: unknown;
    try {
      reconcilePackageSandbox("alpha", IDENTITY, DECLARATION, deps);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackageSandboxReconcileError);
    expect(String(error)).not.toContain("secret-token");
  });

  it.each([
    { uid: 0, gid: 4322 },
    { uid: 4321, gid: 0 },
    { uid: 1.5, gid: 4322 },
    { uid: 4321, gid: 2_147_483_648 },
  ])("rejects an invalid package runtime identity before resolving the target", (identity) => {
    const deps = {
      ...dependencies(),
      resolveRuntimeIdentity: vi.fn(() => identity),
    };

    expect(() => reconcilePackageSandbox("alpha", IDENTITY, DECLARATION, deps)).toThrow(
      PackageSandboxReconcileError,
    );
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.executeCommand).not.toHaveBeenCalled();
  });

  it.each([["relative-command"], ["/usr/bin/../bin/python3"], ["/usr/bin/python3\n--escape"]])(
    "refuses an unsafe executable declaration",
    (command) => {
      const deps = dependencies();

      expect(() =>
        reconcilePackageSandbox("alpha", IDENTITY, { ...DECLARATION, command: [command] }, deps),
      ).toThrow(PackageSandboxReconcileError);
      expect(deps.executeCommand).not.toHaveBeenCalled();
    },
  );
});
