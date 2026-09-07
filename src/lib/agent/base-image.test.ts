// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { materializeHarnessPackageArtifact } from "@nvidia/nemoclaw-harness-contract/build-package";

import { missingDockerfileContextSources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";
import { removeFixtureDirectories } from "../../../test/helpers/fixture-permissions";
import { testTimeout } from "../../../test/helpers/timeouts";
import { tmpDir, writeCa } from "../onboard/__test-helpers__/corporate-ca-fixtures";
import {
  createSandboxBaseImageBuildProvenanceKey,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { loadAgent } from "./defs";
import { loadValidatedHarnessManifest, readString } from "../agent-runtime/manifest-readers";
import { installHarnessPackage } from "../agent-runtime/package/install";
import { stageAgentComposedBuildContext } from "./base-image";

function makeResolutionMetadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "resolution-key",
    imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
    ref: "nemoclaw-hermes-sandbox-base-local:compatible",
    digest: null,
    source: "local",
    imageId: `sha256:${"a".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    glibcVersion: process.platform === "linux" ? "2.41" : null,
    requireOpenshellSandboxAbi: process.platform === "linux",
    minGlibcVersion: "2.39",
    ...overrides,
  };
}

function makeDifferingImageInspection(
  format: string,
  imageRef: string,
  localRef: string,
  pinnedRef: string,
): string {
  return format === "{{json .}}"
    ? JSON.stringify({
        Id: imageRef === localRef ? `sha256:${"a".repeat(64)}` : `sha256:${"b".repeat(64)}`,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [pinnedRef],
      })
    : "";
}

const PACKAGES_DIR = path.resolve(import.meta.dirname, "../../../packages");

function agentPackageDir(agentName: string): string {
  return path.join(PACKAGES_DIR, `nemoclaw-${agentName}`);
}

function declaresCorporateCaBuildArg(dockerfilePath: string): boolean {
  return (
    fs.existsSync(dockerfilePath) &&
    fs.readFileSync(dockerfilePath, "utf8").includes("ARG NEMOCLAW_CORPORATE_CA_B64")
  );
}

function readManifestExpectedVersion(agentName: string): string {
  const manifestPath = path.join(agentPackageDir(agentName), "manifest.yaml");
  const expectedVersion = readString(
    loadValidatedHarnessManifest(manifestPath, agentName),
    "expected_version",
  );
  expect(
    expectedVersion,
    `agent '${agentName}' must declare expected_version in ${manifestPath}`,
  ).toBeTruthy();
  return expectedVersion ?? "";
}

function packageImageProbeMarker(agentName: string): string {
  const probe = fs.readFileSync(path.join(agentPackageDir(agentName), "checks/image-probe.py"));
  return `nemoclaw-image-probe-ok ${crypto.createHash("sha256").update(probe).digest("hex")}`;
}

// Read the agent names from the checked-in Dockerfiles so a base image that
// starts consuming the corporate CA cannot ship without the build argument.
const CORPORATE_CA_BASE_IMAGE_AGENTS = fs
  .readdirSync(PACKAGES_DIR)
  .filter((directoryName) => directoryName.startsWith("nemoclaw-"))
  .map((directoryName) => directoryName.slice("nemoclaw-".length))
  .filter((agentName) =>
    declaresCorporateCaBuildArg(path.join(agentPackageDir(agentName), "Dockerfile.base")),
  );

expect(
  CORPORATE_CA_BASE_IMAGE_AGENTS,
  "expected at least one agent base image to declare the corporate CA build arg",
).not.toHaveLength(0);

describe("agent base image provisioning", { timeout: testTimeout(60_000) }, () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS", "");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "requires an operator-prepared NemoCUA sandbox image (#9649)",
    () => {
      const agent = loadAgent("nemocua", { NEMOCLAW_CUA_ENABLED: "1" });
      vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");

      withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
        expect(() => ensureAgentBaseImage(agent)).toThrow("NEMOCLAW_CUA_SANDBOX_IMAGE_REF");
        expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).not.toHaveBeenCalled();
      });
    },
    testTimeout(15_000),
  );

  it("uses the prepared NemoCUA image without a nested base build (#9649)", () => {
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    vi.stubEnv("NEMOCLAW_CUA_SANDBOX_IMAGE_REF", "nemocua-scenario:staged");
    const agent = loadAgent("nemocua");

    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
      expect(ensureAgentBaseImage(agent)).toEqual({
        imageTag: "nemocua-scenario:staged",
        built: false,
      });
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
      expect(dockerBuildMock).not.toHaveBeenCalled();
    });
  });

  it("stages only the NemoCUA Dockerfile in the caller-image build context (#9649)", () => {
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    vi.stubEnv("NEMOCLAW_CUA_SANDBOX_IMAGE_REF", "nemocua-scenario:staged");
    const agent = loadAgent("nemocua");
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "unrelated-sentinel.txt"), "must not enter build context");
    let buildContext = root;

    try {
      withMockedDocker(({ createAgentSandbox }) => {
        const result = createAgentSandbox(agent, { rootDir: root });
        buildContext = result.buildCtx;
        expect(fs.readdirSync(result.buildCtx)).toEqual(["Dockerfile"]);
        expect(fs.existsSync(path.join(result.buildCtx, "unrelated-sentinel.txt"))).toBe(false);
        expect(fs.readFileSync(result.stagedDockerfile, "utf8")).toContain(
          "ARG BASE_IMAGE=nemocua-scenario:staged",
        );
      });
    } finally {
      fs.rmSync(buildContext, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "stages managed sandbox bytes from the selected package root",
    () => {
      const packageRoot = fs.realpathSync(tmpDir());
      const agentDir = packageRoot;
      const dockerfilePath = path.join(agentDir, "Dockerfile");
      fs.writeFileSync(path.join(agentDir, "manifest.yaml"), "name: pi\n");
      fs.writeFileSync(
        dockerfilePath,
        "FROM scratch\nCOPY packages/nemoclaw-pi/package-sentinel.txt /sandbox/\n",
      );
      fs.writeFileSync(path.join(packageRoot, "package-sentinel.txt"), "selected-package");
      let buildContext: string | null = null;
      try {
        withMockedDocker(({ createAgentSandbox, resolveSandboxBaseImageMock, dockerBuildMock }) => {
          const result = createAgentSandbox(
            makeAgent({
              name: "pi",
              displayName: "Pi",
              packageRoot,
              agentDir,
              manifestPath: path.join(agentDir, "manifest.yaml"),
              dockerfilePath,
              dockerfileBasePath: null,
            }),
          );
          buildContext = result.buildCtx;
          expect(
            fs.readFileSync(
              path.join(result.buildCtx, "packages", "nemoclaw-pi", "package-sentinel.txt"),
              "utf8",
            ),
          ).toBe("selected-package");
          expect(
            fs
              .readdirSync(path.join(result.buildCtx, "packages"))
              .filter((entry) => entry.startsWith("nemoclaw-"))
              .sort(),
          ).toEqual(["nemoclaw-fabric", "nemoclaw-pi"]);
          expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
          expect(dockerBuildMock).not.toHaveBeenCalled();
        });
      } finally {
        fs.rmSync(buildContext ?? path.join(packageRoot, ".missing-build-context"), {
          recursive: true,
          force: true,
        });
        fs.rmSync(packageRoot, { recursive: true, force: true });
      }
    },
    testTimeout(60_000),
  );

  it(
    "stages a materialized unknown package without leaking sibling harnesses",
    () => {
      const root = fs.realpathSync(tmpDir());
      const sourceRoot = path.join(root, "source");
      const artifactRoot = path.join(root, "artifact");
      fs.mkdirSync(sourceRoot);
      const write = (relativePath: string, contents: string, mode = 0o644) => {
        const target = path.join(sourceRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, { mode });
      };
      const dockerfile = [
        "FROM scratch",
        "COPY packages/nemoclaw-context-probe/start.sh /usr/local/bin/nemoclaw-start",
        "COPY packages/nemoclaw-fabric/src/ /opt/nemoclaw-fabric/src/",
        "COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/",
        "",
      ].join("\n");
      write(
        "package.json",
        `${JSON.stringify({
          name: "@example/nemoclaw-context-probe",
          version: "0.1.0",
          files: [
            "Dockerfile",
            "Dockerfile.base",
            "host/config-adapter.cts",
            "host/messaging-adapter.cts",
            "host/startup-adapter.cts",
            "manifest.yaml",
            "policy-additions.yaml",
            "start.sh",
          ],
          nemoclaw: {
            harnessManifest: "manifest.yaml",
            minimumNemoClawVersion: "0.0.113",
            maximumNemoClawVersionExclusive: "0.0.121",
          },
        })}\n`,
      );
      write("Dockerfile", dockerfile);
      write("Dockerfile.base", dockerfile);
      write(
        "manifest.yaml",
        [
          "name: context-probe",
          'display_name: "Context Probe"',
          "runtime:",
          "  kind: terminal",
          "  prompt_transport: stdin",
          "  headless_command: context-probe --prompt",
          "config:",
          "  dir: /sandbox/.context-probe",
          "  config_file: config.json",
          "  format: json",
          "inference:",
          "  config_update:",
          "    support: unsupported",
          "    reason: This fixture uses fixed inference configuration.",
          "state_lifecycle:",
          "  backup_quiescence:",
          "    kind: not-required",
          "  snapshot_restore: []",
          "  rebuild:",
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
          "    scheduled_work:",
          "      support: disabled",
          "      reason: This fixture does not run scheduled work.",
          "    post_restore:",
          "      kind: not-required",
          "mcp:",
          "  support: disabled",
          "messaging:",
          "  support: disabled",
          "policy:",
          "  owned_presets: []",
          "  automatic_presets: []",
          "  baseline_exclusion_impacts: {}",
          "",
        ].join("\n"),
      );
      write("policy-additions.yaml", "network_policies: []\n");
      write("start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
      write("host/config-adapter.cts", TEST_CONFIG_ADAPTER_SOURCE);
      write("host/messaging-adapter.cts", TEST_MESSAGING_ADAPTER_SOURCE);
      write("host/startup-adapter.cts", TEST_STARTUP_ADAPTER_SOURCE);

      let sandboxContext: string | null = null;
      let baseContext: string | null = null;
      try {
        materializeHarnessPackageArtifact(sourceRoot, artifactRoot);
        const agent = makeAgent({
          name: "context-probe",
          displayName: "Context Probe",
          packageRoot: artifactRoot,
          agentDir: artifactRoot,
          manifestPath: path.join(artifactRoot, "manifest.yaml"),
          dockerfilePath: path.join(artifactRoot, "Dockerfile"),
          dockerfileBasePath: path.join(artifactRoot, "Dockerfile.base"),
        });
        const stagedSandbox = stageAgentComposedBuildContext(
          agent,
          agent.dockerfilePath!,
          "Dockerfile",
        );
        sandboxContext = stagedSandbox.buildCtx;
        const stagedBase = stageAgentComposedBuildContext(
          agent,
          agent.dockerfileBasePath!,
          "Dockerfile.base",
        );
        baseContext = stagedBase.buildCtx;
        [stagedSandbox, stagedBase].forEach((staged) => {
          expect(missingDockerfileContextSources(staged.stagedDockerfile, staged.buildCtx)).toEqual(
            [],
          );
          expect(
            fs
              .readdirSync(path.join(staged.buildCtx, "packages"))
              .filter((entry) => entry.startsWith("nemoclaw-"))
              .sort(),
          ).toEqual(["nemoclaw-context-probe", "nemoclaw-fabric"]);
          expect(fs.existsSync(path.join(staged.buildCtx, "packages", "nemoclaw-openclaw"))).toBe(
            false,
          );
        });
      } finally {
        removeFixtureDirectories([sandboxContext, baseContext, root]);
      }
    },
    testTimeout(60_000),
  );

  it(
    "resolves every Dockerfile COPY source for each materialized harness package",
    () => {
      const root = fs.realpathSync(tmpDir());
      const stagedContexts: string[] = [];
      const packageIds = [
        "openclaw",
        "hermes",
        "langchain-deepagents-code",
        "pi",
        "haystack-agent",
        "deepseek-harness",
      ] as const;
      try {
        packageIds.forEach((packageId) => {
          const sourceRoot = path.resolve(
            import.meta.dirname,
            `../../../packages/nemoclaw-${packageId}`,
          );
          const artifactRoot = path.join(root, `artifact-${packageId}`);
          materializeHarnessPackageArtifact(sourceRoot, artifactRoot);
          const agent = makeAgent({
            name: packageId,
            displayName: packageId,
            packageRoot: artifactRoot,
            agentDir: artifactRoot,
            manifestPath: path.join(artifactRoot, "manifest.yaml"),
            dockerfilePath: path.join(artifactRoot, "Dockerfile"),
            dockerfileBasePath: path.join(artifactRoot, "Dockerfile.base"),
          });
          (["Dockerfile", "Dockerfile.base"] as const).forEach((dockerfileName) => {
            const staged = stageAgentComposedBuildContext(
              agent,
              path.join(artifactRoot, dockerfileName),
              dockerfileName,
            );
            stagedContexts.push(staged.buildCtx);
            expect(
              missingDockerfileContextSources(staged.stagedDockerfile, staged.buildCtx),
              `${packageId}/${dockerfileName}`,
            ).toEqual([]);
            const stagedHarnesses = fs
              .readdirSync(path.join(staged.buildCtx, "packages"), { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
              .map((entry) => entry.name)
              .sort();
            expect(stagedHarnesses).toEqual([`nemoclaw-${packageId}`, "nemoclaw-fabric"].sort());
          });
        });
      } finally {
        removeFixtureDirectories([...stagedContexts, root]);
      }
    },
    testTimeout(120_000),
  );

  it(
    "stages exact receipt-selected package bytes and detects later digest drift",
    () => {
      const root = fs.realpathSync(tmpDir());
      const artifactRoot = path.join(root, "artifact");
      const storeRoot = path.join(root, "store");
      fs.mkdirSync(storeRoot, { mode: 0o700 });
      let buildContext: string | null = null;
      try {
        materializeHarnessPackageArtifact(agentPackageDir("pi"), artifactRoot);
        const installed = installHarnessPackage(
          {
            packageRoot: artifactRoot,
            sourceIdentity: {
              kind: "bundled",
              nemoclawBuildIdentity: {
                nemoclawVersion: "0.0.113",
                sourceRevision: "d".repeat(40),
              },
            },
          },
          { storeRoot },
        );
        const packageDirectory = path.dirname(installed.packageManifest.manifestPath);
        expect(() =>
          stageAgentComposedBuildContext(
            makeAgent({
              name: "different-harness",
              displayName: "Different Harness",
              packageRoot: installed.packageRoot,
              agentDir: packageDirectory,
              manifestPath: installed.packageManifest.manifestPath,
              dockerfilePath: path.join(packageDirectory, "Dockerfile"),
              dockerfileBasePath: null,
            }),
            path.join(packageDirectory, "Dockerfile"),
            "Dockerfile",
            { harnessPackage: installed.identity, harnessPackageStoreRoot: storeRoot },
          ),
        ).toThrow("does not match its package receipt");
        const staged = stageAgentComposedBuildContext(
          makeAgent({
            name: "pi",
            displayName: "Pi",
            packageRoot: installed.packageRoot,
            agentDir: packageDirectory,
            manifestPath: installed.packageManifest.manifestPath,
            dockerfilePath: path.join(packageDirectory, "Dockerfile"),
            dockerfileBasePath: null,
          }),
          path.join(packageDirectory, "Dockerfile"),
          "Dockerfile",
          { harnessPackage: installed.identity, harnessPackageStoreRoot: storeRoot },
        );
        buildContext = staged.buildCtx;

        expect(staged.verifyBuildCtx()).toBe(true);
        const stagedStartScript = path.join(staged.buildCtx, "packages", "nemoclaw-pi", "start.sh");
        fs.chmodSync(stagedStartScript, 0o744);
        fs.appendFileSync(stagedStartScript, "\n# changed after staging\n");
        expect(staged.verifyBuildCtx()).toBe(false);
      } finally {
        removeFixtureDirectories([buildContext, root]);
      }
    },
    testTimeout(60_000),
  );

  it("makes private installed package bytes readable to Docker image users", () => {
    const packageRoot = fs.realpathSync(tmpDir());
    const agentDir = packageRoot;
    const scriptDir = path.join(packageRoot, "scripts", "lib");
    fs.mkdirSync(scriptDir, { recursive: true });
    const dockerfilePath = path.join(agentDir, "Dockerfile");
    const scriptPath = path.join(scriptDir, "openclaw-npm-remediation.mts");
    fs.writeFileSync(path.join(agentDir, "manifest.yaml"), "name: pi\n");
    fs.writeFileSync(
      dockerfilePath,
      "FROM scratch\nCOPY packages/nemoclaw-pi/scripts/ /scripts/\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(scriptPath, "export const packageHelper = true;\n", { mode: 0o711 });
    fs.chmodSync(path.join(packageRoot, "scripts"), 0o711);
    fs.chmodSync(scriptDir, 0o711);
    fs.chmodSync(scriptPath, 0o711);
    let buildContext: string | null = null;
    const previousUmask = process.umask(0o077);
    try {
      withMockedDocker(({ createAgentSandbox }) => {
        const result = createAgentSandbox(
          makeAgent({
            name: "pi",
            displayName: "Pi",
            packageRoot,
            agentDir,
            manifestPath: path.join(agentDir, "manifest.yaml"),
            dockerfilePath,
            dockerfileBasePath: null,
          }),
        );
        buildContext = result.buildCtx;
        expect((fs.statSync(result.buildCtx).mode & 0o777).toString(8)).toBe("700");
        const stagedPackageRoot = path.join(result.buildCtx, "packages", "nemoclaw-pi");
        expect(
          (fs.statSync(path.join(stagedPackageRoot, "scripts")).mode & 0o777).toString(8),
        ).toBe("755");
        expect(
          (fs.statSync(path.join(stagedPackageRoot, "scripts", "lib")).mode & 0o777).toString(8),
        ).toBe("755");
        expect(
          (
            fs.statSync(
              path.join(stagedPackageRoot, "scripts", "lib", "openclaw-npm-remediation.mts"),
            ).mode & 0o777
          ).toString(8),
        ).toBe("755");
        expect((fs.statSync(result.stagedDockerfile).mode & 0o777).toString(8)).toBe("644");
        expect((fs.statSync(scriptDir).mode & 0o777).toString(8)).toBe("711");
        expect((fs.statSync(scriptPath).mode & 0o777).toString(8)).toBe("711");
      });
    } finally {
      process.umask(previousUmask);
      fs.rmSync(buildContext ?? path.join(packageRoot, ".missing-build-context"), {
        recursive: true,
        force: true,
      });
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects a caller-supplied context that does not match package authority", () => {
    const otherRoot = fs.realpathSync(tmpDir());
    try {
      withMockedDocker(({ createAgentSandbox, resolveSandboxBaseImageMock, dockerBuildMock }) => {
        expect(() => createAgentSandbox(makeAgent(), { rootDir: otherRoot })).toThrow(
          "build context does not match its package root",
        );
        expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).not.toHaveBeenCalled();
      });
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("accepts a Pi base only when its immutable security inventory is current", () => {
    const pi = makeAgent({
      name: "pi",
      displayName: "Pi",
      dockerfileBasePath: path.join(agentPackageDir("pi"), "Dockerfile.base"),
    });
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(pi);
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
        validationDescription?: string;
      };

      dockerCaptureMock.mockReturnValueOnce("");
      expect(options.validateImage?.("pi-base:stale")).toBe(false);

      dockerCaptureMock.mockReturnValueOnce("nemoclaw-security-inventory-ok");
      expect(options.validateImage?.("pi-base:current")).toBe(true);
      expect(options.validationDescription).toBe("the immutable security package inventory");
      expect(dockerCaptureMock.mock.calls[1]?.[0]).toEqual(
        expect.arrayContaining([
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--read-only",
          "pi-base:current",
          expect.stringContaining("nemoclaw-security-inventory-ok"),
        ]),
      );
    });
  });

  it("runs the package-bound Hermes image probe before accepting a published base", () => {
    const imageRef = "hermes-base:current";

    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (candidate: string) => boolean;
      };

      expect(options.validateImage?.(imageRef)).toBe(true);
      expect(dockerCaptureMock.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          "--user",
          "998:999",
          "--entrypoint",
          "/usr/local/lib/nemoclaw/checks/image-probe.py",
          imageRef,
        ]),
      );
    });
  });

  it(
    "reuses a compatible resolved agent base image during normal onboarding",
    () => {
      withMockedDocker(
        ({
          ensureAgentBaseImage,
          dockerBuildMock,
          dockerImageInspectMock,
          resolveSandboxBaseImageMock,
          root,
        }) => {
          const resolutionHint = makeResolutionMetadata({ key: "cached-resolution-key" });
          const resolvedMetadata = makeResolutionMetadata({ key: "fresh-resolution-key" });
          resolveSandboxBaseImageMock.mockReturnValue({
            ref: resolvedMetadata.ref,
            digest: resolvedMetadata.digest,
            source: resolvedMetadata.source,
            glibcVersion: resolvedMetadata.glibcVersion,
            metadata: resolvedMetadata,
          });

          const result = ensureAgentBaseImage(makeAgent(), {
            resolutionHint,
            forceBaseImageRefresh: true,
          });

          expect(result).toEqual({
            imageTag: "nemoclaw-hermes-sandbox-base-local:compatible",
            built: false,
            resolutionMetadata: resolvedMetadata,
          });
          expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
            expect.objectContaining({
              imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
              dockerfilePath: path.join(agentPackageDir("hermes"), "Dockerfile.base"),
              envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
              label: "Hermes Agent sandbox base image",
              requireOpenshellSandboxAbi: process.platform === "linux",
              resolutionHint,
              forceRefresh: true,
              rootDir: root,
              validateImage: expect.any(Function),
              validationDescription:
                "the package-bound image probe and the immutable security package inventory",
            }),
          );
          expect(dockerImageInspectMock).not.toHaveBeenCalled();
          expect(dockerBuildMock).not.toHaveBeenCalled();
        },
      );
    },
    testTimeout(15_000),
  );

  it("marks only an exact warm resolution-hint reuse as handoff authority", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      const resolutionHint = makeResolutionMetadata();
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: resolutionHint.ref,
        digest: null,
        source: "local",
        glibcVersion: resolutionHint.glibcVersion,
        metadata: resolutionHint,
      });

      expect(ensureAgentBaseImage(makeAgent(), { resolutionHint })).toMatchObject({
        resolutionMetadata: resolutionHint,
        reusedResolutionHint: resolutionHint,
      });
    });
  });

  it("binds an identical local Hermes alias to its tracked pinned provenance (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd")
            ? "ldd (Debian GLIBC 2.41-12) 2.41"
            : args.includes("/usr/local/lib/nemoclaw/checks/image-probe.py")
              ? packageImageProbeMarker("hermes")
              : "nemoclaw-security-inventory-ok",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [pinnedRef],
              })
            : imageId,
        );

        vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", "");
        const canonicalMetadata = bindLocalAgentBaseImageToPinnedProvenance(agent, localRef);
        vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", localRef);
        const reboundMetadata = bindLocalAgentBaseImageToPinnedProvenance(agent, localRef);

        expect(reboundMetadata).toMatchObject({
          ref: pinnedRef,
          digest: pinnedRef.slice(pinnedRef.indexOf("@") + 1),
          source: "pinned",
          pinnedRemoteRef: pinnedRef,
          imageId,
          os: "linux",
          architecture: "amd64",
          glibcVersion: "2.41",
        });
        expect(reboundMetadata?.key).toBe(canonicalMetadata?.key);
      },
    );
  });

  it("refuses provenance when a local Hermes alias differs from the tracked image (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          makeDifferingImageInspection(format, imageRef, localRef, pinnedRef),
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("binds Docker's normalized Hermes platform digest to the tracked pin (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageName = pinnedRef.slice(0, pinnedRef.indexOf("@"));
        const platformDigest = `sha256:${"c".repeat(64)}`;
        const platformRef = `${imageName}@${platformDigest}`;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd")
            ? "ldd (Debian GLIBC 2.41-12) 2.41"
            : args.includes("/usr/local/lib/nemoclaw/checks/image-probe.py")
              ? packageImageProbeMarker("hermes")
              : "nemoclaw-security-inventory-ok",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [platformRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toMatchObject({
          ref: platformRef,
          digest: platformDigest,
          source: "pinned",
          pinnedRemoteRef: pinnedRef,
          imageId,
        });
      },
    );
  });

  it("refuses a local digest that differs from Docker's canonical pinned digest (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageName = pinnedRef.slice(0, pinnedRef.indexOf("@"));
        const firstRef = `${imageName}@sha256:${"b".repeat(64)}`;
        const secondRef = `${imageName}@sha256:${"c".repeat(64)}`;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: imageRef === localRef ? [secondRef] : [firstRef, secondRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("refuses pinned provenance when the local Hermes runtime probe fails (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd") ? "ldd (Debian GLIBC 2.41-12) 2.41" : "",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [pinnedRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("refuses provenance when a local Hermes alias lacks the tracked repository digest (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it.each([
    ["operating system", "linux", "windows", "amd64", "amd64"],
    ["architecture", "linux", "linux", "amd64", "arm64"],
  ])(
    "refuses provenance when a local Hermes alias has a different %s (#7144)",
    (_difference, localOs, pinnedOs, localArchitecture, pinnedArchitecture) => {
      withMockedDocker(
        ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
          const agent = makeAgent();
          const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
          const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
          const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
          const imageId = `sha256:${"a".repeat(64)}`;
          dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
            format === "{{json .}}"
              ? JSON.stringify({
                  Id: imageId,
                  Os: imageRef === localRef ? localOs : pinnedOs,
                  Architecture: imageRef === localRef ? localArchitecture : pinnedArchitecture,
                  RepoDigests: [pinnedRef],
                })
              : imageId,
          );

          expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
        },
      );
    },
  );

  it("configures Deep Agents Code base-image validation from the manifest (#6456)", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(
        makeAgent({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          expectedVersion: "0.1.55",
          dockerfileBasePath: path.join(
            agentPackageDir("langchain-deepagents-code"),
            "Dockerfile.base",
          ),
          dockerfilePath: path.join(agentPackageDir("langchain-deepagents-code"), "Dockerfile"),
        }),
      );
      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPaths: [
            path.join(agentPackageDir("langchain-deepagents-code"), "manifest.yaml"),
            path.join(agentPackageDir("langchain-deepagents-code"), "runtime/requirements.lock"),
            path.join(agentPackageDir("langchain-deepagents-code"), "fabric/requirements.lock"),
            path.join(agentPackageDir("langchain-deepagents-code"), "checks/image-probe.py"),
          ],
          validateImage: expect.any(Function),
          validationDescription:
            "the package-bound image probe and the immutable security package inventory",
        }),
      );
    });
  });

  it("uses a neutral base-image policy for an unknown package without a declaration", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(
        makeAgent({
          name: "future-harness",
          displayName: "Future Harness",
          managedImage: {
            repository: "registry.example/team/future-harness",
            architectures: ["linux/amd64"],
            runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
          },
        }),
      );

      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          buildArgs: undefined,
          imageName: "registry.example/team/future-harness-base",
          inputPaths: undefined,
          pinnedRemoteRef: undefined,
          requirePinnedRemoteRef: false,
        }),
      );
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: unknown;
        validationDescription?: unknown;
      };
      expect(options.validateImage).toBeUndefined();
      expect(options.validationDescription).toBeUndefined();
    });
  });

  it("runs an unknown package's conventional image probe from typed manifest data", () => {
    const packageRoot = fs.realpathSync(tmpDir());
    const checks = path.join(packageRoot, "checks");
    const manifestPath = path.join(packageRoot, "manifest.yaml");
    const dockerfileBasePath = path.join(packageRoot, "Dockerfile.base");
    const dockerfilePath = path.join(packageRoot, "Dockerfile");
    fs.mkdirSync(checks);
    fs.writeFileSync(manifestPath, "name: future-harness\n");
    fs.writeFileSync(dockerfileBasePath, "FROM scratch\n");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");
    const probePath = path.join(checks, "image-probe.py");
    fs.writeFileSync(probePath, "# future package image probe\n");
    try {
      withMockedDocker(
        ({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
          ensureAgentBaseImage(
            makeAgent({
              name: "future-harness",
              displayName: "Future Harness",
              packageRoot,
              agentDir: packageRoot,
              manifestPath,
              dockerfileBasePath,
              dockerfilePath,
              managedImage: {
                repository: "registry.example/team/future-harness",
                architectures: ["linux/amd64"],
                runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
                base_image: { package_probe: true },
              },
            }),
          );
          const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
            validateImage?: (imageRef: string) => boolean;
          };
          const digest = crypto
            .createHash("sha256")
            .update(fs.readFileSync(probePath))
            .digest("hex");
          dockerCaptureMock.mockReturnValueOnce(`nemoclaw-image-probe-ok ${digest}`);

          expect(options.validateImage?.("future-base:current")).toBe(true);
          expect(dockerCaptureMock).toHaveBeenLastCalledWith(
            expect.arrayContaining([
              "--user",
              "1234:1235",
              "--entrypoint",
              "/usr/local/lib/nemoclaw/checks/image-probe.py",
              "future-base:current",
            ]),
            { ignoreError: true, timeout: 20_000 },
          );
        },
      );
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it.each(CORPORATE_CA_BASE_IMAGE_AGENTS)(
    "passes the resolved corporate CA into local %s base image builds (#8119)",
    (agentName) => {
      const corporateCaPath = writeCa(tmpDir());
      const corporateCaContents = fs.readFileSync(corporateCaPath, "utf8");
      vi.stubEnv("NEMOCLAW_CORPORATE_CA_BUNDLE", corporateCaPath);
      withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: `nemoclaw-${agentName}-sandbox-base-local:compatible`,
          digest: null,
          source: "local",
          glibcVersion: "2.41",
        });

        ensureAgentBaseImage(
          makeAgent({
            name: agentName,
            displayName: agentName,
            expectedVersion: readManifestExpectedVersion(agentName),
            dockerfileBasePath: path.join(agentPackageDir(agentName), "Dockerfile.base"),
            dockerfilePath: path.join(agentPackageDir(agentName), "Dockerfile"),
          }),
          { forceBaseImageRebuild: true },
        );

        const options = dockerBuildMock.mock.calls[0]?.[3] as {
          buildArgs?: Record<string, string>;
        };
        const encoded = options.buildArgs?.NEMOCLAW_CORPORATE_CA_B64;
        expect(encoded).toBeTypeOf("string");
        expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toBe(corporateCaContents);
      });
    },
  );

  it("omits corporate CA build inputs from Hermes base image builds (#8119)", () => {
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_BUNDLE", writeCa(tmpDir()));
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock }) => {
      ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

      expect(dockerBuildMock.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ buildArgs: undefined }),
      );
    });
  });

  it("omits corporate CA build inputs when corporate CA import is disabled (#8119)", () => {
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_BUNDLE", writeCa(tmpDir()));
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_IMPORT", "0");
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: "nemoclaw-dcode-sandbox-base-local:compatible",
        digest: null,
        source: "local",
        glibcVersion: "2.41",
      });

      ensureAgentBaseImage(
        makeAgent({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          expectedVersion: "0.1.55",
          dockerfileBasePath: path.join(
            agentPackageDir("langchain-deepagents-code"),
            "Dockerfile.base",
          ),
          dockerfilePath: path.join(agentPackageDir("langchain-deepagents-code"), "Dockerfile"),
        }),
        { forceBaseImageRebuild: true },
      );

      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ buildArgs: undefined }),
      );
      expect(dockerBuildMock.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ buildArgs: undefined }),
      );
    });
  });

  it("leaves package version checks to the package-bound image probe", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(
        makeAgent({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          expectedVersion: null,
          dockerfileBasePath: path.join(
            agentPackageDir("langchain-deepagents-code"),
            "Dockerfile.base",
          ),
        }),
      );
      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ validateImage: expect.any(Function) }),
      );
    });
  });

  it("rebuilds an agent base image when rebuild flow forces local Dockerfile.base refresh", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectFormatMock,
        dockerImageInspectMock,
        dockerRmiMock,
        dockerTagMock,
        resolveSandboxBaseImageMock,
        root,
      }) => {
        dockerImageInspectMock.mockReturnValue({ status: 0 });
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: `sha256:${"a".repeat(64)}`,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [],
              })
            : `sha256:${"a".repeat(64)}`,
        );

        const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        const buildOptions = dockerBuildMock.mock.calls[0]?.[3] as {
          labels?: Record<string, string>;
        };
        const provenance = buildOptions.labels?.["com.nvidia.nemoclaw.base-build-provenance"];
        const expectedProvenanceKey = createSandboxBaseImageBuildProvenanceKey({
          imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
          dockerfilePath: path.join(agentPackageDir("hermes"), "Dockerfile.base"),
          inputPaths: [
            path.join(agentPackageDir("hermes"), "manifest.yaml"),
            path.join(agentPackageDir("hermes"), "runtime/requirements.lock"),
            path.join(agentPackageDir("hermes"), "fabric/requirements.lock"),
            path.join(agentPackageDir("hermes"), "checks/image-probe.py"),
          ],
          localTag: "unused-by-build-provenance",
          rootDir: root,
        });

        expect(result.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(result.built).toBe(true);
        expect(result.trustedLocalOverride).toEqual({
          ref: result.imageTag,
          provenance,
        });
        expect(result.resolutionMetadata).toEqual(
          expect.objectContaining({
            ref: result.imageTag,
            source: "local",
            imageId: `sha256:${"a".repeat(64)}`,
          }),
        );
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: result.imageTag,
            env: expect.objectContaining({
              NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: result.imageTag,
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
            validateImage: expect.any(Function),
            validationDescription:
              "the package-bound image probe and the immutable security package inventory",
            trustedLocalOverride: { ref: result.imageTag, provenance },
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).toHaveBeenCalledWith(
          expect.stringMatching(/nemoclaw-build-[^/]+\/Dockerfile\.base$/u),
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          expect.stringMatching(/nemoclaw-build-[^/]+$/u),
          {
            buildArgs: undefined,
            ignoreError: true,
            labels: {
              "com.nvidia.nemoclaw.base-build-provenance": expect.stringMatching(
                new RegExp(`^${expectedProvenanceKey}\\.[0-9a-f]{64}$`),
              ),
            },
            stdio: ["ignore", "inherit", "inherit"],
          },
        );
        expect(dockerImageInspectFormatMock).toHaveBeenCalledWith(
          "{{.Id}}",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true },
        );
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"a".repeat(64)}`, result.imageTag, {
          ignoreError: true,
        });
        expect(dockerRmiMock).toHaveBeenCalledWith(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true, suppressOutput: true },
        );
      },
    );
  });

  it.each([
    ["temporary", `rebuild-343338-${"b".repeat(16)}-image-${"a".repeat(64)}`],
    ["canonical", `image-${"a".repeat(64)}`],
  ])("does not return resolution metadata from a trusted %s rebuild lease", (_kind, tag) => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        pinTrustedAgentBaseImageOverrideForOperation,
        resolveSandboxBaseImageMock,
      }) => {
        const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
        const imageId = `sha256:${"a".repeat(64)}`;
        const imageRef = `nemoclaw-hermes-sandbox-base-local:${tag}`;
        const provenance = `${"c".repeat(64)}.${"d".repeat(64)}`;
        const leasedMetadata = makeResolutionMetadata({ ref: imageRef, imageId });
        vi.stubEnv(overrideEnvVar, imageRef);
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: imageRef,
          digest: null,
          source: "local",
          glibcVersion: leasedMetadata.glibcVersion,
          metadata: leasedMetadata,
        });
        const restore = pinTrustedAgentBaseImageOverrideForOperation(overrideEnvVar, {
          ref: imageRef,
          provenance,
        });

        try {
          expect(ensureAgentBaseImage(makeAgent())).toEqual({
            imageTag: imageRef,
            built: false,
          });
          expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
            expect.objectContaining({
              trustedLocalOverride: { ref: imageRef, provenance },
            }),
          );
        } finally {
          restore();
        }
      },
    );
  });

  it("throws when a forced agent base image rebuild fails", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
      dockerBuildMock.mockReturnValue({ status: 23 });

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "Failed to build Hermes Agent base image (exit 23)",
      );
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("attaches resolution metadata to non-Linux local build and cache fallbacks", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      withMockedDocker(
        ({
          ensureAgentBaseImage,
          dockerBuildMock,
          dockerImageInspectFormatMock,
          dockerImageInspectMock,
          resolveSandboxBaseImageMock,
        }) => {
          resolveSandboxBaseImageMock.mockReturnValue(null);
          dockerImageInspectMock.mockReturnValueOnce({ status: 1 }).mockReturnValue({ status: 0 });
          dockerImageInspectFormatMock.mockImplementation((format: string) =>
            format === "{{json .}}"
              ? JSON.stringify({
                  Id: `sha256:${"b".repeat(64)}`,
                  Os: "linux",
                  Architecture: "amd64",
                  RepoDigests: [],
                })
              : "",
          );
          const agent = makeAgent({ name: "custom", displayName: "Custom Agent" });

          expect(ensureAgentBaseImage(agent)).toEqual({
            imageTag: "ghcr.io/nvidia/nemoclaw/custom-sandbox-base:latest",
            built: true,
            resolutionMetadata: expect.objectContaining({ source: "local" }),
          });
          expect(ensureAgentBaseImage(agent)).toEqual({
            imageTag: "ghcr.io/nvidia/nemoclaw/custom-sandbox-base:latest",
            built: false,
            resolutionMetadata: expect.objectContaining({ source: "local" }),
          });
          expect(dockerBuildMock).toHaveBeenCalledOnce();
        },
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("pins different image IDs to different recreate refs at the same source revision", () => {
    withMockedDocker(
      ({ ensureAgentBaseImage, dockerImageInspectFormatMock, resolveSandboxBaseImageMock }) => {
        const inspectedIds = [
          `sha256:${"a".repeat(64)}`,
          `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
        ];
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{.Id}}" ? (inspectedIds.shift() ?? "") : "",
        );
        resolveSandboxBaseImageMock.mockImplementation((options) => ({
          ref: options.env?.[options.envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        }));

        const first = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        const second = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(first.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(second.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`);
      },
    );
  });

  it("canonicalizes a mutable local override to its full image-ID ref", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"c".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef(
          "hermes",
          "nemoclaw-hermes-sandbox-base-local:caller",
        );

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"c".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("creates a local immutable handoff for a resolved remote digest (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const remoteRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"c".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, { forceLocal: true });

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"c".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("creates a unique temporary handoff for a disposable rebuild pin (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const remoteRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
        const imageId = `sha256:${"c".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(imageId);

        const firstPinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, {
          forceLocal: true,
          temporary: true,
        });
        const secondPinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, {
          forceLocal: true,
          temporary: true,
        });

        const temporaryRefPattern = new RegExp(
          `^nemoclaw-hermes-sandbox-base-local:rebuild-[1-9][0-9]*-[0-9a-f]{16}-image-${"c".repeat(64)}$`,
        );
        expect(firstPinned).toMatch(temporaryRefPattern);
        expect(secondPinned).toMatch(temporaryRefPattern);
        expect(secondPinned).not.toBe(firstPinned);
        expect(dockerTagMock).toHaveBeenCalledWith(imageId, firstPinned, { ignoreError: true });
        expect(dockerTagMock).toHaveBeenCalledWith(imageId, secondPinned, { ignoreError: true });
      },
    );
  });

  it("does not trust a moved image-ID-shaped tag without inspecting it", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const claimed = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"d".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef("hermes", claimed);

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"d".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"d".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("fails closed when the immutable handoff does not retain the inspected image ID", () => {
    withMockedDocker(({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock }) => {
      dockerImageInspectFormatMock
        .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
        .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);

      expect(() =>
        pinAgentSandboxBaseImageRef("hermes", "nemoclaw-hermes-sandbox-base-local:caller"),
      ).toThrow("Pinned hermes base image did not retain its inspected image ID");
    });
  });

  it("removes a temporary handoff that fails image-ID verification (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerRmiMock }) => {
        dockerImageInspectFormatMock
          .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
          .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);

        expect(() =>
          pinAgentSandboxBaseImageRef("hermes", "nemoclaw-hermes-sandbox-base-local:caller", {
            temporary: true,
          }),
        ).toThrow("Pinned hermes base image did not retain its inspected image ID");
        expect(dockerRmiMock).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(
              `^nemoclaw-hermes-sandbox-base-local:rebuild-[1-9][0-9]*-[0-9a-f]{16}-image-${"a".repeat(64)}$`,
            ),
          ),
          { ignoreError: true, suppressOutput: true },
        );
      },
    );
  });
});
