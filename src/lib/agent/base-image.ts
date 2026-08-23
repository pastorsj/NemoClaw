// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dockerBuild,
  dockerCapture,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerRmi,
  dockerTag,
} from "../adapters/docker";
import { CUA_SANDBOX_IMAGE_ENV, requireCuaSandboxImageRef } from "../cua/feature";
import { harnessPackageContentDigest } from "../harness/package-registry";
import { encodeCorporateCaArg, resolveCorporateCa } from "../onboard/corporate-ca";
import { createCustomBuildContextFilter } from "../onboard/custom-build-context";
import { ROOT } from "../runner";
import { SANDBOX_BUILD_CONTEXT_PREFIX, stageAgentRuntimePackage } from "../sandbox/build-context";
import {
  buildLocalBaseTag,
  createSandboxBaseImageBuildProvenance,
  createSandboxBaseImageBuildProvenanceKey,
  createSandboxBaseImageResolutionKey,
  createSandboxBaseImageResolutionMetadata,
  getImageGlibcVersion,
  inspectLocalImageMetadata,
  OPENSHELL_SANDBOX_MIN_GLIBC,
  parseContentAddressedSandboxBaseImageId,
  parseTemporarySandboxBaseImageId,
  type ResolveBaseImageOptions,
  resolveSandboxBaseImage,
  reuseSandboxBaseImageResolutionHint,
  SANDBOX_BASE_BUILD_PROVENANCE_LABEL,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
  SANDBOX_BASE_TAG,
  type SandboxBaseImageResolution,
  SandboxBaseImageResolutionError,
  type SandboxBaseImageResolutionMetadata,
  type TrustedLocalBaseImageOverride,
  versionGte,
} from "../sandbox-base-image";
import { createDeepAgentsCodeBaseImageResolutionOptions } from "./deep-agents-code-base-image";
import type { AgentDefinition } from "./defs";

function corporateCaBuildArgs(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const corporateCa = resolveCorporateCa(env);
  return corporateCa
    ? { NEMOCLAW_CORPORATE_CA_B64: encodeCorporateCaArg(corporateCa.pem) }
    : undefined;
}

function agentBaseImageBuildArgs(agent: AgentDefinition): Record<string, string> | undefined {
  // Only these base Dockerfiles declare ARG NEMOCLAW_CORPORATE_CA_B64 and anchor
  // the decoded certificates before their HTTPS package fetches (#8119).
  return agent.name === "langchain-deepagents-code" || agent.name === "pi"
    ? corporateCaBuildArgs()
    : undefined;
}

const HERMES_MCP_RUNTIME_PROBE_OK = "nemoclaw-hermes-mcp-runtime-ok";
const HERMES_BASE_IMAGE_PROBE_GUARDS = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--user",
  "sandbox",
] as const;
// Matches the official Hermes base repository for both Dockerfile manifest-list
// pins and Docker-normalized platform manifest digests.
const HERMES_OFFICIAL_BASE_DIGEST_REF =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;

type AgentBasePackageAuthority = Readonly<{
  additionalInputFingerprint?: string;
  dockerfilePath: string;
  packageDir: string | null;
  requireLocalBuild: boolean;
}>;

type PreparedAgentBaseBuildContext = Readonly<{
  additionalInputFingerprint?: string;
  buildContextDir?: string;
  dockerfilePath: string;
}>;

export type AgentBasePackageBuildContext = Readonly<{
  additionalInputFingerprint?: string;
  buildContextDir?: string;
  dockerfilePath: string;
  requireLocalBuild: boolean;
}>;

type AgentBasePackageBuildContextOptions = Readonly<{
  packageSnapshotDir?: string;
}>;

export interface EnsureAgentBaseImageOptions {
  forceBaseImageRebuild?: boolean;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh?: boolean;
  packageSnapshotDir?: string;
}

export interface CreateAgentSandboxOptions extends EnsureAgentBaseImageOptions {
  rootDir?: string;
}

export interface EnsureAgentBaseImageResult {
  imageTag: string | null;
  built: boolean;
  resolutionMetadata?: SandboxBaseImageResolutionMetadata;
  reusedResolutionHint?: SandboxBaseImageResolutionMetadata;
  trustedLocalOverride?: TrustedLocalBaseImageOverride;
}

export type TrustedRemoteBaseImageOverride = Readonly<{
  ref: string;
  resolutionMetadata: SandboxBaseImageResolutionMetadata;
}>;

export interface CreateAgentSandboxResult {
  buildCtx: string;
  stagedDockerfile: string;
  baseImageResolutionMetadata: SandboxBaseImageResolutionMetadata | null;
}

const trustedLocalOverrideLeases = new Map<string, TrustedLocalBaseImageOverride>();
const trustedRemoteOverrideLeases = new Map<string, TrustedRemoteBaseImageOverride>();

export function pinTrustedAgentBaseImageOverrideForOperation(
  overrideEnvVar: string,
  override: TrustedLocalBaseImageOverride,
): () => void {
  const previous = trustedLocalOverrideLeases.get(overrideEnvVar);
  trustedLocalOverrideLeases.set(overrideEnvVar, override);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous) trustedLocalOverrideLeases.set(overrideEnvVar, previous);
    else trustedLocalOverrideLeases.delete(overrideEnvVar);
  };
}

export function pinTrustedAgentRemoteBaseImageOverrideForOperation(
  overrideEnvVar: string,
  override: TrustedRemoteBaseImageOverride,
): () => void {
  const previous = trustedRemoteOverrideLeases.get(overrideEnvVar);
  trustedRemoteOverrideLeases.set(overrideEnvVar, override);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous) trustedRemoteOverrideLeases.set(overrideEnvVar, previous);
    else trustedRemoteOverrideLeases.delete(overrideEnvVar);
  };
}

function reuseTrustedAgentRemoteBaseImageOverride(
  resolutionOptions: ResolveBaseImageOptions,
  overrideEnvVar: string,
  override: TrustedRemoteBaseImageOverride,
): SandboxBaseImageResolution {
  const usesExplicitOverride = override.resolutionMetadata.source === "override";
  if (usesExplicitOverride && process.env[overrideEnvVar]?.trim() !== override.ref) {
    throw new SandboxBaseImageResolutionError(
      `${resolutionOptions.label || "Sandbox base image"} trust lease no longer matches its explicit override`,
    );
  }
  const trustedEnv = {
    ...process.env,
    ...(usesExplicitOverride
      ? {
          [overrideEnvVar]: override.ref,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
        }
      : {}),
  };
  if (!usesExplicitOverride) delete trustedEnv[overrideEnvVar];
  const trustedOptions = {
    ...resolutionOptions,
    ...(usesExplicitOverride ? { localTag: override.ref } : {}),
    env: trustedEnv,
    resolutionHint: override.resolutionMetadata,
  };
  const expectedKey = createSandboxBaseImageResolutionKey(trustedOptions);
  const reused = reuseSandboxBaseImageResolutionHint(trustedOptions, expectedKey);
  if (
    !reused ||
    reused.ref !== override.resolutionMetadata.ref ||
    reused.metadata !== override.resolutionMetadata
  ) {
    throw new SandboxBaseImageResolutionError(
      `${resolutionOptions.label || "Sandbox base image"} trust lease no longer matches its resolution metadata`,
    );
  }
  return reused;
}

export function getAgentSandboxBaseImageEnvVar(agentName: string): string {
  if (agentName === "nemocua") return CUA_SANDBOX_IMAGE_ENV;
  return `NEMOCLAW_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SANDBOX_BASE_IMAGE_REF`;
}

function immutableLocalBaseImageTag(agentName: string, imageId: string, temporary = false): string {
  const match = imageId.trim().match(/^sha256:([0-9a-f]{64})$/i);
  if (!match) {
    throw new Error(`Docker returned an invalid image ID for ${agentName} base image`);
  }
  const imageIdHex = match[1].toLowerCase();
  return temporary
    ? `nemoclaw-${agentName}-sandbox-base-local:rebuild-${process.pid}-${crypto.randomBytes(8).toString("hex")}-image-${imageIdHex}`
    : `nemoclaw-${agentName}-sandbox-base-local:image-${imageIdHex}`;
}

function removeTemporaryBaseImageTag(imageRef: string): void {
  const remove = (): boolean => {
    try {
      const result = dockerRmi(imageRef, { ignoreError: true, suppressOutput: true });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  };
  if (!remove()) process.once("exit", remove);
}

export function pinAgentSandboxBaseImageRef(
  agentName: string,
  imageRef: string,
  options: { forceLocal?: boolean; temporary?: boolean } = {},
): string {
  // Rebuild forces a local image-ID alias even for a remote digest so its
  // inner-onboard handoff cannot discard the outer resolver's provenance.
  if (imageRef.includes("@sha256:") && options.forceLocal !== true) return imageRef;
  const imageId = dockerImageInspectFormat("{{.Id}}", imageRef, { ignoreError: true });
  const pinnedRef = immutableLocalBaseImageTag(agentName, imageId, options.temporary === true);
  // Tag the inspected immutable object, not the caller's potentially mutable
  // name. Otherwise the source tag could move between inspect and tag.
  const tagResult = dockerTag(imageId, pinnedRef, { ignoreError: true });
  if (tagResult.error || tagResult.status !== 0) {
    if (options.temporary === true) {
      removeTemporaryBaseImageTag(pinnedRef);
    }
    const detail = tagResult.error
      ? `: ${tagResult.error.message}`
      : ` (exit ${tagResult.status ?? "unknown"})`;
    throw new Error(`Failed to pin ${agentName} base image${detail}`);
  }
  const pinnedImageId = dockerImageInspectFormat("{{.Id}}", pinnedRef, { ignoreError: true });
  if (pinnedImageId !== imageId) {
    if (options.temporary === true) {
      removeTemporaryBaseImageTag(pinnedRef);
    }
    throw new Error(`Pinned ${agentName} base image did not retain its inspected image ID`);
  }
  return pinnedRef;
}

function getHermesPinnedRemoteBaseRef(agent: AgentDefinition): string | null {
  if (agent.name !== "hermes") return null;
  const finalDockerfile = agent.dockerfilePath;
  if (!finalDockerfile) {
    throw new Error("Hermes is missing its final sandbox Dockerfile");
  }
  let dockerfile: string;
  try {
    dockerfile = fs.readFileSync(finalDockerfile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Hermes final Dockerfile: ${finalDockerfile}`, {
      cause: error,
    });
  }
  const declarations = [...dockerfile.matchAll(/^ARG BASE_IMAGE=(\S+)$/gm)].map(
    (match) => match[1],
  );
  const pinnedRef = declarations.length === 1 ? declarations[0] : null;
  if (!pinnedRef || !HERMES_OFFICIAL_BASE_DIGEST_REF.test(pinnedRef)) {
    throw new Error(
      "Hermes final Dockerfile must declare exactly one immutable official sandbox base image",
    );
  }
  return pinnedRef;
}

/**
 * Accept only trusted resolver output here. Pinned platform digests are valid
 * only when the resolver records the current Dockerfile-pinned ref as their
 * provenance; string callers and explicit overrides stay exact-match only.
 */
function hermesFinalDockerfileAcceptsBase(
  agent: AgentDefinition,
  image: string | SandboxBaseImageResolution,
): boolean {
  if (agent.name !== "hermes") return true;
  const imageRef = typeof image === "string" ? image : image.ref;
  if (
    imageRef === "nemoclaw-hermes-base-local" ||
    /^nemoclaw-hermes-(?:root-entrypoint-base|sandbox-base-local|secret-boundary-base|stale-openclaw-dir-base|stale-openclaw-link-base):[^\s]+$/.test(
      imageRef,
    )
  ) {
    return true;
  }
  if (
    typeof image !== "string" &&
    image.source === "pinned" &&
    image.pinnedRemoteRef === getHermesPinnedRemoteBaseRef(agent) &&
    HERMES_OFFICIAL_BASE_DIGEST_REF.test(imageRef)
  ) {
    return true;
  }
  return imageRef === getHermesPinnedRemoteBaseRef(agent);
}

/**
 * Verify that a Hermes base contains the native MCP Streamable HTTP runtime,
 * the pinned ACP SDK, and Hermes' ACP adapter. Version output alone is
 * insufficient because these dependencies are installed through optional
 * upstream extras.
 */
export function hermesBaseImageSupportsMcp(imageRef: string): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      ...HERMES_BASE_IMAGE_PROBE_GUARDS,
      "--entrypoint",
      "/opt/hermes/.venv/bin/python",
      imageRef,
      "-I",
      "-c",
      `import importlib.metadata as metadata; import sys; import acp; import mcp; from acp_adapter.server import HermesACPAgent; from tools import mcp_tool; metadata.version("agent-client-protocol") == "0.9.0" or sys.exit(1); getattr(mcp_tool, "_MCP_AVAILABLE", False) or sys.exit(1); getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False) or sys.exit(1); print("${HERMES_MCP_RUNTIME_PROBE_OK}")`,
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === HERMES_MCP_RUNTIME_PROBE_OK;
}

function createAgentBaseImageResolutionOptions(
  agent: AgentDefinition,
  dockerfilePath: string,
  options: EnsureAgentBaseImageOptions,
  authority: AgentBasePackageAuthority,
  buildContextDir?: string,
): ResolveBaseImageOptions {
  const imageName = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base`;
  const validationOptions =
    agent.name === "hermes"
      ? {
          validateImage: hermesBaseImageSupportsMcp,
          validationDescription: "the required MCP Streamable HTTP and ACP runtimes",
        }
      : createDeepAgentsCodeBaseImageResolutionOptions(agent, dockerfilePath);
  const pinnedRemoteRef = getHermesPinnedRemoteBaseRef(agent) ?? undefined;
  return {
    imageName,
    dockerfilePath,
    buildArgs: agentBaseImageBuildArgs(agent),
    localTag: buildLocalBaseTag(`nemoclaw-${agent.name}-sandbox-base-local`, ROOT),
    envVar: getAgentSandboxBaseImageEnvVar(agent.name),
    label: `${agent.displayName} sandbox base image`,
    requireOpenshellSandboxAbi: process.platform === "linux",
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceBaseImageRefresh,
    rootDir: ROOT,
    ...(buildContextDir ? { buildContextDir } : {}),
    ...(authority.additionalInputFingerprint
      ? { additionalInputFingerprint: authority.additionalInputFingerprint }
      : {}),
    ...(authority.requireLocalBuild ? { requireLocalBuild: true } : {}),
    pinnedRemoteRef,
    preferPinnedRemoteRef: agent.name === "hermes" && pinnedRemoteRef !== undefined,
    ...validationOptions,
  };
}

/**
 * Bind a local Hermes alias to the tracked official base only when Docker
 * proves both refs name the same immutable image. This narrow rebuild helper
 * does not change the resolver's rule that arbitrary local overrides have no
 * inherited remote provenance.
 */
export function bindLocalAgentBaseImageToPinnedProvenance(
  agent: AgentDefinition,
  imageRef: string,
): SandboxBaseImageResolutionMetadata | null {
  const dockerfilePath = agent.dockerfileBasePath;
  const pinnedRemoteRef = getHermesPinnedRemoteBaseRef(agent);
  if (!dockerfilePath || !pinnedRemoteRef) return null;
  const authority = resolveAgentBasePackageAuthority(agent, dockerfilePath);
  if (authority.requireLocalBuild) return null;

  const local = inspectLocalImageMetadata(imageRef);
  const pinned = inspectLocalImageMetadata(pinnedRemoteRef);
  const localId = typeof local?.Id === "string" ? local.Id : "";
  const pinnedId = typeof pinned?.Id === "string" ? pinned.Id : "";
  const localOs = typeof local?.Os === "string" ? local.Os : "";
  const pinnedOs = typeof pinned?.Os === "string" ? pinned.Os : "";
  const localArchitecture = typeof local?.Architecture === "string" ? local.Architecture : "";
  const pinnedArchitecture = typeof pinned?.Architecture === "string" ? pinned.Architecture : "";
  const localRepoDigests = Array.isArray(local?.RepoDigests) ? local.RepoDigests.map(String) : [];
  const pinnedRepoDigests = Array.isArray(pinned?.RepoDigests)
    ? pinned.RepoDigests.map(String)
    : [];
  const resolvedRemoteRef = pinnedRepoDigests.find((ref) =>
    HERMES_OFFICIAL_BASE_DIGEST_REF.test(ref),
  );
  if (
    !localId ||
    localId !== pinnedId ||
    !localOs ||
    localOs !== pinnedOs ||
    !localArchitecture ||
    localArchitecture !== pinnedArchitecture ||
    !resolvedRemoteRef ||
    !localRepoDigests.includes(resolvedRemoteRef)
  ) {
    return null;
  }

  const canonicalEnv = { ...process.env };
  delete canonicalEnv[getAgentSandboxBaseImageEnvVar(agent.name)];
  const resolutionOptions = {
    ...createAgentBaseImageResolutionOptions(agent, authority.dockerfilePath, {}, authority),
    env: canonicalEnv,
  };
  const glibcVersion = getImageGlibcVersion(imageRef);
  const minGlibcVersion = resolutionOptions.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC;
  if (
    resolutionOptions.requireOpenshellSandboxAbi === true &&
    (!glibcVersion || !versionGte(glibcVersion, minGlibcVersion))
  ) {
    return null;
  }
  if (resolutionOptions.validateImage && !resolutionOptions.validateImage(imageRef)) return null;
  const digest = resolvedRemoteRef.slice(resolvedRemoteRef.indexOf("@") + 1);
  const metadata = createSandboxBaseImageResolutionMetadata(
    resolutionOptions,
    createSandboxBaseImageResolutionKey(resolutionOptions),
    {
      ref: resolvedRemoteRef,
      digest,
      source: "pinned",
      pinnedRemoteRef,
      glibcVersion,
    },
  );
  return metadata?.imageId === localId &&
    metadata.os === localOs &&
    metadata.architecture === localArchitecture
    ? metadata
    : null;
}

/**
 * Mint a one-operation trust lease for an exact rebuild handoff only from the
 * outer resolver's already-validated local metadata. The public build label is
 * supporting evidence, never authority by itself.
 */
export function bindLocalAgentBaseImageHandoffToResolution(
  agent: AgentDefinition,
  sourceRef: string,
  handoffRef: string,
  metadata: SandboxBaseImageResolutionMetadata,
  reusedResolutionHint: SandboxBaseImageResolutionMetadata,
): TrustedLocalBaseImageOverride | null {
  const baseDockerfile = agent.dockerfileBasePath;
  const localImageName = `nemoclaw-${agent.name}-sandbox-base-local`;
  const expectedImageId = parseContentAddressedSandboxBaseImageId(localImageName, handoffRef);
  const temporaryHandoffImageId = parseTemporarySandboxBaseImageId(localImageName, handoffRef);
  const normalizedMetadataImageId = metadata.imageId.trim().toLowerCase();
  if (!baseDockerfile || metadata !== reusedResolutionHint) return null;
  const authority = resolveAgentBasePackageAuthority(agent, baseDockerfile);
  const resolutionOptions = createAgentBaseImageResolutionOptions(
    agent,
    authority.dockerfilePath,
    {},
    authority,
  );
  const canonicalSourceImageId =
    parseTemporarySandboxBaseImageId(localImageName, sourceRef) === null
      ? parseContentAddressedSandboxBaseImageId(localImageName, sourceRef)
      : null;
  const stableSourceHandoff =
    sourceRef === resolutionOptions.localTag &&
    temporaryHandoffImageId === normalizedMetadataImageId;
  const canonicalSourceHandoff =
    canonicalSourceImageId === normalizedMetadataImageId && handoffRef === sourceRef;
  if (
    metadata.schema !== SANDBOX_BASE_RESOLUTION_SCHEMA ||
    metadata.key !== createSandboxBaseImageResolutionKey(resolutionOptions) ||
    metadata.imageName !== resolutionOptions.imageName ||
    metadata.source !== "local" ||
    metadata.digest !== null ||
    metadata.ref !== sourceRef ||
    (!stableSourceHandoff && !canonicalSourceHandoff) ||
    !expectedImageId ||
    normalizedMetadataImageId !== expectedImageId
  ) {
    return null;
  }

  const source = inspectLocalImageMetadata(sourceRef);
  const handoff = handoffRef === sourceRef ? source : inspectLocalImageMetadata(handoffRef);
  const sourceImageId = typeof source?.Id === "string" ? source.Id.trim().toLowerCase() : "";
  const handoffImageId = typeof handoff?.Id === "string" ? handoff.Id.trim().toLowerCase() : "";
  if (
    sourceImageId !== normalizedMetadataImageId ||
    source?.Os !== metadata.os ||
    source?.Architecture !== metadata.architecture ||
    handoffImageId !== normalizedMetadataImageId ||
    handoff?.Os !== metadata.os ||
    handoff?.Architecture !== metadata.architecture
  ) {
    return null;
  }

  const expectedProvenanceKey = createSandboxBaseImageBuildProvenanceKey(resolutionOptions);
  const sourceLabels =
    source.Config?.Labels && typeof source.Config.Labels === "object"
      ? (source.Config.Labels as Record<string, unknown>)
      : {};
  const handoffLabels =
    handoff.Config?.Labels && typeof handoff.Config.Labels === "object"
      ? (handoff.Config.Labels as Record<string, unknown>)
      : {};
  const provenance = sourceLabels[SANDBOX_BASE_BUILD_PROVENANCE_LABEL];
  if (
    typeof provenance !== "string" ||
    !new RegExp(`^${expectedProvenanceKey}\\.[0-9a-f]{64}$`).test(provenance) ||
    handoffLabels[SANDBOX_BASE_BUILD_PROVENANCE_LABEL] !== provenance
  ) {
    return null;
  }

  return { ref: handoffRef, provenance };
}

function createLocalResolutionMetadata(
  options: ResolveBaseImageOptions,
  imageTag: string,
  glibcVersion?: string | null,
): SandboxBaseImageResolutionMetadata | null {
  return createSandboxBaseImageResolutionMetadata(
    options,
    createSandboxBaseImageResolutionKey(options),
    {
      ref: imageTag,
      digest: null,
      source: "local",
      glibcVersion:
        glibcVersion === undefined
          ? process.platform === "linux"
            ? getImageGlibcVersion(imageTag)
            : null
          : glibcVersion,
    },
  );
}

function localBaseImageBuildProvenance(options: ResolveBaseImageOptions): {
  labels: Record<string, string>;
  provenance: string;
} {
  const provenance = createSandboxBaseImageBuildProvenance(options);
  return {
    labels: { [SANDBOX_BASE_BUILD_PROVENANCE_LABEL]: provenance },
    provenance,
  };
}

function selectedAgentRuntimePackageDir(agent: AgentDefinition): string | null {
  const agentDir = typeof agent.agentDir === "string" ? path.resolve(agent.agentDir) : null;
  const dockerfilePath = agent.dockerfilePath ? path.resolve(agent.dockerfilePath) : null;
  const manifestPath =
    typeof agent.manifestPath === "string" ? path.resolve(agent.manifestPath) : null;
  const packageDirectoryName = `nemoclaw-${agent.name}`;
  if (
    !agentDir ||
    path.basename(agentDir) !== packageDirectoryName ||
    dockerfilePath !== path.join(agentDir, "Dockerfile") ||
    manifestPath !== path.join(agentDir, "manifest.yaml")
  ) {
    return null;
  }
  return agentDir;
}

function resolveAgentBasePackageAuthority(
  agent: AgentDefinition,
  dockerfilePath: string,
  packageSnapshotDir?: string,
): AgentBasePackageAuthority {
  const selectedPackageDir = selectedAgentRuntimePackageDir(agent);
  const packageDir = packageSnapshotDir ? path.resolve(packageSnapshotDir) : selectedPackageDir;
  const resolvedDockerfilePath = packageSnapshotDir
    ? path.join(path.resolve(packageSnapshotDir), "Dockerfile.base")
    : path.resolve(dockerfilePath);
  if (packageSnapshotDir && packageDir) {
    const snapshot = fs.lstatSync(packageDir);
    if (
      !selectedPackageDir ||
      path.basename(packageDir) !== `nemoclaw-${agent.name}` ||
      snapshot.isSymbolicLink() ||
      !snapshot.isDirectory()
    ) {
      throw new Error("Selected harness package snapshot is invalid");
    }
  }
  const expectedPackageDigest = selectedPackageDir ? agent.packageContentDigest : null;
  if (selectedPackageDir && !expectedPackageDigest) {
    throw new Error(`Selected harness package '${agent.name}' has no loaded content digest`);
  }
  if (!packageDir || resolvedDockerfilePath !== path.join(packageDir, "Dockerfile.base")) {
    return {
      dockerfilePath: resolvedDockerfilePath,
      packageDir: null,
      requireLocalBuild: false,
    };
  }

  const selectedDigest = harnessPackageContentDigest(packageDir);
  if (selectedDigest !== expectedPackageDigest) {
    throw new Error(`Selected harness package '${agent.name}' no longer matches its manifest`);
  }
  const bundledPackageDir = path.join(ROOT, "packages", path.basename(packageDir));
  if (packageDir === bundledPackageDir) {
    return {
      dockerfilePath: resolvedDockerfilePath,
      packageDir,
      requireLocalBuild: false,
    };
  }
  if (
    fs.existsSync(bundledPackageDir) &&
    selectedDigest === harnessPackageContentDigest(bundledPackageDir)
  ) {
    return {
      dockerfilePath: path.join(bundledPackageDir, "Dockerfile.base"),
      packageDir,
      requireLocalBuild: false,
    };
  }

  return {
    additionalInputFingerprint: selectedDigest,
    dockerfilePath: resolvedDockerfilePath,
    packageDir,
    requireLocalBuild: true,
  };
}

function prepareAgentBaseBuildContext(
  authority: AgentBasePackageAuthority,
): PreparedAgentBaseBuildContext {
  if (!authority.requireLocalBuild || !authority.packageDir) {
    return { dockerfilePath: authority.dockerfilePath };
  }

  const buildContextDir = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  try {
    const includeBuildContextPath = createCustomBuildContextFilter(ROOT);
    fs.cpSync(ROOT, buildContextDir, {
      mode: fs.constants.COPYFILE_FICLONE,
      recursive: true,
      filter: (sourcePath) =>
        path.basename(sourcePath) !== ".claude" && includeBuildContextPath(sourcePath),
    });
    const stagedPackageDir = stageAgentRuntimePackage(
      authority.packageDir,
      buildContextDir,
      authority.additionalInputFingerprint,
    );
    const stagedDigest = harnessPackageContentDigest(stagedPackageDir);
    if (stagedDigest !== authority.additionalInputFingerprint) {
      throw new Error("Selected harness package changed while it was being staged");
    }
    return {
      additionalInputFingerprint: stagedDigest,
      buildContextDir,
      dockerfilePath: path.join(stagedPackageDir, "Dockerfile.base"),
    };
  } catch (error) {
    fs.rmSync(buildContextDir, { recursive: true, force: true });
    throw error;
  }
}

/** Run with the base Dockerfile and package bytes selected for this agent. */
export function withAgentBasePackageBuildContext<T>(
  agent: AgentDefinition,
  runWithContext: (context: AgentBasePackageBuildContext) => T,
  options: AgentBasePackageBuildContextOptions = {},
): T {
  const baseDockerfile = agent.dockerfileBasePath;
  if (!baseDockerfile) {
    throw new Error(`${agent.displayName} is missing a sandbox base Dockerfile`);
  }

  const authority = resolveAgentBasePackageAuthority(
    agent,
    baseDockerfile,
    options.packageSnapshotDir,
  );
  const prepared = prepareAgentBaseBuildContext(authority);
  try {
    return runWithContext({
      dockerfilePath: prepared.dockerfilePath,
      requireLocalBuild: authority.requireLocalBuild,
      ...(prepared.buildContextDir ? { buildContextDir: prepared.buildContextDir } : {}),
      ...(prepared.additionalInputFingerprint
        ? { additionalInputFingerprint: prepared.additionalInputFingerprint }
        : {}),
    });
  } finally {
    if (prepared.buildContextDir) {
      fs.rmSync(prepared.buildContextDir, { recursive: true, force: true });
    }
  }
}

/** Replace the bundled build-context copy with the package selected by loadAgent(). */
function stageSelectedHarnessPackage(agent: AgentDefinition, buildCtx: string): string | null {
  const agentDir = selectedAgentRuntimePackageDir(agent);
  if (!agentDir) return null;
  if (!agent.packageContentDigest) {
    throw new Error(`Selected harness package '${agent.name}' has no loaded content digest`);
  }
  return stageAgentRuntimePackage(agentDir, buildCtx, agent.packageContentDigest);
}

/**
 * Ensure the agent-specific sandbox base image exists locally.
 * Rebuild callers can force this so local Dockerfile.base edits are applied.
 */
export function ensureAgentBaseImage(
  agent: AgentDefinition,
  options: EnsureAgentBaseImageOptions = {},
): EnsureAgentBaseImageResult {
  if (agent.name === "nemocua") {
    return { imageTag: requireCuaSandboxImageRef(), built: false };
  }
  const manifestBaseDockerfile = agent.dockerfileBasePath;

  if (!manifestBaseDockerfile) {
    return { imageTag: null, built: false };
  }

  const authority = resolveAgentBasePackageAuthority(
    agent,
    manifestBaseDockerfile,
    options.packageSnapshotDir,
  );
  const prepared = prepareAgentBaseBuildContext(authority);
  try {
    return ensureAgentBaseImageWithContext(agent, options, authority, prepared);
  } finally {
    if (prepared.buildContextDir) {
      fs.rmSync(prepared.buildContextDir, { recursive: true, force: true });
    }
  }
}

function ensureAgentBaseImageWithContext(
  agent: AgentDefinition,
  options: EnsureAgentBaseImageOptions,
  authority: AgentBasePackageAuthority,
  prepared: PreparedAgentBaseBuildContext,
): EnsureAgentBaseImageResult {
  const baseDockerfile = prepared.dockerfilePath;
  const preparedAuthority = prepared.additionalInputFingerprint
    ? { ...authority, additionalInputFingerprint: prepared.additionalInputFingerprint }
    : authority;
  const resolutionOptions = createAgentBaseImageResolutionOptions(
    agent,
    baseDockerfile,
    options,
    preparedAuthority,
    prepared.buildContextDir,
  );
  const baseImageName = resolutionOptions.imageName;
  const baseImageTag = `${baseImageName}:${SANDBOX_BASE_TAG}`;
  const overrideEnvVar = getAgentSandboxBaseImageEnvVar(agent.name);
  const resolveExactImage = (
    imageRef: string,
    trustedLocalOverride?: TrustedLocalBaseImageOverride,
  ) =>
    resolveSandboxBaseImage({
      ...resolutionOptions,
      localTag: imageRef,
      env: {
        ...process.env,
        [overrideEnvVar]: imageRef,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
      trustedLocalOverride,
    });

  if (options.forceBaseImageRebuild === true) {
    const forceBuildTag = `nemoclaw-${agent.name}-sandbox-base-local:build-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const buildProvenance = localBaseImageBuildProvenance(resolutionOptions);
    console.log(`  Rebuilding ${agent.displayName} base image...`);
    const buildResult = dockerBuild(
      baseDockerfile,
      forceBuildTag,
      resolutionOptions.buildContextDir || ROOT,
      {
        buildArgs: resolutionOptions.buildArgs,

        ignoreError: true,
        labels: buildProvenance.labels,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    if (buildResult.error || buildResult.status !== 0) {
      dockerRmi(forceBuildTag, { ignoreError: true, suppressOutput: true });
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    try {
      const pinnedBaseImageTag = pinAgentSandboxBaseImageRef(agent.name, forceBuildTag);
      let resolved: SandboxBaseImageResolution | null = null;
      try {
        resolved = resolveExactImage(pinnedBaseImageTag, {
          ref: pinnedBaseImageTag,
          provenance: buildProvenance.provenance,
        });
      } catch (error) {
        if (!(error instanceof SandboxBaseImageResolutionError)) throw error;
      }
      if (!resolved) {
        throw new Error(
          `Built ${agent.displayName} base image failed the required runtime compatibility checks`,
        );
      }
      if (!hermesFinalDockerfileAcceptsBase(agent, pinnedBaseImageTag)) {
        throw new Error(
          `Hermes final image does not accept base image ref '${pinnedBaseImageTag}'; use the tracked official digest or a repository-built local base`,
        );
      }
      console.log(`  \u2713 Base image built: ${pinnedBaseImageTag}`);
      const resolutionMetadata = createLocalResolutionMetadata(
        resolutionOptions,
        pinnedBaseImageTag,
        resolved.glibcVersion,
      );
      return {
        imageTag: pinnedBaseImageTag,
        built: true,
        trustedLocalOverride: {
          ref: pinnedBaseImageTag,
          provenance: buildProvenance.provenance,
        },
        ...(resolutionMetadata ? { resolutionMetadata } : {}),
      };
    } finally {
      dockerRmi(forceBuildTag, { ignoreError: true, suppressOutput: true });
    }
  }

  const explicitOverride = process.env[overrideEnvVar]?.trim();
  const trustedLocalOverride = explicitOverride
    ? trustedLocalOverrideLeases.get(overrideEnvVar)
    : undefined;
  const trustedRemoteOverride = trustedRemoteOverrideLeases.get(overrideEnvVar);
  const resolved = explicitOverride
    ? trustedRemoteOverride?.ref === explicitOverride
      ? reuseTrustedAgentRemoteBaseImageOverride(
          resolutionOptions,
          overrideEnvVar,
          trustedRemoteOverride,
        )
      : resolveExactImage(explicitOverride, trustedLocalOverride)
    : resolveSandboxBaseImage(resolutionOptions);
  if (resolved) {
    if (!hermesFinalDockerfileAcceptsBase(agent, resolved)) {
      throw new Error(
        `Hermes final image does not accept base image ref '${resolved.ref}'; use the tracked official digest or a repository-built local base`,
      );
    }
    console.log(`  Using ${agent.displayName} base image: ${resolved.ref}`);
    const operationScopedLocalLease =
      explicitOverride &&
      trustedLocalOverride?.ref === explicitOverride &&
      resolved.ref === explicitOverride &&
      resolved.source === "local";
    const reusedResolutionHint =
      options.forceBaseImageRefresh !== true &&
      options.resolutionHint &&
      resolved.metadata === options.resolutionHint
        ? options.resolutionHint
        : null;
    return {
      imageTag: resolved.ref,
      built: false,
      ...(!operationScopedLocalLease && resolved.metadata
        ? { resolutionMetadata: resolved.metadata }
        : {}),
      ...(reusedResolutionHint ? { reusedResolutionHint } : {}),
    };
  }
  if (process.platform === "linux" || resolutionOptions.validateImage) {
    throw new Error(
      `No compatible ${agent.displayName} sandbox base image found for ${baseImageName}`,
    );
  }

  const inspectResult = dockerImageInspect(baseImageTag, {
    ignoreError: true,
    suppressOutput: true,
  });
  if (inspectResult?.status !== 0) {
    console.log(`  Building ${agent.displayName} base image (first time only)...`);
    const buildProvenance = localBaseImageBuildProvenance(resolutionOptions);
    const buildResult = dockerBuild(
      baseDockerfile,
      baseImageTag,
      resolutionOptions.buildContextDir || ROOT,
      {
        buildArgs: resolutionOptions.buildArgs,

        ignoreError: true,
        labels: buildProvenance.labels,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    if (buildResult.error || buildResult.status !== 0) {
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    console.log(`  \u2713 Base image built: ${baseImageTag}`);
    const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
    return {
      imageTag: baseImageTag,
      built: true,
      ...(resolutionMetadata ? { resolutionMetadata } : {}),
    };
  }

  console.log(`  Base image exists: ${baseImageTag}`);
  const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
  return {
    imageTag: baseImageTag,
    built: false,
    ...(resolutionMetadata ? { resolutionMetadata } : {}),
  };
}

/** Stage build context for an agent-specific sandbox image. */
export function createAgentSandbox(
  agent: AgentDefinition,
  options: CreateAgentSandboxOptions = {},
): CreateAgentSandboxResult {
  const agentDockerfile = agent.dockerfilePath;

  if (!agentDockerfile) {
    throw new Error(`${agent.displayName} is missing a sandbox Dockerfile`);
  }

  const { rootDir = ROOT, ...baseImageOptions } = options;
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  let resolutionMetadata: SandboxBaseImageResolutionMetadata | undefined;
  try {
    let stagedAgentDir: string | null = null;
    if (agent.name !== "nemocua") {
      const shouldIncludeBuildContextPath = createCustomBuildContextFilter(rootDir);
      fs.cpSync(rootDir, buildCtx, {
        mode: fs.constants.COPYFILE_FICLONE,
        recursive: true,
        filter: (src) => path.basename(src) !== ".claude" && shouldIncludeBuildContextPath(src),
      });
      stagedAgentDir = stageSelectedHarnessPackage(agent, buildCtx);
    }
    const stagedPackageDigest = stagedAgentDir ? harnessPackageContentDigest(stagedAgentDir) : null;
    const baseImage = ensureAgentBaseImage(agent, {
      ...baseImageOptions,
      ...(stagedAgentDir ? { packageSnapshotDir: stagedAgentDir } : {}),
    });
    const baseImageRef = baseImage.imageTag;
    resolutionMetadata = baseImage.resolutionMetadata;
    if (stagedAgentDir && harnessPackageContentDigest(stagedAgentDir) !== stagedPackageDigest) {
      throw new Error("Selected harness package snapshot changed during base image resolution");
    }
    fs.copyFileSync(
      stagedAgentDir ? path.join(stagedAgentDir, "Dockerfile") : agentDockerfile,
      stagedDockerfile,
    );
    if (baseImageRef) {
      const dockerfile = fs.readFileSync(stagedDockerfile, "utf8");
      fs.writeFileSync(
        stagedDockerfile,
        dockerfile.replace(/^ARG BASE_IMAGE(?:=.*)?$/m, `ARG BASE_IMAGE=${baseImageRef}`),
      );
    }
  } catch (error) {
    try {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    } catch {
      // Preserve the manifest or staging authority failure.
    }
    throw error;
  }
  console.log(`  Using ${agent.displayName} Dockerfile: ${agentDockerfile}`);

  return {
    buildCtx,
    stagedDockerfile,
    baseImageResolutionMetadata: resolutionMetadata ?? null,
  };
}
