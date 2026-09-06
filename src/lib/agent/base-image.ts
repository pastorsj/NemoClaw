// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { fingerprintBuildContext } from "../adapters/fs/build-context-fingerprint";
import { copyVerifiedPackageTree } from "../agent-runtime/package/copy";
import { resolvePinnedHarnessPackage } from "../agent-runtime/package/store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
  type ValidatedHarnessPackageTree,
} from "../agent-runtime/package/tree";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import { CUA_SANDBOX_IMAGE_ENV, requireCuaSandboxImageRef } from "../cua/feature";
import { REPOSITORY_ROOT } from "../core/repository-root";
import { encodeCorporateCaArg, resolveCorporateCa } from "../onboard/corporate-ca";
import { createCustomBuildContextFilter } from "../onboard/custom-build-context";
import {
  normalizeReadModesForDockerCopy,
  SANDBOX_BUILD_CONTEXT_PREFIX,
} from "../sandbox/build-context";
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
import { sandboxBaseImageHasSecurityInventory } from "../sandbox-base-image/security-inventory";
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
  return agent.managedImage?.base_image?.corporate_ca === true ? corporateCaBuildArgs() : undefined;
}

const BASE_IMAGE_PROBE_GUARDS = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
] as const;
const PACKAGE_IMAGE_PROBE_SOURCE = "checks/image-probe.py";
const PACKAGE_IMAGE_PROBE_ENTRYPOINT = "/usr/local/lib/nemoclaw/checks/image-probe.py";
const PACKAGE_IMAGE_PROBE_OK = "nemoclaw-image-probe-ok";
const OCI_DIGEST_REF_PATTERN =
  /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@sha256:[0-9a-f]{64}$/u;

export interface EnsureAgentBaseImageOptions {
  forceBaseImageRebuild?: boolean;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh?: boolean;
  allowLocalFallback?: boolean;
  /** Exact receipt that owns package bytes used for a managed local build. */
  harnessPackage?: HarnessPackageIdentity | null;
  /** Test and isolated-runtime override for the receipt store. */
  harnessPackageStoreRoot?: string;
}

export interface CreateAgentSandboxOptions extends EnsureAgentBaseImageOptions {
  /** @deprecated The selected definition owns its build-context root. */
  rootDir?: string;
}

function requirePackageIntegrationRoot(agent: AgentDefinition, packageRoot: string): string {
  const integrationRoot = path.dirname(agent.manifestPath);
  requireAgentPackageAsset(agent, packageRoot, agent.manifestPath, "manifest");
  const relative = path.relative(packageRoot, integrationRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${agent.displayName} integration root escapes its package root`);
  }
  return integrationRoot;
}

function runBuildContextArchiveCommand(
  executable: string,
  args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
  label: string,
): void {
  const result = spawnSync(executable, args, options);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? String(result.stderr ?? "").trim();
    throw new Error(`Failed to ${label}${detail ? `: ${detail}` : ""}`);
  }
}

let trackedCoreTemplate: string | null = null;

function requireTrackedCoreTemplate(): string {
  if (trackedCoreTemplate && fs.existsSync(trackedCoreTemplate)) return trackedCoreTemplate;
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-template-"));
  const archivePath = path.join(cacheRoot, "repository.tar");
  const templateRoot = path.join(cacheRoot, "repository");
  fs.mkdirSync(templateRoot);
  try {
    runBuildContextArchiveCommand(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"],
      { cwd: REPOSITORY_ROOT, stdio: ["ignore", "ignore", "pipe"] },
      "archive the tracked NemoClaw revision",
    );
    runBuildContextArchiveCommand(
      "tar",
      ["-xf", archivePath, "-C", templateRoot],
      { stdio: ["ignore", "ignore", "pipe"] },
      "extract the tracked NemoClaw revision",
    );
    fs.rmSync(archivePath, { force: true });
    removeTrackedDeveloperSymlinks(templateRoot);
    removeSiblingHarnessPackages(templateRoot, "");
    assertBuildContextHasNoSymlinks(templateRoot);
  } catch (error) {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    throw error;
  }
  trackedCoreTemplate = templateRoot;
  process.once("exit", () => {
    try {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    } catch {
      // Process-exit cleanup is best effort.
    }
  });
  return templateRoot;
}

function stageTrackedCoreBuildInput(buildCtx: string): void {
  const templateRoot = requireTrackedCoreTemplate();
  for (const entry of fs.readdirSync(templateRoot)) {
    fs.cpSync(path.join(templateRoot, entry), path.join(buildCtx, entry), { recursive: true });
  }
}

function removeSiblingHarnessPackages(buildCtx: string, selectedDirectoryName: string): void {
  const packagesRoot = path.join(buildCtx, "packages");
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (
      !entry.name.startsWith("nemoclaw-") ||
      entry.name === "nemoclaw-fabric" ||
      entry.name === selectedDirectoryName
    ) {
      continue;
    }
    fs.rmSync(path.join(packagesRoot, entry.name), { recursive: true, force: true });
  }
}

function removeTrackedDeveloperSymlinks(buildCtx: string): void {
  for (const relativePath of [".claude", "CLAUDE.md"]) {
    fs.rmSync(path.join(buildCtx, relativePath), { recursive: true, force: true });
  }
}

function assertBuildContextHasNoSymlinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Tracked core build input contains a symbolic link: ${target}`);
    }
    if (entry.isDirectory()) assertBuildContextHasNoSymlinks(target);
  }
}

function copyComposedBuildContextTree(
  sourceRoot: string,
  destinationRoot: string,
  label: string,
): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(sourceRoot);
  } catch {
    throw new Error(`${label} is unavailable: ${sourceRoot}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory: ${sourceRoot}`);
  }
  const shouldInclude = createCustomBuildContextFilter(sourceRoot);
  fs.cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".claude" && shouldInclude(source),
  });
}

function packageIdentitiesMatch(
  left: HarnessPackageIdentity,
  right: HarnessPackageIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contentDigest === right.contentDigest
  );
}

function resolveReceiptBoundPackageTree(
  agent: AgentDefinition,
  packageRoot: string,
  options: Pick<EnsureAgentBaseImageOptions, "harnessPackage" | "harnessPackageStoreRoot">,
): ValidatedHarnessPackageTree | null {
  const identity = options.harnessPackage;
  if (!identity) return null;

  const installed = resolvePinnedHarnessPackage(
    identity,
    options.harnessPackageStoreRoot === undefined
      ? {}
      : { storeRoot: options.harnessPackageStoreRoot },
  );
  if (
    identity.id !== agent.name ||
    !packageIdentitiesMatch(installed.identity, identity) ||
    installed.packageRoot !== packageRoot ||
    installed.packageManifest.manifestPath !== agent.manifestPath
  ) {
    throw new Error("Selected harness definition does not match its package receipt");
  }

  const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
  if (tree.contentDigest !== identity.contentDigest) {
    throw new Error("Selected harness package tree does not match its package receipt");
  }
  assertTreeAuthority(getPackageTreeAuthority(tree));
  return tree;
}

export interface StagedAgentComposedBuildContext {
  readonly buildCtx: string;
  readonly stagedDockerfile: string;
  /** Re-hash the exact package subtree immediately before external consumption. */
  verifyBuildCtx(): boolean;
}

/** Stage one receipt-selected package over an exact tracked core build input. */
export function stageAgentComposedBuildContext(
  agent: AgentDefinition,
  dockerfilePath: string,
  stagedDockerfileName: "Dockerfile" | "Dockerfile.base",
  options: Pick<EnsureAgentBaseImageOptions, "harnessPackage" | "harnessPackageStoreRoot"> = {},
): StagedAgentComposedBuildContext {
  const packageRoot = requireAgentPackageRoot(agent);
  requireAgentPackageAsset(agent, packageRoot, dockerfilePath, "Dockerfile");
  const integrationRoot = requirePackageIntegrationRoot(agent, packageRoot);
  const receiptBoundTree = resolveReceiptBoundPackageTree(agent, packageRoot, options);
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const stagedDockerfile = path.join(buildCtx, stagedDockerfileName);
  const packageDirectoryName = `nemoclaw-${agent.name}`;
  const stagedPackageRoot = path.join(buildCtx, "packages", packageDirectoryName);
  let verifiedPackageCopy: ReturnType<typeof copyVerifiedPackageTree> | null = null;
  let verifiedPackageParent: string | null = null;
  try {
    try {
      let copyIntegrationRoot = integrationRoot;
      let copyDockerfilePath = dockerfilePath;
      if (receiptBoundTree) {
        verifiedPackageParent = fs.mkdtempSync(
          path.join(fs.realpathSync(os.tmpdir()), ".nemoclaw-package-build-"),
        );
        fs.chmodSync(verifiedPackageParent, 0o700);
        verifiedPackageCopy = copyVerifiedPackageTree(receiptBoundTree, {
          stagingParent: verifiedPackageParent,
        });
        copyIntegrationRoot = path.join(
          verifiedPackageCopy.packageRoot,
          path.relative(packageRoot, integrationRoot),
        );
        copyDockerfilePath = path.join(
          verifiedPackageCopy.packageRoot,
          path.relative(packageRoot, dockerfilePath),
        );
      }

      stageTrackedCoreBuildInput(buildCtx);
      removeTrackedDeveloperSymlinks(buildCtx);
      removeSiblingHarnessPackages(buildCtx, packageDirectoryName);
      fs.rmSync(stagedPackageRoot, { recursive: true, force: true });
      copyComposedBuildContextTree(
        copyIntegrationRoot,
        stagedPackageRoot,
        `${agent.displayName} package integration`,
      );
      assertBuildContextHasNoSymlinks(buildCtx);
      fs.copyFileSync(copyDockerfilePath, stagedDockerfile);

      if (verifiedPackageCopy) {
        const copiedTree = validateHarnessPackageTree(verifiedPackageCopy.packageRoot, {
          sourceTrust: "mutable",
        });
        if (copiedTree.contentDigest !== verifiedPackageCopy.contentDigest) {
          throw new Error("Verified harness package copy changed during build-context staging");
        }
        assertTreeAuthority(getPackageTreeAuthority(copiedTree));
      }

      normalizeAgentBuildContextModes(buildCtx);
      const stagedPackageDigest = fingerprintBuildContext(stagedPackageRoot);
      return {
        buildCtx,
        stagedDockerfile,
        verifyBuildCtx: () => {
          try {
            return fingerprintBuildContext(stagedPackageRoot) === stagedPackageDigest;
          } catch {
            return false;
          }
        },
      };
    } finally {
      verifiedPackageCopy?.removeStagingRoot();
      if (verifiedPackageParent) fs.rmdirSync(verifiedPackageParent);
    }
  } catch (error) {
    removeAgentBuildContext(buildCtx);
    throw error;
  }
}

function restoreBuildContextDirectoryWrites(directory: string): void {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  fs.chmodSync(directory, (metadata.mode & 0o777) | 0o700);
  for (const entry of fs.readdirSync(directory)) {
    restoreBuildContextDirectoryWrites(path.join(directory, entry));
  }
}

/** Remove a private context after Docker has consumed its read-only payload. */
function removeAgentBuildContext(buildCtx: string): void {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(buildCtx));
  if (
    !relative.startsWith(SANDBOX_BUILD_CONTEXT_PREFIX) ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to remove an unrecognized agent build context: ${buildCtx}`);
  }
  if (!fs.existsSync(buildCtx)) return;
  restoreBuildContextDirectoryWrites(buildCtx);
  fs.rmSync(buildCtx, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function normalizeAgentBuildContextModes(buildCtx: string): void {
  // Installed package objects are private on the host. Docker preserves those
  // modes when it copies package bytes into an image, where later build steps
  // may run as the sandbox user. Make only the staged payload readable while
  // keeping the temporary build-context root private to this host user.
  for (const entry of fs.readdirSync(buildCtx)) {
    normalizeReadModesForDockerCopy(path.join(buildCtx, entry));
  }
}

function requireAgentPackageRoot(agent: AgentDefinition): string {
  const packageRoot = agent.packageRoot;
  if (!path.isAbsolute(packageRoot) || path.resolve(packageRoot) !== packageRoot) {
    throw new Error(`${agent.displayName} package root is not a canonical absolute path`);
  }
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(packageRoot);
  } catch {
    throw new Error(`${agent.displayName} package root is missing: ${packageRoot}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`${agent.displayName} package root is not a trusted directory: ${packageRoot}`);
  }
  return packageRoot;
}

function requireAgentPackageAsset(
  agent: AgentDefinition,
  packageRoot: string,
  assetPath: string,
  label: string,
): void {
  const relative = path.relative(packageRoot, assetPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${agent.displayName} ${label} escapes its package root`);
  }
  let resolvedAsset: string;
  try {
    resolvedAsset = fs.realpathSync(assetPath);
  } catch {
    throw new Error(`${agent.displayName} ${label} is missing: ${assetPath}`);
  }
  const resolvedRelative = path.relative(packageRoot, resolvedAsset);
  if (
    resolvedRelative === ".." ||
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative)
  ) {
    throw new Error(`${agent.displayName} ${label} escapes its package root`);
  }
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
  /** Re-hash receipt-selected package bytes immediately before Docker consumes them. */
  verifyBuildCtx?: () => boolean;
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

function getPinnedRemoteBaseRef(agent: AgentDefinition): string | null {
  const pin = agent.managedImage?.base_image?.pinned_remote;
  if (!pin) return null;
  const finalDockerfile = agent.dockerfilePath;
  if (!finalDockerfile) {
    throw new Error(`${agent.displayName} is missing its final sandbox Dockerfile`);
  }
  let dockerfile: string;
  try {
    dockerfile = fs.readFileSync(finalDockerfile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${agent.displayName} final Dockerfile: ${finalDockerfile}`, {
      cause: error,
    });
  }
  const declarationPattern = new RegExp(`^ARG ${pin.argument}=(\\S+)$`, "gm");
  const declarations = [...dockerfile.matchAll(declarationPattern)].map((match) => match[1]);
  const pinnedRef = declarations.length === 1 ? declarations[0] : null;
  if (!pinnedRef || pinnedRef !== pin.ref) {
    throw new Error(
      `${agent.displayName} final Dockerfile must declare exactly one '${pin.argument}' matching managed_image.base_image.pinned_remote.ref`,
    );
  }
  return pinnedRef;
}

/**
 * Accept only trusted resolver output here. Pinned platform digests are valid
 * only when the resolver records the current Dockerfile-pinned ref as their
 * provenance; string callers and explicit overrides stay exact-match only.
 */
function finalDockerfileAcceptsBase(
  agent: AgentDefinition,
  image: string | SandboxBaseImageResolution,
): boolean {
  const pinnedRemoteRef = getPinnedRemoteBaseRef(agent);
  if (!pinnedRemoteRef) return true;
  const imageRef = typeof image === "string" ? image : image.ref;
  const escapedAgentName = agent.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    imageRef === `nemoclaw-${agent.name}-base-local` ||
    new RegExp(`^nemoclaw-${escapedAgentName}-[a-z0-9-]+:[^\\s]+$`, "u").test(imageRef)
  ) {
    return true;
  }
  const pinnedRepository = pinnedRemoteRef.match(OCI_DIGEST_REF_PATTERN)?.groups?.repository;
  const imageRepository = imageRef.match(OCI_DIGEST_REF_PATTERN)?.groups?.repository;
  if (
    typeof image !== "string" &&
    image.source === "pinned" &&
    image.pinnedRemoteRef === pinnedRemoteRef &&
    pinnedRepository !== undefined &&
    imageRepository === pinnedRepository
  ) {
    return true;
  }
  return imageRef === pinnedRemoteRef;
}

function packageImageProbePath(agent: AgentDefinition): string {
  return path.join(path.dirname(agent.manifestPath), ...PACKAGE_IMAGE_PROBE_SOURCE.split("/"));
}

/**
 * Run one conventional package-owned probe and bind its success marker to the
 * exact source bytes selected by the package definition.
 */
export function packageBaseImagePassesProbe(agent: AgentDefinition, imageRef: string): boolean {
  const packageRoot = requireAgentPackageRoot(agent);
  const probePath = packageImageProbePath(agent);
  requireAgentPackageAsset(agent, packageRoot, probePath, "base image probe");
  let probeDigest: string;
  try {
    probeDigest = crypto.createHash("sha256").update(fs.readFileSync(probePath)).digest("hex");
  } catch {
    return false;
  }
  const identity = agent.managedImage?.runtime_identity;
  if (!identity) return false;
  const output = dockerCapture(
    [
      "run",
      "--rm",
      ...BASE_IMAGE_PROBE_GUARDS,
      "--user",
      `${String(identity.uid)}:${String(identity.gid)}`,
      "--entrypoint",
      PACKAGE_IMAGE_PROBE_ENTRYPOINT,
      imageRef,
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === `${PACKAGE_IMAGE_PROBE_OK} ${probeDigest}`;
}

function packageBaseImageInputPaths(agent: AgentDefinition): string[] | undefined {
  if (agent.managedImage?.base_image?.package_probe !== true) return undefined;
  const agentRoot = path.dirname(agent.manifestPath);
  return [
    agent.manifestPath,
    path.join(agentRoot, "runtime", "requirements.lock"),
    path.join(agentRoot, "fabric", "requirements.lock"),
    packageImageProbePath(agent),
  ];
}

function createPackageBaseImageValidationOptions(
  agent: AgentDefinition,
): Pick<ResolveBaseImageOptions, "validateImage" | "validationDescription"> {
  const declaration = agent.managedImage?.base_image;
  const packageProbe = declaration?.package_probe === true;
  const securityInventory = declaration?.security_inventory === true;
  if (!packageProbe && !securityInventory) return {};
  const validateImage = (imageRef: string): boolean =>
    (!packageProbe || packageBaseImagePassesProbe(agent, imageRef)) &&
    (!securityInventory || sandboxBaseImageHasSecurityInventory(imageRef));
  const validationDescription = packageProbe
    ? securityInventory
      ? "the package-bound image probe and the immutable security package inventory"
      : "the package-bound image probe"
    : "the immutable security package inventory";
  return { validateImage, validationDescription };
}

function createAgentBaseImageResolutionOptions(
  agent: AgentDefinition,
  dockerfilePath: string,
  options: EnsureAgentBaseImageOptions,
): ResolveBaseImageOptions {
  const packageRoot = requireAgentPackageRoot(agent);
  requireAgentPackageAsset(agent, packageRoot, dockerfilePath, "base Dockerfile");
  const validationOptions = createPackageBaseImageValidationOptions(agent);
  const pinnedRemoteRef = getPinnedRemoteBaseRef(agent) ?? undefined;
  const pinnedRepository = pinnedRemoteRef?.match(OCI_DIGEST_REF_PATTERN)?.groups?.repository;
  const imageName =
    pinnedRepository ??
    (agent.managedImage
      ? `${agent.managedImage.repository}-base`
      : `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base`);
  return {
    imageName,
    dockerfilePath,
    inputPaths: packageBaseImageInputPaths(agent),
    buildArgs: agentBaseImageBuildArgs(agent),
    localTag: buildLocalBaseTag(`nemoclaw-${agent.name}-sandbox-base-local`, packageRoot),
    envVar: getAgentSandboxBaseImageEnvVar(agent.name),
    label: `${agent.displayName} sandbox base image`,
    requireOpenshellSandboxAbi: process.platform === "linux",
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceBaseImageRefresh,
    rootDir: packageRoot,
    pinnedRemoteRef,
    requirePinnedRemoteRef: pinnedRemoteRef !== undefined,
    allowLocalFallback: options.allowLocalFallback,
    ...validationOptions,
  };
}

/**
 * Bind a local package alias to its declared pinned base only when Docker
 * proves both refs name the same immutable image. This narrow rebuild helper
 * does not change the resolver's rule that arbitrary local overrides have no
 * inherited remote provenance.
 */
export function bindLocalAgentBaseImageToPinnedProvenance(
  agent: AgentDefinition,
  imageRef: string,
): SandboxBaseImageResolutionMetadata | null {
  const dockerfilePath = agent.dockerfileBasePath;
  const pinnedRemoteRef = getPinnedRemoteBaseRef(agent);
  if (!dockerfilePath || !pinnedRemoteRef) return null;

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
  const pinnedRepository = pinnedRemoteRef.match(OCI_DIGEST_REF_PATTERN)?.groups?.repository;
  const resolvedRemoteRef = pinnedRepoDigests.find(
    (ref) => ref.match(OCI_DIGEST_REF_PATTERN)?.groups?.repository === pinnedRepository,
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
    ...createAgentBaseImageResolutionOptions(agent, dockerfilePath, {}),
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
  const resolutionOptions = createAgentBaseImageResolutionOptions(agent, baseDockerfile, {});
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
  const baseDockerfile = agent.dockerfileBasePath;

  if (!baseDockerfile) {
    return { imageTag: null, built: false };
  }

  const resolutionOptions = createAgentBaseImageResolutionOptions(agent, baseDockerfile, options);
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
    const staged = stageAgentComposedBuildContext(
      agent,
      baseDockerfile,
      "Dockerfile.base",
      options,
    );
    let buildResult: ReturnType<typeof dockerBuild>;
    try {
      if (!staged.verifyBuildCtx()) {
        throw new Error("Staged harness package bytes changed before the Docker build");
      }
      buildResult = dockerBuild(staged.stagedDockerfile, forceBuildTag, staged.buildCtx, {
        buildArgs: resolutionOptions.buildArgs,
        ignoreError: true,
        labels: buildProvenance.labels,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } finally {
      removeAgentBuildContext(staged.buildCtx);
    }
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
      if (!finalDockerfileAcceptsBase(agent, pinnedBaseImageTag)) {
        throw new Error(
          `${agent.displayName} final image does not accept base image ref '${pinnedBaseImageTag}'; use the package-declared digest or a repository-built local base`,
        );
      }
      console.log("  \u2713 Base image built.");
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
    if (!finalDockerfileAcceptsBase(agent, resolved)) {
      throw new Error(
        `${agent.displayName} final image does not accept base image ref '${resolved.ref}'; use the package-declared digest or a repository-built local base`,
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
    const staged = stageAgentComposedBuildContext(
      agent,
      baseDockerfile,
      "Dockerfile.base",
      options,
    );
    let buildResult: ReturnType<typeof dockerBuild>;
    try {
      if (!staged.verifyBuildCtx()) {
        throw new Error("Staged harness package bytes changed before the Docker build");
      }
      buildResult = dockerBuild(staged.stagedDockerfile, baseImageTag, staged.buildCtx, {
        buildArgs: resolutionOptions.buildArgs,
        ignoreError: true,
        labels: buildProvenance.labels,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } finally {
      removeAgentBuildContext(staged.buildCtx);
    }
    if (buildResult.error || buildResult.status !== 0) {
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    console.log("  \u2713 Base image built.");
    const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
    return {
      imageTag: baseImageTag,
      built: true,
      ...(resolutionMetadata ? { resolutionMetadata } : {}),
    };
  }

  console.log("  Base image exists.");
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

  const packageRoot = requireAgentPackageRoot(agent);
  requireAgentPackageAsset(agent, packageRoot, agentDockerfile, "sandbox Dockerfile");
  const { rootDir, ...baseImageOptions } = options;
  if (agent.name !== "nemocua" && rootDir !== undefined && path.resolve(rootDir) !== packageRoot) {
    throw new Error(`${agent.displayName} build context does not match its package root`);
  }
  const { imageTag: baseImageRef, resolutionMetadata } = ensureAgentBaseImage(
    agent,
    baseImageOptions,
  );
  const staged =
    agent.name === "nemocua"
      ? null
      : stageAgentComposedBuildContext(agent, agentDockerfile, "Dockerfile", baseImageOptions);
  const buildCtx =
    staged?.buildCtx ?? fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  try {
    if (agent.name === "nemocua") fs.copyFileSync(agentDockerfile, stagedDockerfile);
    if (baseImageRef) {
      const dockerfile = fs.readFileSync(stagedDockerfile, "utf8");
      fs.writeFileSync(
        stagedDockerfile,
        dockerfile.replace(/^ARG BASE_IMAGE(?:=.*)?$/m, `ARG BASE_IMAGE=${baseImageRef}`),
      );
    }
    // Receipt-backed package staging already normalized and fingerprinted its
    // package subtree. NemoCUA is the only caller that still needs normalization here.
    if (agent.name === "nemocua") normalizeAgentBuildContextModes(buildCtx);
  } catch (error) {
    try {
      removeAgentBuildContext(buildCtx);
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
    ...(staged ? { verifyBuildCtx: staged.verifyBuildCtx } : {}),
  };
}
