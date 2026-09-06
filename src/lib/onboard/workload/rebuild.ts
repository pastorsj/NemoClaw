// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type {
  HarnessManagedImageDeclaration,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";
import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { loadHarnessStartupProfileAdapterHostModule } from "../../agent-runtime/startup-module";
import { readCandidateQualificationReceipt } from "../../agent/candidate";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { getVersion } from "../../core/version";
import type { SandboxEntry } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  isCandidateManagedImageAgent,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  qualifiedManagedImageDeclaration,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  type PackageManagedImageContract,
  parsePackageManagedImageContract,
  parseStockManagedImageContract,
} from "../managed-image/contract";
import {
  buildManagedStartupPackageProfile,
  type BuiltManagedStartupPackageProfile,
} from "../managed-startup/package-profile";
import {
  buildManagedStartupPackagePreparationInput,
  type ManagedStartupPackagePreparationSource,
} from "../managed-startup/package-input";
import {
  type BuiltManagedStartupOnboardProfile,
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "../managed-startup/onboard-profile";
import type {
  ManagedStartupDurableProfile,
  ManagedStartupProfile,
} from "../managed-startup/profile";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import { requireRuntimeProviderMutationAuthority } from "../runtime-provider/registry";
import {
  type ManagedWorkloadAuthority,
  type ManagedWorkloadReceipt,
  type PackageManagedWorkloadAuthority,
  readDurableManagedWorkloadAuthority,
} from "./authority";

export type { ManagedWorkloadReceipt } from "./authority";

import {
  liveE2eManagedImageCatalog,
  liveE2eManagedImageRevision,
  type PreparedSandboxWorkloadSource,
  prepareSandboxWorkloadSource,
  SandboxWorkloadPreparationError,
} from "./preparation";
import {
  type ManagedImageWorkloadSource,
  managedImageRuntimePlatform,
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
} from "./source";
import {
  managedWorkloadRebuildProfileEnvironment,
  type ManagedWorkloadRebuildProfileOverrides,
} from "./rebuild-compat";

export {
  managedWorkloadRebuildProfileEnvironment,
  type ManagedWorkloadRebuildProfileOverrides,
} from "./rebuild-compat";

interface ManagedWorkloadRebuildCatalogHandoffCommon {
  readonly schemaVersion: 1;
  readonly providerId: string;
  /** Receipt-pinned package declaration retained across rebuild preparation. */
  readonly managedImage: HarnessManagedImageDeclaration;
  /** Exact authority retained until a replacement has become Ready. */
  readonly previousReceipt: ManagedWorkloadReceipt;
  /** Durable authorization marker for an already-prepared remote dashboard. */
  readonly previousDashboardRemoteBindPrepared: boolean;
  /** Exact current-release image selected from one complete all-agent catalog. */
  readonly replacement: PreparedSandboxWorkloadSource & {
    readonly source: ManagedImageWorkloadSource;
  };
  /** Validated public CA material retained across a profile-only rebuild. */
  readonly corporateCa: ResolvedCorporateCa | null;
}

export interface LegacyManagedWorkloadRebuildCatalogHandoff extends ManagedWorkloadRebuildCatalogHandoffCommon {
  readonly agent: ManagedImageAgent;
  readonly harnessPackage?: null;
  readonly previousContract: ManagedImageContractV1;
  readonly previousProfile: ManagedStartupProfile;
}

export interface PackageManagedWorkloadRebuildCatalogHandoff extends ManagedWorkloadRebuildCatalogHandoffCommon {
  readonly agent: string;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly previousContract: PackageManagedImageContract;
  readonly previousProfile: Extract<
    ManagedStartupDurableProfile,
    { readonly profileKind: "package" }
  >;
}

export type ManagedWorkloadRebuildCatalogHandoff =
  | LegacyManagedWorkloadRebuildCatalogHandoff
  | PackageManagedWorkloadRebuildCatalogHandoff;

export type LegacyManagedWorkloadRebuildHandoff = LegacyManagedWorkloadRebuildCatalogHandoff & {
  readonly replacementProfile: BuiltManagedStartupOnboardProfile;
};

export type PackageManagedWorkloadRebuildHandoff = PackageManagedWorkloadRebuildCatalogHandoff & {
  readonly replacementProfile: BuiltManagedStartupPackageProfile;
};

/** Fully rendered replacement profile retained before provider or registry mutation. */
export type ManagedWorkloadRebuildHandoff =
  | LegacyManagedWorkloadRebuildHandoff
  | PackageManagedWorkloadRebuildHandoff;

export class ManagedWorkloadRebuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed workload rebuild preflight failed: ${message}`, options);
    this.name = "ManagedWorkloadRebuildError";
  }
}

function requireProviderBoundAuthority(
  authority: ManagedWorkloadAuthority | PackageManagedWorkloadAuthority,
  runtime: SandboxWorkloadRuntimeCapabilities,
  provider: RuntimeProviderBundle,
): void {
  if (runtime.driverName !== provider.identity.id) {
    throw new ManagedWorkloadRebuildError(
      `runtime '${runtime.driverName}' does not match provider '${provider.identity.id}'`,
    );
  }
  requireRuntimeProviderMutationAuthority(provider, "rebuild");
  if (!provider.workload.acceptsReceipt(authority.receipt)) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' does not accept the durable workload receipt`,
    );
  }
  const runtimePlatform = managedImageRuntimePlatform(runtime);
  if (runtimePlatform === null) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' has no unambiguous managed-image host platform`,
    );
  }
  if (authority.contract.platform !== runtimePlatform) {
    throw new ManagedWorkloadRebuildError(
      `the recorded workload targets '${authority.contract.platform}', but provider ` +
        `'${provider.identity.id}' requires '${runtimePlatform}'`,
    );
  }
}

export const managedWorkloadRebuildDependencies = {
  prepareSandboxWorkloadSource,
  loadHarnessStartupProfileAdapterHostModule,
};

/**
 * Validate the old receipt and provider bundle, then resolve the current CLI
 * release as a complete all-agent catalog before any mutation. Managed rebuild
 * never falls back to a Dockerfile or a mutable tag.
 */
export async function prepareManagedWorkloadRebuildHandoff(
  entry: Pick<
    SandboxEntry,
    | "agent"
    | "dashboardRemoteBindPrepared"
    | "fromDockerfile"
    | "harnessPackage"
    | "harnessPackageMigration"
    | "imageTag"
    | "workload"
  >,
  options: {
    readonly runtime: SandboxWorkloadRuntimeCapabilities;
    readonly provider: RuntimeProviderBundle;
    readonly agentDefinition?: Pick<AgentDefinition, "managedImage" | "name">;
    readonly version?: string;
  },
): Promise<ManagedWorkloadRebuildCatalogHandoff | null> {
  const authority = readDurableManagedWorkloadAuthority(entry, options.agentDefinition);
  if (!authority) return null;
  const managedImage = authority.managedImage;
  if (
    managedImage === null ||
    (options.agentDefinition !== undefined && options.agentDefinition.name !== authority.agent)
  ) {
    throw new ManagedWorkloadRebuildError(
      "the receipt-pinned package does not declare the recorded managed image",
    );
  }
  requireProviderBoundAuthority(authority, options.runtime, options.provider);

  let replacement: PreparedSandboxWorkloadSource;
  if (authority.harnessPackage === null && isCandidateManagedImageAgent(authority.agent)) {
    // A candidate publishes outside the all-agent release cohort, so its
    // replacement comes from the protected qualification receipt rather than
    // the current release catalog.
    let contract;
    try {
      contract = readCandidateQualificationReceipt(authority.agent);
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the protected candidate qualification receipt is unavailable or invalid",
        { cause: error },
      );
    }
    try {
      replacement = {
        source: resolveSandboxWorkloadSource({
          agentName: authority.agent,
          managedImage,
          legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
          runtime: options.runtime,
          catalog: { [authority.agent]: contract },
          policy: "require-managed",
          candidateAgentsEnabled: true,
        }),
        release: contract.source.release,
        fallbackDiagnostic: null,
      };
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the accepted candidate image is not supported by the selected runtime",
        { cause: error },
      );
    }
  } else {
    const qualificationRevision = liveE2eManagedImageRevision(process.env);
    const liveCatalog = liveE2eManagedImageCatalog(process.env);
    if (qualificationRevision && liveCatalog) {
      throw new ManagedWorkloadRebuildError(
        "live E2E managed-image revision and catalog authority conflict",
      );
    }
    try {
      replacement = await managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource({
        agentName: authority.agent,
        managedImage,
        ...(authority.harnessPackage === null ? {} : { harnessPackage: authority.harnessPackage }),
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: options.runtime,
        version: options.version ?? getVersion(),
        policy: "require-managed",
        ...(liveCatalog
          ? {
              ...(liveCatalog.catalog ? { catalog: liveCatalog.catalog } : {}),
              catalogPath: liveCatalog.path,
              expectedCatalogRevision: liveCatalog.revision,
            }
          : {}),
        ...(qualificationRevision ? { catalogRevision: qualificationRevision } : {}),
      });
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the selected managed-image catalog is unavailable or invalid",
        { cause: error },
      );
    }
  }
  if (replacement.source.kind !== "managed-image") {
    throw new ManagedWorkloadRebuildError(
      "the current release did not resolve to an immutable managed image",
    );
  }

  const common = {
    schemaVersion: 1 as const,
    providerId: options.provider.identity.id,
    managedImage,
    previousReceipt: authority.receipt,
    previousDashboardRemoteBindPrepared: entry.dashboardRemoteBindPrepared === true,
    replacement: {
      ...replacement,
      source: replacement.source,
    },
    corporateCa: authority.corporateCa,
  };
  if (authority.harnessPackage === null) {
    const handoff: LegacyManagedWorkloadRebuildCatalogHandoff = {
      ...common,
      agent: authority.agent,
      harnessPackage: null,
      previousContract: authority.contract,
      previousProfile: authority.profile,
    };
    return cloneAndDeepFreeze(handoff);
  }
  const handoff: PackageManagedWorkloadRebuildCatalogHandoff = {
    ...common,
    agent: authority.agent,
    harnessPackage: authority.harnessPackage,
    previousContract: authority.contract,
    previousProfile: authority.profile,
  };
  return cloneAndDeepFreeze(handoff);
}

/** Revalidate the retained handoff against the live registry row and provider. */
export function managedWorkloadRebuildHandoffMatchesEntry(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  entry: Pick<
    SandboxEntry,
    | "agent"
    | "dashboardRemoteBindPrepared"
    | "fromDockerfile"
    | "harnessPackage"
    | "harnessPackageMigration"
    | "imageTag"
    | "workload"
  > | null,
  provider: RuntimeProviderBundle,
): boolean {
  if (!entry || provider.identity.id !== handoff.providerId) return false;
  try {
    const current = readDurableManagedWorkloadAuthority(entry, {
      name: handoff.agent,
      managedImage: handoff.managedImage,
    });
    return (
      current !== null &&
      current.agent === handoff.agent &&
      (entry.dashboardRemoteBindPrepared === true) ===
        handoff.previousDashboardRemoteBindPrepared &&
      isDeepStrictEqual(current.harnessPackage, handoff.harnessPackage) &&
      provider.workload.acceptsReceipt(current.receipt) &&
      isDeepStrictEqual(current.receipt, handoff.previousReceipt) &&
      isDeepStrictEqual(current.contract, handoff.previousContract) &&
      isDeepStrictEqual(current.profile, handoff.previousProfile)
    );
  } catch {
    return false;
  }
}

type ManagedWorkloadRebuildProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "environment" | "corporateCa"
>;

/** Reconcile one package profile without consulting the built-in harness catalogue. */
export function stageManagedPackageWorkloadRebuildProfile(
  handoff: PackageManagedWorkloadRebuildCatalogHandoff,
  desiredState: HarnessStartupSettings,
  adapter = managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule(
    handoff.harnessPackage,
  ),
): PackageManagedWorkloadRebuildHandoff {
  let replacementProfile: BuiltManagedStartupPackageProfile;
  try {
    const result = adapter.reconcileStartupProfile({
      packageId: handoff.harnessPackage.id,
      harnessPackage: handoff.harnessPackage,
      desiredState,
      currentPackageConfig: handoff.previousProfile.packageConfig,
    });
    if (result.kind === "unsupported") {
      throw new Error(
        `harness package '${handoff.harnessPackage.id}' does not support startup reconciliation: ${result.reason}`,
      );
    }
    replacementProfile = buildManagedStartupPackageProfile({
      harnessPackage: handoff.harnessPackage,
      desiredState,
      packageConfig: result.packageConfig,
      credentialProxyReplayRequired: handoff.previousReceipt.credentialProxyReplayRequired,
      dashboardRemoteBindPrepared: handoff.previousDashboardRemoteBindPrepared,
      ...(handoff.previousReceipt.corporateCaB64 === undefined
        ? {}
        : { corporateCaB64: handoff.previousReceipt.corporateCaB64 }),
    });
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      `the package startup profile could not be reconciled from authoritative rebuild state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return cloneAndDeepFreeze({ ...handoff, replacementProfile });
}

/** Let the exact package normalize current operator intent before opaque config reconciliation. */
export function stagePreparedManagedPackageWorkloadRebuildProfile(
  handoff: PackageManagedWorkloadRebuildCatalogHandoff,
  source: ManagedStartupPackagePreparationSource,
): PackageManagedWorkloadRebuildHandoff {
  try {
    const adapter = managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule(
      handoff.harnessPackage,
    );
    const preparedInput = buildManagedStartupPackagePreparationInput(
      source,
      adapter.startupProfileEnvironment,
    );
    const result = adapter.prepareStartupProfile({
      packageId: handoff.harnessPackage.id,
      harnessPackage: handoff.harnessPackage,
      phase: "rebuild",
      input: preparedInput.input,
      previousDesiredState: handoff.previousProfile.desiredState,
    });
    if (result.kind === "unsupported") {
      throw new Error(
        `harness package '${handoff.harnessPackage.id}' does not support startup profile preparation: ${result.reason}`,
      );
    }
    if (
      result.credentialProxyReplayRequired !==
        handoff.previousReceipt.credentialProxyReplayRequired ||
      result.dashboardRemoteBindPrepared !== handoff.previousDashboardRemoteBindPrepared ||
      preparedInput.corporateCaB64 !== handoff.previousReceipt.corporateCaB64
    ) {
      throw new Error("the package changed durable startup preparation authority");
    }
    return stageManagedPackageWorkloadRebuildProfile(handoff, result.desiredState, adapter);
  } catch (error) {
    if (error instanceof ManagedWorkloadRebuildError) throw error;
    throw new ManagedWorkloadRebuildError(
      `the package startup profile could not be prepared from authoritative rebuild state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Render every fallible replacement-profile input while the old workload is
 * authoritative. Mutable rebuild state is explicit; receipt-only tuning,
 * managed proxy intent, and public CA material come from validated authority.
 */
export function stageManagedWorkloadRebuildProfile(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  input: ManagedWorkloadRebuildProfileInput | null,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ManagedWorkloadRebuildProfileOverrides = {},
): ManagedWorkloadRebuildHandoff {
  if (handoff.harnessPackage) {
    throw new ManagedWorkloadRebuildError(
      "receipt-backed startup profiles require package-owned preparation",
    );
  }
  if (input === null) {
    throw new ManagedWorkloadRebuildError(
      "legacy startup profile reconstruction requires current authoritative intent",
    );
  }
  let replacementProfile: BuiltManagedStartupOnboardProfile;
  try {
    replacementProfile = buildManagedStartupOnboardProfile({
      ...input,
      agentName: handoff.agent,
      environment: managedWorkloadRebuildProfileEnvironment(handoff, environment, overrides),
      corporateCa: handoff.corporateCa,
    });
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      `the replacement startup profile could not be rendered from authoritative rebuild state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (
    replacementProfile.credentialProxyReplayRequired !==
    handoff.previousReceipt.credentialProxyReplayRequired
  ) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile changed the durable credential-proxy requirement",
    );
  }
  if (replacementProfile.profile.agent !== handoff.agent) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile does not match the selected managed-image agent",
    );
  }
  return cloneAndDeepFreeze({ ...handoff, replacementProfile });
}

/**
 * Bind a retained replacement contract to the selected provider capability.
 * The same immutable source resolver used by fresh onboarding performs the
 * check; no mutable release pointer is consulted.
 */
export function prepareSandboxWorkloadSourceFromRebuildHandoff(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  runtime: SandboxWorkloadRuntimeCapabilities,
  provider: RuntimeProviderBundle,
): PreparedSandboxWorkloadSource {
  if (runtime.driverName !== provider.identity.id || handoff.providerId !== provider.identity.id) {
    throw new SandboxWorkloadPreparationError(
      "the rebuild handoff does not belong to the selected runtime provider",
    );
  }
  let source;
  try {
    source = resolveSandboxWorkloadSource({
      agentName: handoff.agent,
      managedImage: handoff.managedImage,
      harnessPackage: handoff.harnessPackage,
      legacyDockerfilePath: "",
      runtime,
      catalog: { [handoff.agent]: handoff.replacement.source.contract },
      policy: "require-managed",
      candidateAgentsEnabled:
        !handoff.harnessPackage && isCandidateManagedImageAgent(handoff.agent),
    });
  } catch (error) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload is not supported by the selected runtime",
      { cause: error },
    );
  }
  if (source.kind !== "managed-image") {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload did not resolve to an immutable image",
    );
  }
  if (
    source.reference !== handoff.replacement.source.reference ||
    source.contract.source.cohort !== handoff.replacement.source.contract.source.cohort ||
    source.contract.source.revision !== handoff.replacement.source.contract.source.revision
  ) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload changed during source resolution",
    );
  }
  if (
    source.contract.capabilityContractVersion !== MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION ||
    source.contract.startupProfileContractVersion !== MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION
  ) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload uses an unsupported contract version",
    );
  }
  return { source, release: handoff.replacement.release, fallbackDiagnostic: null };
}

/**
 * Materialize the exact durable replacement receipt only after the profile is
 * completely rendered. The receipt remains a shared-image authority and is
 * never eligible for per-sandbox image deletion.
 */
export function buildManagedWorkloadRebuildReceipt(
  handoff: ManagedWorkloadRebuildHandoff,
  provider: RuntimeProviderBundle,
): ManagedWorkloadReceipt {
  if (handoff.providerId !== provider.identity.id) {
    throw new ManagedWorkloadRebuildError(
      "the replacement receipt does not belong to the selected provider",
    );
  }
  let contract: ManagedImageContractV1 | PackageManagedImageContract;
  try {
    contract = !handoff.harnessPackage
      ? parseStockManagedImageContract(
          handoff.replacement.source.contract,
          handoff.agent,
          handoff.managedImage,
          handoff.previousContract.platform,
        )
      : parsePackageManagedImageContract(
          handoff.replacement.source.contract,
          handoff.harnessPackage,
          handoff.managedImage,
          handoff.previousContract.platform,
        );
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      "the replacement image contract does not match the exact rebuild agent and platform",
      { cause: error },
    );
  }
  if (handoff.replacement.source.reference !== contract.reference) {
    throw new ManagedWorkloadRebuildError(
      "the replacement image source does not match its immutable image contract",
    );
  }
  const profile = handoff.replacementProfile;
  if (profile.profile.agent !== handoff.agent) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile does not match the exact rebuild agent",
    );
  }
  if (
    handoff.harnessPackage &&
    handoff.replacementProfile.dashboardRemoteBindPrepared !==
      handoff.previousDashboardRemoteBindPrepared
  ) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile changed the durable remote-dashboard preparation marker",
    );
  }
  const receipt: ManagedWorkloadReceipt = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: contract.reference,
    platform: contract.platform,
    release: contract.source.release,
    sourceRevision: contract.source.revision,
    sourceCohort: contract.source.cohort,
    capabilityContractVersion: contract.capabilityContractVersion,
    startupProfileContractVersion: contract.startupProfileContractVersion,
    encodedProfile: profile.encodedProfile,
    startupProfileSha256: profile.startupProfileSha256,
    credentialProxyReplayRequired: profile.credentialProxyReplayRequired,
    ...(profile.corporateCaB64 === undefined ? {} : { corporateCaB64: profile.corporateCaB64 }),
    shared: true,
  };
  const validatedReceipt = cloneSandboxWorkloadReceipt(receipt, {
    harnessPackage: handoff.harnessPackage ?? null,
  });
  if (validatedReceipt?.kind !== "managed-image" || !isDeepStrictEqual(validatedReceipt, receipt)) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile and image contract do not form valid durable authority",
    );
  }
  if (!provider.workload.acceptsReceipt(validatedReceipt)) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' rejected the replacement workload receipt`,
    );
  }
  return cloneAndDeepFreeze(validatedReceipt);
}
