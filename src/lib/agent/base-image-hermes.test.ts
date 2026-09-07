// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";
import { dockerRunCommandBetween } from "../../../test/helpers/dockerfile-run-shell";

function hermesPackageProbeSuccess(): string {
  const probe = fs.readFileSync(
    path.join(process.cwd(), "packages/nemoclaw-hermes/checks/image-probe.py"),
  );
  return `nemoclaw-image-probe-ok ${crypto.createHash("sha256").update(probe).digest("hex")}`;
}

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a Hermes base only after its package-bound probe and security inventory succeed", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };

      dockerCaptureMock
        .mockReturnValueOnce(hermesPackageProbeSuccess())
        .mockReturnValueOnce("nemoclaw-security-inventory-ok");
      expect(options.validateImage?.("hermes-base:test")).toBe(true);
      const [probeArgs, probeOptions] = dockerCaptureMock.mock.calls[0] as [string[], object];
      expect(probeArgs).toEqual([
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "998:999",
        "--entrypoint",
        "/usr/local/lib/nemoclaw/checks/image-probe.py",
        "hermes-base:test",
      ]);
      expect(probeOptions).toEqual({ ignoreError: true, timeout: 20_000 });
      expect(dockerCaptureMock.mock.calls[1]?.[0]).toEqual(
        expect.arrayContaining([
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--read-only",
          "hermes-base:test",
          expect.stringContaining("nemoclaw-security-inventory-ok"),
        ]),
      );

      dockerCaptureMock.mockReturnValue("");
      expect(options.validateImage?.("hermes-base:stale")).toBe(false);

      dockerCaptureMock.mockReturnValue(`${hermesPackageProbeSuccess()}\nunexpected-output`);
      expect(options.validateImage?.("hermes-base:unexpected-output")).toBe(false);
    });
  });

  it("rejects a Hermes base that passes its package probe but lacks the security inventory", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };
      dockerCaptureMock.mockReturnValueOnce(hermesPackageProbeSuccess()).mockReturnValueOnce("");

      expect(options.validateImage?.("hermes-base:stale-inventory")).toBe(false);
      expect(dockerCaptureMock).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a Hermes base that fails its package-bound probe", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };
      dockerCaptureMock.mockReturnValue("");

      expect(options.validateImage?.("hermes-base:mcp-only")).toBe(false);
      expect(dockerCaptureMock).toHaveBeenLastCalledWith(
        expect.arrayContaining([
          "hermes-base:mcp-only",
          "/usr/local/lib/nemoclaw/checks/image-probe.py",
        ]),
        { ignoreError: true, timeout: 20_000 },
      );
    });
  });

  it("fails before candidate resolution when the Hermes final Dockerfile is unreadable", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      expect(() =>
        ensureAgentBaseImage(makeAgent({ dockerfilePath: "/missing/hermes/Dockerfile" })),
      ).toThrow("Failed to read Hermes Agent final Dockerfile");
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("fails a forced rebuild before deletion when the built base fails validation", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue(null);

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "failed the required runtime compatibility checks",
      );
    });
  }, 60_000);

  it("reports forced-rebuild typed validation failures as compatibility diagnostics and cleans up (#6624)", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        resolveSandboxBaseImageMock,
        dockerRmiMock,
        SandboxBaseImageResolutionError,
      }) => {
        resolveSandboxBaseImageMock.mockImplementation(() => {
          throw new SandboxBaseImageResolutionError("exact validation failed");
        });

        let error: Error | null = null;
        try {
          ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        } catch (caught) {
          error = caught as Error;
        }

        expect(error?.message).toBe(
          "Built Hermes Agent base image failed the required runtime compatibility checks",
        );
        expect(error?.message).not.toContain("exact validation failed");
        const temporaryTag = dockerBuildMock.mock.calls[0]?.[1];
        expect(temporaryTag).toEqual(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
        );
        expect(dockerRmiMock).toHaveBeenCalledWith(temporaryTag, {
          ignoreError: true,
          suppressOutput: true,
        });
      },
    );
  }, 60_000);

  it("validates an explicit override strictly instead of falling back", () => {
    const envVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const prior = process.env[envVar];
    process.env[envVar] = "localhost:5000/custom/hermes:latest";
    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: process.env[envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "Hermes Agent final image does not accept base image ref",
        );
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: "localhost:5000/custom/hermes:latest",
            env: expect.objectContaining({
              [envVar]: "localhost:5000/custom/hermes:latest",
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
          }),
        );
      });
    } finally {
      prior === undefined ? delete process.env[envVar] : (process.env[envVar] = prior);
    }
  });

  it("fails closed when no required-runtime-compatible Hermes base image can be resolved", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
      }) => {
        resolveSandboxBaseImageMock.mockReturnValue(null);
        dockerImageInspectMock.mockReturnValue({ status: 1 });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "No compatible Hermes Agent sandbox base image found",
        );
        expect(dockerBuildMock).not.toHaveBeenCalled();
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
      },
    );
  });
});
