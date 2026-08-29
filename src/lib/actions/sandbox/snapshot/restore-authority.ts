// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { isDeepStrictEqual } from "node:util";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../../adapters/openshell/timeouts";
import { isCandidateAgent } from "../../../agent/candidate";
import type { AgentDefinition } from "../../../agent/defs";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../../harness/package-identity";
import {
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "../../../harness/package-store";
import { resolveSandboxGatewayName } from "../../../onboard/gateway-binding";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import { resolveSandboxAgent } from "../../../onboard/sandbox-agent";
import { fingerprintSandboxLiveIdentity } from "../../../onboard/sandbox-recreate-transaction";
import {
  confirmHostLocalInferenceAuthority,
  type PreparedHostLocalInferenceAuthority,
  prepareHostLocalInferenceAuthority,
} from "../../../onboard/runtime-provider/host-local-inference-lifecycle";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import {
  prepareManagedSnapshotProfileRestore,
  readManagedSnapshotProfileAuthority,
} from "./managed-profile";
import {
  confirmSandboxRuntimeRestore,
  type PreparedSandboxRuntimeRestore,
  prepareSandboxRuntimeRestore,
} from "./provider-lifecycle";

type ResolvedSnapshotPackage = Pick<InstalledHarnessPackage, "identity" | "packageRoot">;

export interface SnapshotPackageAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly resolvePinnedPackage: (identity: HarnessPackageIdentity) => ResolvedSnapshotPackage;
}

export interface ManagedRestoreAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly captureOpenshell: typeof captureOpenshell;
}

interface ProviderRestoreAuthorityDependencies
  extends SnapshotPackageAuthorityDependencies, ManagedRestoreAuthorityDependencies {
  readonly resolveAgentDefinition: (sandbox: SandboxEntry) => AgentDefinition;
  readonly requireProvider: (sandbox: SandboxEntry) => RuntimeProviderBundle;
  readonly captureContentAuthority: typeof sandboxState.captureSnapshotRestoreAuthority;
  readonly prepareHostLocalInference: typeof prepareHostLocalInferenceAuthority;
  readonly confirmHostLocalInference: typeof confirmHostLocalInferenceAuthority;
  readonly restore: typeof sandboxState.restoreRecreatedSandboxState;
}

const defaultDependencies: Omit<
  ProviderRestoreAuthorityDependencies,
  "getSandbox" | "captureOpenshell"
> = {
  resolvePinnedPackage: (identity) => resolvePinnedHarnessPackage(identity),
  resolveAgentDefinition: (sandbox) => resolveSandboxAgent(sandbox).definition,
  requireProvider: (sandbox) =>
    requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES),
  captureContentAuthority: (...args) => sandboxState.captureSnapshotRestoreAuthority(...args),
  prepareHostLocalInference: prepareHostLocalInferenceAuthority,
  confirmHostLocalInference: confirmHostLocalInferenceAuthority,
  restore: (...args) => sandboxState.restoreRecreatedSandboxState(...args),
};

/** Bind the production retained-package resolver to the caller's registry view. */
export function createSnapshotAuthorityDependencies(
  getSandbox: SnapshotPackageAuthorityDependencies["getSandbox"],
): SnapshotPackageAuthorityDependencies {
  return Object.freeze({
    getSandbox,
    resolvePinnedPackage: resolvePinnedHarnessPackage,
  });
}

/** Bind a registry view and the production OpenShell reader to one managed restore. */
export function createManagedRestoreAuthorityDependencies(
  getSandbox: ManagedRestoreAuthorityDependencies["getSandbox"],
): ManagedRestoreAuthorityDependencies {
  return Object.freeze({ getSandbox, captureOpenshell });
}

export interface PrepareSnapshotPackageAuthorityInput {
  readonly manifest: sandboxState.RebuildManifest;
  readonly sourceSandboxName: string;
  readonly targetSandboxName: string;
  readonly targetState: "registered" | "may-be-unregistered";
}

export type SnapshotPackageAuthority = Readonly<{
  schemaVersion: 1;
  kind: "legacy" | "candidate" | "package";
  sourceSandboxName: string;
  targetSandboxName: string;
  agentType: string;
  harnessPackage: HarnessPackageIdentity | null;
  /** Exact provenance that permits a schema-v1 standard snapshot to use a migrated package. */
  harnessPackageMigration: HarnessPackageMigration | null;
  packageRoot: string | null;
  /**
   * The destination is a separate owner during `restore --to ... --force`.
   * Its package may intentionally differ from the snapshot source package;
   * this authority exists only to prove that NemoClaw is still deleting the
   * exact destination selected during preflight.
   */
  targetOwner: SnapshotTargetPackageAuthority | null;
}>;

export type SnapshotSourceRestoreAuthority = Readonly<{
  packageAuthority: SnapshotPackageAuthority;
  agentDefinition: AgentDefinition;
}>;

export type SnapshotTargetPackageAuthority = Readonly<{
  agentType: string;
  harnessPackage: HarnessPackageIdentity | null;
  packageRoot: string | null;
}>;

function effectiveRegistryAgent(entry: SandboxEntry): string {
  return entry.agent ?? "openclaw";
}

function isRepositoryQualifiedAgent(agentName: string): boolean {
  return agentName === "nemocua" || isCandidateAgent(agentName);
}

function registryPackageIdentity(
  entry: SandboxEntry,
  owner: string,
): HarnessPackageIdentity | null {
  const hasIdentity = Object.prototype.hasOwnProperty.call(entry, "harnessPackage");
  const hasMigration = Object.prototype.hasOwnProperty.call(entry, "harnessPackageMigration");
  if (
    (hasIdentity && entry.harnessPackage === undefined) ||
    (hasMigration && entry.harnessPackageMigration === undefined)
  ) {
    throw new Error(`${owner} harness package authority is malformed`);
  }
  const state = inspectHarnessPackageState(entry.harnessPackage, entry.harnessPackageMigration);
  if (state.status === "invalid") {
    throw new Error(`${owner} harness package authority is malformed`);
  }
  if (state.status === "absent") return null;
  if (state.harnessPackage.id !== effectiveRegistryAgent(entry)) {
    throw new Error(`${owner} harness package authority differs from its registered agent`);
  }
  return state.harnessPackage;
}

function requireRegistryPackageAuthority(
  entry: SandboxEntry,
  owner: string,
  authority: Pick<SnapshotTargetPackageAuthority, "agentType" | "harnessPackage">,
): void {
  if (effectiveRegistryAgent(entry) !== authority.agentType) {
    throw new Error(`${owner} agent differs from the selected snapshot`);
  }
  const currentPackage = registryPackageIdentity(entry, owner);
  if (authority.harnessPackage === null) {
    if (!isRepositoryQualifiedAgent(authority.agentType)) {
      throw new Error(`${owner} standard agent has no harness package authority`);
    }
    if (currentPackage !== null) {
      throw new Error(`${owner} harness package authority differs from the selected snapshot`);
    }
    return;
  }
  if (
    currentPackage === null ||
    !harnessPackageIdentitiesEqual(currentPackage, authority.harnessPackage)
  ) {
    throw new Error(`${owner} harness package authority differs from the selected snapshot`);
  }
}

function requireLegacyCurrentBundleAuthority(
  entry: SandboxEntry,
  agentType: string,
  expectedMigration?: HarnessPackageMigration,
): Readonly<{
  harnessPackage: HarnessPackageIdentity;
  harnessPackageMigration: HarnessPackageMigration;
}> {
  const state = inspectHarnessPackageState(entry.harnessPackage, entry.harnessPackageMigration);
  if (
    state.status !== "valid" ||
    state.harnessPackageMigration === null ||
    state.harnessPackage.id !== agentType ||
    effectiveRegistryAgent(entry) !== agentType ||
    (expectedMigration !== undefined &&
      !isDeepStrictEqual(state.harnessPackageMigration, expectedMigration))
  ) {
    throw new Error(
      "legacy standard snapshot requires matching legacy-current-bundle migration provenance",
    );
  }
  return Object.freeze({
    harnessPackage: state.harnessPackage,
    harnessPackageMigration: state.harnessPackageMigration,
  });
}

function captureTargetPackageAuthority(
  target: SandboxEntry,
  dependencies: Pick<SnapshotPackageAuthorityDependencies, "resolvePinnedPackage">,
  sourceAuthority?: Pick<SnapshotPackageAuthority, "harnessPackage" | "packageRoot">,
): SnapshotTargetPackageAuthority {
  const harnessPackage = registryPackageIdentity(target, "snapshot target");
  const sharesSourcePackage =
    harnessPackage !== null &&
    sourceAuthority?.harnessPackage !== null &&
    sourceAuthority?.harnessPackage !== undefined &&
    harnessPackageIdentitiesEqual(harnessPackage, sourceAuthority.harnessPackage);
  return Object.freeze({
    agentType: effectiveRegistryAgent(target),
    harnessPackage,
    packageRoot:
      harnessPackage === null
        ? null
        : sharesSourcePackage
          ? sourceAuthority.packageRoot
          : resolveSnapshotPackageRoot(harnessPackage, dependencies),
  });
}

function confirmPackageObjectAuthority(
  owner: string,
  authority: Pick<SnapshotTargetPackageAuthority, "harnessPackage" | "packageRoot">,
  dependencies: Pick<SnapshotPackageAuthorityDependencies, "resolvePinnedPackage">,
): void {
  if (authority.harnessPackage === null) return;
  const packageRoot = resolveSnapshotPackageRoot(authority.harnessPackage, dependencies);
  if (packageRoot !== authority.packageRoot) {
    throw new Error(`${owner} harness package object is unavailable or changed`);
  }
}

function resolveSnapshotPackageRoot(
  identity: HarnessPackageIdentity,
  dependencies: Pick<SnapshotPackageAuthorityDependencies, "resolvePinnedPackage">,
): string {
  try {
    const installed = dependencies.resolvePinnedPackage(identity);
    if (
      typeof installed.packageRoot !== "string" ||
      !harnessPackageIdentitiesEqual(installed.identity, identity)
    ) {
      throw new Error("resolved package differs from the selected snapshot");
    }
    return installed.packageRoot;
  } catch {
    throw new Error("selected snapshot harness package object is unavailable or changed");
  }
}

function resolveSnapshotAgentDefinition(
  authority: SnapshotPackageAuthority,
  dependencies: Pick<ProviderRestoreAuthorityDependencies, "getSandbox" | "resolveAgentDefinition">,
  selectedDefinition?: AgentDefinition,
): AgentDefinition {
  let definition = selectedDefinition;
  if (!definition) {
    const source = dependencies.getSandbox(authority.sourceSandboxName);
    if (!source) {
      throw new Error(`snapshot source '${authority.sourceSandboxName}' is not registered`);
    }
    requireRegistryPackageAuthority(source, "snapshot source", authority);
    definition = dependencies.resolveAgentDefinition(source);
  }
  if (definition.name !== authority.agentType) {
    throw new Error("selected snapshot agent definition differs from its registered agent");
  }
  if (authority.harnessPackage !== null && definition.packageRoot !== authority.packageRoot) {
    throw new Error("selected snapshot agent definition differs from its retained package");
  }
  return definition;
}

function confirmSelectedAgentDefinition(
  authority: SnapshotPackageAuthority,
  selectedDefinition: AgentDefinition,
  dependencies: Pick<ProviderRestoreAuthorityDependencies, "getSandbox" | "resolveAgentDefinition">,
): void {
  const repositoryQualified =
    authority.harnessPackage === null && isRepositoryQualifiedAgent(authority.agentType);
  const source = dependencies.getSandbox(authority.sourceSandboxName);
  if (!source) {
    throw new Error(`snapshot source '${authority.sourceSandboxName}' is not registered`);
  }
  requireRegistryPackageAuthority(source, "snapshot source", authority);
  let currentDefinition: AgentDefinition;
  try {
    // The production resolver re-runs repository candidate qualification before
    // loading the current definition. A definition supplied at selection time
    // is never sufficient authority at the filesystem mutation edge.
    currentDefinition = dependencies.resolveAgentDefinition(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      repositoryQualified
        ? `selected snapshot repository agent qualification is unavailable: ${detail}`
        : `selected snapshot agent definition is unavailable: ${detail}`,
    );
  }
  if (
    currentDefinition.name !== authority.agentType ||
    currentDefinition.name !== selectedDefinition.name ||
    currentDefinition.packageRoot !== selectedDefinition.packageRoot ||
    !isDeepStrictEqual(currentDefinition, selectedDefinition)
  ) {
    throw new Error(
      repositoryQualified
        ? "selected snapshot repository agent definition changed before restore"
        : "selected snapshot package agent definition changed before restore",
    );
  }
}

/** Freeze the manifest, registry, and retained-object authority selected for one restore. */
export function prepareSnapshotPackageAuthority(
  input: PrepareSnapshotPackageAuthorityInput,
  dependencies: SnapshotPackageAuthorityDependencies,
): SnapshotPackageAuthority {
  if (input.manifest.sandboxName !== input.sourceSandboxName) {
    throw new Error("selected snapshot does not belong to the requested source sandbox");
  }
  const inspection = sandboxState.inspectRebuildManifestHarnessPackage(input.manifest);
  if (inspection.status === "invalid") {
    throw new Error("selected snapshot harness package authority is malformed");
  }
  const source = dependencies.getSandbox(input.sourceSandboxName);
  if (!source) {
    throw new Error(`snapshot source '${input.sourceSandboxName}' is not registered`);
  }
  const target =
    input.targetSandboxName === input.sourceSandboxName
      ? source
      : dependencies.getSandbox(input.targetSandboxName);
  if (!target && input.targetState === "registered") {
    throw new Error(`snapshot target '${input.targetSandboxName}' is not registered`);
  }

  const legacyStandardAuthority =
    inspection.status === "legacy" && !isRepositoryQualifiedAgent(input.manifest.agentType)
      ? requireLegacyCurrentBundleAuthority(source, input.manifest.agentType)
      : null;
  const sourcePackage =
    legacyStandardAuthority?.harnessPackage ?? registryPackageIdentity(source, "snapshot source");
  const harnessPackage =
    inspection.status === "package"
      ? inspection.harnessPackage
      : inspection.status === "legacy"
        ? sourcePackage
        : null;
  if (
    inspection.status === "legacy" &&
    harnessPackage === null &&
    !isRepositoryQualifiedAgent(input.manifest.agentType)
  ) {
    throw new Error(
      "legacy snapshot requires reconciled harness package authority from its registered source",
    );
  }
  const packageRoot =
    harnessPackage === null ? null : resolveSnapshotPackageRoot(harnessPackage, dependencies);
  const targetOwner =
    target === null
      ? Object.freeze({
          // A missing destination is expected to be published from the source
          // package. The caller separately fences exact target absence or its
          // operation-owned pending registration.
          agentType: input.manifest.agentType,
          harnessPackage,
          packageRoot,
        })
      : target === source
        ? Object.freeze({
            agentType: input.manifest.agentType,
            harnessPackage,
            packageRoot,
          })
        : captureTargetPackageAuthority(target, dependencies, { harnessPackage, packageRoot });
  const authority = {
    schemaVersion: 1 as const,
    kind: inspection.status,
    sourceSandboxName: input.sourceSandboxName,
    targetSandboxName: input.targetSandboxName,
    agentType: input.manifest.agentType,
    harnessPackage,
    harnessPackageMigration: legacyStandardAuthority?.harnessPackageMigration ?? null,
    packageRoot,
    targetOwner,
  };
  requireRegistryPackageAuthority(source, "snapshot source", authority);
  if (target && authority.targetOwner) {
    requireRegistryPackageAuthority(target, "snapshot target", authority.targetOwner);
  }
  return Object.freeze(authority);
}

/** Re-read every package owner and retained object at the final mutation callback. */
export function confirmSnapshotPackageAuthority(
  authority: SnapshotPackageAuthority,
  dependencies: SnapshotPackageAuthorityDependencies,
): void {
  const source = dependencies.getSandbox(authority.sourceSandboxName);
  if (!source) {
    throw new Error(`snapshot source '${authority.sourceSandboxName}' is not registered`);
  }
  if (authority.harnessPackageMigration !== null) {
    requireLegacyCurrentBundleAuthority(
      source,
      authority.agentType,
      authority.harnessPackageMigration,
    );
  }
  const target =
    authority.targetSandboxName === authority.sourceSandboxName
      ? source
      : dependencies.getSandbox(authority.targetSandboxName);
  if (!target) {
    throw new Error(`snapshot target '${authority.targetSandboxName}' is not registered`);
  }
  requireRegistryPackageAuthority(source, "snapshot source", authority);
  if (!authority.targetOwner) {
    throw new Error(`snapshot target '${authority.targetSandboxName}' has no captured authority`);
  }
  requireRegistryPackageAuthority(target, "snapshot target", authority.targetOwner);
  confirmPackageObjectAuthority("selected snapshot", authority, dependencies);
  if (
    authority.targetOwner.harnessPackage !== null &&
    !(
      authority.harnessPackage !== null &&
      harnessPackageIdentitiesEqual(
        authority.targetOwner.harnessPackage,
        authority.harnessPackage,
      ) &&
      authority.targetOwner.packageRoot === authority.packageRoot
    )
  ) {
    confirmPackageObjectAuthority("snapshot target", authority.targetOwner, dependencies);
  }
}

/** Resolve the source definition from the same durable package authority as the snapshot. */
export function resolveSnapshotSourceAgent(
  sourceEntry: SandboxEntry,
  packageAuthority: SnapshotPackageAuthority,
): AgentDefinition {
  const resolved = resolveSandboxAgent(sourceEntry);
  if (
    resolved.effectiveAgentId !== packageAuthority.agentType ||
    resolved.definition.name !== packageAuthority.agentType
  ) {
    throw new Error("Snapshot source agent differs from the selected snapshot.");
  }
  if (packageAuthority.harnessPackage === null) {
    if (resolved.harnessPackage !== null) {
      throw new Error("Snapshot source package differs from the selected snapshot.");
    }
    return resolved.definition;
  }
  if (
    resolved.harnessPackage === null ||
    !harnessPackageIdentitiesEqual(resolved.harnessPackage, packageAuthority.harnessPackage) ||
    resolved.definition.packageRoot !== packageAuthority.packageRoot
  ) {
    throw new Error("Snapshot source package differs from the selected snapshot.");
  }
  return resolved.definition;
}

function confirmSnapshotSourceAgentAuthority(
  packageAuthority: SnapshotPackageAuthority,
  dependencies: SnapshotPackageAuthorityDependencies,
): AgentDefinition {
  const currentSource = dependencies.getSandbox(packageAuthority.sourceSandboxName);
  if (!currentSource) {
    throw new Error(
      `snapshot source '${packageAuthority.sourceSandboxName}' is no longer registered`,
    );
  }
  // Package-backed sources re-resolve their retained object here. Candidate
  // sources re-run their repository qualification gate through loadAgent().
  return resolveSnapshotSourceAgent(currentSource, packageAuthority);
}

/** Recheck package and source-definition authority at a restore mutation edge. */
export function confirmSnapshotPackageAndAgentAuthority(
  packageAuthority: SnapshotPackageAuthority,
  dependencies: SnapshotPackageAuthorityDependencies,
  selectedDefinition: AgentDefinition,
  options: { targetMayBeUnregistered?: boolean } = {},
): AgentDefinition {
  // Before clone publication the target is either absent or an ownerless
  // host-route reservation, so only source/package-object authority exists.
  // The exact target absence/reservation is fenced separately by the caller.
  if (options.targetMayBeUnregistered !== true) {
    confirmSnapshotPackageAuthority(packageAuthority, dependencies);
  }
  const currentDefinition = confirmSnapshotSourceAgentAuthority(packageAuthority, dependencies);
  if (!isDeepStrictEqual(currentDefinition, selectedDefinition)) {
    throw new Error(
      "Snapshot source agent definition changed after restore authority was captured.",
    );
  }
  return currentDefinition;
}

/** Match only the package/candidate portion of an operation-owned pending clone row. */
export function pendingCloneMatchesPackageAuthority(
  pending: SandboxEntry,
  packageAuthority: SnapshotPackageAuthority,
): boolean {
  if ((pending.agent || "openclaw") !== packageAuthority.agentType) return false;
  const hasPackage = Object.prototype.hasOwnProperty.call(pending, "harnessPackage");
  const hasMigration = Object.prototype.hasOwnProperty.call(pending, "harnessPackageMigration");
  if (packageAuthority.harnessPackage === null) {
    return !hasPackage && !hasMigration;
  }
  return (
    hasPackage &&
    !hasMigration &&
    harnessPackageIdentitiesEqual(pending.harnessPackage, packageAuthority.harnessPackage)
  );
}

/** Prove that the target registry row still owns the same live OpenShell sandbox. */
export function confirmSnapshotRestoreLiveIdentity(
  target: SandboxEntry,
  capture: ManagedRestoreAuthorityDependencies["captureOpenshell"],
): void {
  const expectedFingerprint = target.lifecycleLiveIdentityFingerprint;
  if (typeof expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) {
    throw new Error(`target '${target.name}' has no valid captured live identity`);
  }
  const gatewayName = resolveSandboxGatewayName(target);
  const probe = capture(["sandbox", "get", "-g", gatewayName, target.name], {
    ignoreError: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : ""));
  if (probe.error || probe.signal || probe.status !== 0) {
    throw new Error(
      `target '${target.name}' live identity is unavailable on gateway '${gatewayName}'`,
    );
  }
  const currentFingerprint = fingerprintSandboxLiveIdentity(stdout);
  if (!currentFingerprint) {
    throw new Error(
      `target '${target.name}' has no exact live identity on gateway '${gatewayName}'`,
    );
  }
  if (currentFingerprint !== expectedFingerprint) {
    throw new Error(`target '${target.name}' live identity changed before restore`);
  }
}

function failure(error: unknown): sandboxState.RestoreResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    restoredDirs: [],
    failedDirs: ["manifest"],
    restoredFiles: [],
    failedFiles: [],
    error: `Cannot restore snapshot authority: ${detail}.`,
  };
}

/** Restore a rebuild backup through package, content, and optional provider authority. */
export function restoreRecreatedSandboxStateWithManagedAuthority(
  sandboxName: string,
  manifest: sandboxState.RebuildManifest,
  options: sandboxState.RecreatedSandboxRestoreOptions,
  overrides: Pick<ProviderRestoreAuthorityDependencies, "getSandbox" | "captureOpenshell"> &
    Partial<Omit<ProviderRestoreAuthorityDependencies, "getSandbox" | "captureOpenshell">>,
): sandboxState.RestoreResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  let packageAuthority: SnapshotPackageAuthority;
  let agentDefinition: AgentDefinition;
  try {
    packageAuthority = prepareSnapshotPackageAuthority(
      {
        manifest,
        sourceSandboxName: manifest.sandboxName,
        targetSandboxName: sandboxName,
        targetState: "registered",
      },
      dependencies,
    );
    agentDefinition = resolveSnapshotAgentDefinition(
      packageAuthority,
      dependencies,
      options.agentDefinition,
    );
  } catch (error) {
    return failure(error);
  }
  let snapshotProfile;
  try {
    snapshotProfile = readManagedSnapshotProfileAuthority({
      sandboxName: manifest.sandboxName,
      agentType: manifest.agentType,
      workload: manifest.workload,
    });
  } catch (error) {
    return failure(error);
  }
  const hostLocalInferenceReceipt = manifest.hostLocalInferenceReceipt;
  if (snapshotProfile && !manifest.runtimeSnapshot) {
    return failure("managed snapshot is missing provider runtime authority");
  }

  let preparedRuntime: PreparedSandboxRuntimeRestore | null = null;
  let preparedHostLocal: PreparedHostLocalInferenceAuthority | null = null;
  let providerId: string | null = null;
  let selectedTargetEntry: SandboxEntry | null = null;
  let contentAuthority: sandboxState.SnapshotRestoreAuthority;
  try {
    const target = dependencies.getSandbox(sandboxName);
    if (!target) throw new Error(`target '${sandboxName}' is not registered`);
    selectedTargetEntry = structuredClone(target);
    if (snapshotProfile || typeof hostLocalInferenceReceipt === "string") {
      const provider = dependencies.requireProvider(target);
      providerId = provider.identity.id;
      if (snapshotProfile) {
        const profileRestore = prepareManagedSnapshotProfileRestore(
          {
            sandboxName: manifest.sandboxName,
            agentType: manifest.agentType,
            workload: manifest.workload,
          },
          target,
          provider,
        );
        if (!profileRestore) throw new Error("managed profile restore authority is missing");
        preparedRuntime = prepareSandboxRuntimeRestore(
          provider,
          target,
          manifest.runtimeSnapshot!,
          profileRestore.providerRestoreAuthority,
        );
      }
      if (typeof hostLocalInferenceReceipt === "string") {
        if (
          !isDeepStrictEqual(
            target.hostLocalInferenceProvenance,
            manifest.hostLocalInferenceProvenance,
          )
        ) {
          throw new Error("snapshot inference provenance differs from the target lifecycle");
        }
        preparedHostLocal = dependencies.prepareHostLocalInference(
          provider,
          target,
          hostLocalInferenceReceipt,
        );
        if (!preparedHostLocal) {
          throw new Error("snapshot inference receipt has no common lifecycle authority");
        }
      }
    }
    const captured = dependencies.captureContentAuthority(manifest.backupPath, manifest);
    if (!captured) throw new Error("selected snapshot content changed during restore preflight");
    contentAuthority = captured;
  } catch (error) {
    return failure(error);
  }

  const confirmSelectedTargetLiveIdentity = (): void => {
    if (!selectedTargetEntry) {
      throw new Error(`target '${sandboxName}' has no captured registry identity`);
    }
    confirmSnapshotRestoreLiveIdentity(selectedTargetEntry, dependencies.captureOpenshell);
  };

  const restore = dependencies.restore(sandboxName, manifest.backupPath, {
    ...options,
    agentDefinition,
    authority: contentAuthority,
    validateBeforeMutation: () => {
      confirmSnapshotPackageAuthority(packageAuthority, dependencies);
      confirmSelectedAgentDefinition(packageAuthority, agentDefinition, dependencies);
      const current = dependencies.getSandbox(sandboxName);
      if (!current) throw new Error(`target '${sandboxName}' is no longer registered`);
      if (!selectedTargetEntry || !isDeepStrictEqual(current, selectedTargetEntry)) {
        throw new Error(`target '${sandboxName}' changed before restore`);
      }
      confirmSelectedTargetLiveIdentity();
      if (!snapshotProfile && typeof hostLocalInferenceReceipt !== "string") return;
      const provider = dependencies.requireProvider(current);
      if (providerId === null || provider.identity.id !== providerId) {
        throw new Error(`target '${sandboxName}' runtime provider changed before restore`);
      }
      if (snapshotProfile) {
        const profileRestore = prepareManagedSnapshotProfileRestore(
          {
            sandboxName: manifest.sandboxName,
            agentType: manifest.agentType,
            workload: manifest.workload,
          },
          current,
          provider,
        );
        if (!profileRestore) throw new Error("managed profile restore authority is missing");
        if (!preparedRuntime) throw new Error("managed runtime restore authority is missing");
        preparedRuntime = prepareSandboxRuntimeRestore(
          provider,
          current,
          preparedRuntime.source,
          profileRestore.providerRestoreAuthority,
        );
      }
      if (typeof hostLocalInferenceReceipt === "string") {
        if (!preparedHostLocal) {
          throw new Error("host-local inference restore authority is missing");
        }
        if (
          !isDeepStrictEqual(
            current.hostLocalInferenceProvenance,
            manifest.hostLocalInferenceProvenance,
          )
        ) {
          throw new Error("snapshot inference provenance changed before restore");
        }
        dependencies.confirmHostLocalInference(provider, current, preparedHostLocal, {
          validateBeforeMutation: confirmSelectedTargetLiveIdentity,
        });
      }
    },
  });
  if (!restore.success) return restore;

  try {
    confirmSnapshotPackageAuthority(packageAuthority, dependencies);
    confirmSelectedAgentDefinition(packageAuthority, agentDefinition, dependencies);
    const current = dependencies.getSandbox(sandboxName);
    if (!current) throw new Error(`target '${sandboxName}' is no longer registered`);
    if (!selectedTargetEntry || !isDeepStrictEqual(current, selectedTargetEntry)) {
      throw new Error(`target '${sandboxName}' changed during restore`);
    }
    if (!preparedRuntime && !preparedHostLocal) return restore;
    const provider = dependencies.requireProvider(current);
    if (providerId === null || provider.identity.id !== providerId) {
      throw new Error(`target '${sandboxName}' runtime provider changed during restore`);
    }
    if (preparedRuntime) {
      confirmSandboxRuntimeRestore(provider, current, preparedRuntime, {
        validateBeforeMutation: confirmSelectedTargetLiveIdentity,
      });
    }
    if (preparedHostLocal) {
      dependencies.confirmHostLocalInference(provider, current, preparedHostLocal, {
        validateBeforeMutation: confirmSelectedTargetLiveIdentity,
      });
    }
    return restore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...restore,
      success: false,
      error:
        `State was restored, but snapshot authority proof failed: ${detail}. ` +
        `Retry this exact snapshot after the sandbox state stabilizes.`,
    };
  }
}
