// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PackageDockerfilePlan } from "./dockerfile-patch";
import { patchPackageDockerfile } from "./dockerfile-patch";

const temporaryRoots: string[] = [];

function dockerfileWith(contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-patch-"));
  temporaryRoots.push(root);
  const dockerfilePath = path.join(root, "Dockerfile");
  fs.writeFileSync(dockerfilePath, contents, "utf8");
  return dockerfilePath;
}

function plan(input: Partial<PackageDockerfilePlan> = {}): PackageDockerfilePlan {
  return {
    packageId: "future-harness",
    configurationEnvironment: {},
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: null,
      },
    ],
    dashboardRemoteBindPrepared: false,
    ...input,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("receipt-backed package Dockerfile patch", () => {
  it("uses only the package plan and core-owned build inputs", () => {
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "999999");
    vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL", "1");
    vi.stubEnv("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER", "1");
    const dockerfilePath = dockerfileWith(
      [
        "ARG BASE_IMAGE=old-base",
        "FROM ${BASE_IMAGE}",
        "ARG NEMOCLAW_MODEL=old-model",
        "ARG FUTURE_RUNTIME_MODE=old-mode",
        "ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled",
        "ARG NEMOCLAW_CONTEXT_WINDOW=unchanged",
        "ARG NEMOCLAW_OPENCLAW_OTEL=unchanged",
        "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=unchanged",
        "ARG NEMOCLAW_BUILD_ID=old-build",
        "ENV IMAGE_BUILD_ID=${NEMOCLAW_BUILD_ID}",
      ].join("\n"),
    );

    expect(
      patchPackageDockerfile({
        dockerfilePath,
        buildId: "build-42",
        baseImageRef: "registry.example/base@sha256:abc",
        trustedManagedDockerfile: true,
        environment: process.env,
        plan: plan({
          configurationEnvironment: {
            FUTURE_RUNTIME_MODE: "package-mode",
            NEMOCLAW_MODEL: "package-model",
          },
          materials: [
            {
              kind: "corporate-ca-handoff",
              legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
              expectedSha256: null,
            },
            {
              kind: "root-owned-file",
              legacyInput: "NEMOCLAW_DCODE_AUTO_APPROVAL",
              path: "/usr/local/share/nemoclaw/approval-mode",
              contents: "thread-opt-in\n",
              owner: "root",
              group: "root",
              mode: 0o444,
            },
          ],
        }),
      }),
    ).toEqual({ dashboardRemoteBindPrepared: false });

    const patched = fs.readFileSync(dockerfilePath, "utf8");
    expect(patched).toContain("ARG BASE_IMAGE=registry.example/base@sha256:abc");
    expect(patched).toContain("ARG NEMOCLAW_BUILD_ID=build-42");
    expect(patched).toContain("ARG NEMOCLAW_MODEL=package-model");
    expect(patched).toContain("ARG FUTURE_RUNTIME_MODE=package-mode");
    expect(patched).toContain("ARG NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in");
    expect(patched).toContain("ARG NEMOCLAW_CONTEXT_WINDOW=unchanged");
    expect(patched).toContain("ARG NEMOCLAW_OPENCLAW_OTEL=unchanged");
    expect(patched).toContain("ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=unchanged");
  });

  it("preserves the package profile remote-dashboard result", () => {
    const dockerfilePath = dockerfileWith(
      ["FROM ubuntu:24.04", "ARG NEMOCLAW_DASHBOARD_BIND=", "ARG NEMOCLAW_BUILD_ID=stable"].join(
        "\n",
      ),
    );

    expect(
      patchPackageDockerfile({
        dockerfilePath,
        buildId: "unused",
        baseImageRef: null,
        trustedManagedDockerfile: true,
        plan: plan({
          configurationEnvironment: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
          dashboardRemoteBindPrepared: true,
        }),
      }),
    ).toEqual({ dashboardRemoteBindPrepared: true });
    expect(fs.readFileSync(dockerfilePath, "utf8")).toContain(
      "ARG NEMOCLAW_DASHBOARD_BIND=0.0.0.0",
    );
    expect(fs.readFileSync(dockerfilePath, "utf8")).toContain("ARG NEMOCLAW_BUILD_ID=stable");
  });

  it("rejects a package plan that disagrees with its dashboard result", () => {
    const dockerfilePath = dockerfileWith(
      "FROM ubuntu:24.04\nARG NEMOCLAW_DASHBOARD_BIND=\nARG NEMOCLAW_BUILD_ID=stable\n",
    );

    expect(() =>
      patchPackageDockerfile({
        dockerfilePath,
        buildId: "unused",
        baseImageRef: null,
        trustedManagedDockerfile: true,
        plan: plan({
          configurationEnvironment: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
        }),
      }),
    ).toThrow(/dashboard build state does not match/u);
  });

  it("rejects undeclared and core-owned package inputs", () => {
    const source = "FROM ubuntu:24.04\nARG NEMOCLAW_BUILD_ID=stable\n";
    const missingPath = dockerfileWith(source);
    const corePath = dockerfileWith(source);

    expect(() =>
      patchPackageDockerfile({
        dockerfilePath: missingPath,
        buildId: "unused",
        baseImageRef: null,
        trustedManagedDockerfile: true,
        plan: plan({ configurationEnvironment: { FUTURE_RUNTIME_MODE: "enabled" } }),
      }),
    ).toThrow(/exactly one ARG FUTURE_RUNTIME_MODE; found 0/u);
    expect(() =>
      patchPackageDockerfile({
        dockerfilePath: corePath,
        buildId: "unused",
        baseImageRef: null,
        trustedManagedDockerfile: true,
        plan: plan({ configurationEnvironment: { NEMOCLAW_BUILD_ID: "package-value" } }),
      }),
    ).toThrow(/forbidden Docker build argument NEMOCLAW_BUILD_ID/u);
  });

  it("rejects Dockerfile continuation syntax without changing the recipe", () => {
    const source =
      "FROM ubuntu:24.04\nARG FUTURE_RUNTIME_MODE=disabled\nARG NEMOCLAW_BUILD_ID=stable\n";
    const dockerfilePath = dockerfileWith(source);

    expect(() =>
      patchPackageDockerfile({
        dockerfilePath,
        buildId: "unused",
        baseImageRef: null,
        trustedManagedDockerfile: true,
        plan: plan({ configurationEnvironment: { FUTURE_RUNTIME_MODE: "unsafe\\" } }),
      }),
    ).toThrow(/must be single-line text/u);
    expect(fs.readFileSync(dockerfilePath, "utf8")).toBe(source);
  });

  it("applies receipt-bound corporate CA material through the root startup contract", () => {
    const pem = "receipt-bound-ca\n";
    const corporateCaB64 = Buffer.from(pem, "utf8").toString("base64");
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_CORPORATE_CA_B64=",
        "FROM ubuntu:24.04",
        "ARG NEMOCLAW_CORPORATE_CA_B64",
        "ARG NEMOCLAW_BUILD_ID=stable",
        "ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=sandbox",
        "USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}",
        'ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]',
      ].join("\n"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    patchPackageDockerfile({
      dockerfilePath,
      buildId: "unused",
      baseImageRef: null,
      trustedManagedDockerfile: true,
      plan: plan({
        corporateCaB64,
        materials: [
          {
            kind: "corporate-ca-handoff",
            legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
            expectedSha256: createHash("sha256").update(pem, "utf8").digest("hex"),
          },
        ],
      }),
    });

    const patched = fs.readFileSync(dockerfilePath, "utf8");
    expect(patched).toContain(`ARG NEMOCLAW_CORPORATE_CA_B64=${corporateCaB64}`);
    expect(patched).toContain("ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root");
  });
});
