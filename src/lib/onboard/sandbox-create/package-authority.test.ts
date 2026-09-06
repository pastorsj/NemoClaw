// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  prepareSourceBackupAuthority,
  requireSandboxDockerfilePatchPackageRoot,
  requireSelectedAgentPackageRoot,
} from "./orchestration";

describe("selected agent package authority", () => {
  const SOURCE_PACKAGE = {
    kind: "agent-runtime" as const,
    id: "hermes",
    packageVersion: "0.13.0",
    contentDigest: "a".repeat(64),
  };
  const SOURCE_ENTRY = {
    name: "alpha",
    agent: "hermes",
    harnessPackage: SOURCE_PACKAGE,
  };
  const SOURCE_DEFINITION = {
    name: "hermes",
    packageRoot: `/state/harnesses/objects/${SOURCE_PACKAGE.contentDigest}`,
  } as AgentDefinition;

  it("keeps the OpenClaw null sentinel separate from its effective package root", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-")),
    );
    try {
      const effectiveAgent = {
        name: "openclaw",
        displayName: "OpenClaw",
        packageRoot,
      } as AgentDefinition;
      expect(requireSelectedAgentPackageRoot(null, effectiveAgent)).toBe(packageRoot);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects mismatched and missing package authority before creation", () => {
    const missingRoot = path.join(os.tmpdir(), `nemoclaw-missing-package-${String(process.pid)}`);
    expect(() =>
      requireSelectedAgentPackageRoot(
        { name: "hermes" } as AgentDefinition,
        { name: "openclaw", packageRoot: missingRoot } as AgentDefinition,
      ),
    ).toThrow("does not match effective definition");
    expect(() =>
      requireSelectedAgentPackageRoot(null, {
        name: "openclaw",
        packageRoot: missingRoot,
      } as AgentDefinition),
    ).toThrow("package root is missing");
  });

  it("rejects a same-name definition from a different package root", () => {
    const recordedRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recorded-package-")),
    );
    const effectiveRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-effective-package-")),
    );
    try {
      expect(() =>
        requireSelectedAgentPackageRoot(
          { name: "hermes", packageRoot: recordedRoot } as AgentDefinition,
          { name: "hermes", packageRoot: effectiveRoot } as AgentDefinition,
        ),
      ).toThrow("package root does not match its effective definition");
    } finally {
      fs.rmSync(recordedRoot, { recursive: true, force: true });
      fs.rmSync(effectiveRoot, { recursive: true, force: true });
    }
  });

  it("uses the legacy OpenClaw root for a custom Dockerfile without a package receipt", () => {
    const hermesRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-package-")),
    );
    const openClawRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-")),
    );
    try {
      const hermes = { name: "hermes", packageRoot: hermesRoot } as AgentDefinition;
      const openClaw = {
        name: "openclaw",
        packageRoot: openClawRoot,
      } as AgentDefinition;
      expect(
        requireSandboxDockerfilePatchPackageRoot(
          "/tmp/Containerfile",
          hermes,
          false,
          () => openClaw,
        ),
      ).toBe(openClawRoot);
      expect(requireSandboxDockerfilePatchPackageRoot(null, hermes, false, () => openClaw)).toBe(
        hermesRoot,
      );
    } finally {
      fs.rmSync(hermesRoot, { recursive: true, force: true });
      fs.rmSync(openClawRoot, { recursive: true, force: true });
    }
  });

  it("uses an unknown receipt-backed package root for its custom Dockerfile patch", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-future-package-")),
    );
    try {
      const future = { name: "future-harness", packageRoot } as AgentDefinition;
      const loadLegacyOpenClaw = vi.fn<() => AgentDefinition>();

      expect(
        requireSandboxDockerfilePatchPackageRoot(
          "/tmp/Containerfile",
          future,
          true,
          loadLegacyOpenClaw,
        ),
      ).toBe(packageRoot);
      expect(loadLegacyOpenClaw).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("selects pre-recreate backup authority from the registered source agent", () => {
    const resolveSandboxAgent = vi.fn(() => ({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
      harnessPackageMigration: null,
    }));
    const getSandbox = vi.fn(() => structuredClone(SOURCE_ENTRY));

    const authority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(authority).toMatchObject({
      agentDefinition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
    });
    expect(() => authority?.validateBeforePublish?.()).not.toThrow();
    expect(resolveSandboxAgent).toHaveBeenCalledTimes(2);
  });

  it("does not treat a fresh route reservation as a source sandbox", () => {
    const resolveSandboxAgent = vi.fn();
    const reservation: SandboxEntry = {
      name: "alpha",
      pendingRouteReservation: true,
      reservationSessionId: "session-alpha",
      provider: "compatible-endpoint",
      model: "test-model",
      gatewayName: "nemoclaw",
      harnessPackage: SOURCE_PACKAGE,
    };

    expect(
      prepareSourceBackupAuthority("alpha", reservation, {
        getSandbox: vi.fn(),
        resolveSandboxAgent: resolveSandboxAgent as never,
      }),
    ).toBeNull();
    expect(resolveSandboxAgent).not.toHaveBeenCalled();
  });

  it("keeps backup authority for a route reservation over a registered sandbox", () => {
    const resolveSandboxAgent = vi.fn(() => ({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
      harnessPackageMigration: null,
    }));
    const registeredReservation: SandboxEntry = {
      ...SOURCE_ENTRY,
      pendingRouteReservation: true,
      reservationSessionId: "session-alpha",
      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const authority = prepareSourceBackupAuthority("alpha", registeredReservation, {
      getSandbox: () => structuredClone(registeredReservation),
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(authority).toMatchObject({
      agentDefinition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
    });
    expect(resolveSandboxAgent).toHaveBeenCalledOnce();
  });

  it("rejects source registry or package-object drift before backup publication", () => {
    let currentEntry = structuredClone(SOURCE_ENTRY) as SandboxEntry;
    const changedDefinition = {
      ...SOURCE_DEFINITION,
      packageRoot: "/state/harnesses/objects/replaced",
    } as AgentDefinition;
    const resolveSandboxAgent = vi
      .fn()
      .mockReturnValueOnce({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: SOURCE_DEFINITION,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      })
      .mockReturnValue({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: changedDefinition,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      });
    const getSandbox = vi.fn(() => currentEntry);
    const packageDriftAuthority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(() => packageDriftAuthority?.validateBeforePublish?.()).toThrow("source agent package");

    currentEntry = { ...SOURCE_ENTRY, model: "changed-model" };
    const rowDriftAuthority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: vi.fn(() => ({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: SOURCE_DEFINITION,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      })) as never,
    });
    expect(() => rowDriftAuthority?.validateBeforePublish?.()).toThrow("source registry row");
  });
});
