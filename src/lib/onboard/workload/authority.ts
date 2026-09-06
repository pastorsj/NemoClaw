// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { cloneAndDeepFreeze } from "../../core/immutable";
import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import { resolvePackageBackedSandboxAgent } from "../package/package-authority";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  bindPackageDeclaredManagedImageContract,
  hasPackageManagedImagePublication,
  isManagedImageAgent,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  type PackageManagedImageContract,
  parseManagedImageContractV1,
  parsePackageManagedImageContract,
  parseStockManagedImageContract,
  qualifiedManagedImageDeclaration,
} from "../managed-image/contract";
import { validateManagedStartupCorporateCaTransport } from "../managed-startup/application";
import {
  decodeManagedStartupDurableProfile,
  isManagedStartupPackageProfile,
  type ManagedStartupDurableProfile,
} from "../managed-startup/profile";

export type ManagedWorkloadReceipt = Extract<
  SandboxWorkloadReceipt,
  { readonly kind: "managed-image" }
>;

export interface ManagedWorkloadAuthority {
  readonly agent: ManagedImageAgent;
  readonly harnessPackage: null;
  readonly receipt: ManagedWorkloadReceipt;
  readonly contract: ManagedImageContractV1;
  readonly managedImage: NonNullable<AgentDefinition["managedImage"]>;
  readonly profile: Exclude<ManagedStartupDurableProfile, { readonly profileKind: "package" }>;
  readonly corporateCa: ResolvedCorporateCa | null;
}

export interface PackageManagedWorkloadAuthority {
  readonly agent: string;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly receipt: ManagedWorkloadReceipt;
  readonly contract: PackageManagedImageContract;
  readonly managedImage: NonNullable<AgentDefinition["managedImage"]>;
  readonly profile: Extract<ManagedStartupDurableProfile, { readonly profileKind: "package" }>;
  readonly corporateCa: ResolvedCorporateCa | null;
}

export type DurableManagedWorkloadAuthority =
  | ManagedWorkloadAuthority
  | PackageManagedWorkloadAuthority;

export class ManagedWorkloadAuthorityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid managed workload authority: ${message}`, options);
    this.name = "ManagedWorkloadAuthorityError";
  }
}

function isManagedImageReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/u.test(
      value,
    )
  );
}

function exactAgent(
  value: string | null | undefined,
  harnessPackage: HarnessPackageIdentity | null,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ManagedWorkloadAuthorityError(
      "the durable managed workload does not record an explicit agent",
    );
  }
  if (harnessPackage?.id === normalized || isManagedImageAgent(normalized)) return normalized;
  throw new ManagedWorkloadAuthorityError(`'${normalized}' is not a managed-image agent`);
}

function contractFromReceipt(
  receipt: ManagedWorkloadReceipt,
  agent: string,
  harnessPackage: HarnessPackageIdentity | null,
  definition?: Pick<AgentDefinition, "managedImage" | "name">,
): ManagedImageContractV1 | PackageManagedImageContract {
  if (definition && (definition.name !== agent || definition.managedImage === null)) {
    throw new ManagedWorkloadAuthorityError(
      "the receipt-pinned package does not declare this managed workload",
    );
  }
  const declaration = definition?.managedImage;
  if (harnessPackage !== null && declaration == null) {
    throw new ManagedWorkloadAuthorityError(
      "the receipt-pinned package does not declare this managed workload",
    );
  }
  const image =
    declaration?.repository ??
    qualifiedManagedImageDeclaration(agent as ManagedImageAgent).repository;
  const referencePrefix = `${image}@`;
  if (!receipt.reference.startsWith(referencePrefix)) {
    throw new ManagedWorkloadAuthorityError(
      `the recorded image reference does not belong to '${agent}'`,
    );
  }
  if (receipt.platform === undefined) {
    throw new ManagedWorkloadAuthorityError(
      "the durable managed workload does not record an explicit OCI platform",
    );
  }
  const digest = receipt.reference.slice(referencePrefix.length);
  try {
    if (harnessPackage !== null && hasPackageManagedImagePublication(declaration!)) {
      const contract = bindPackageDeclaredManagedImageContract(
        harnessPackage,
        declaration!,
        receipt.platform,
      );
      if (
        contract.reference !== receipt.reference ||
        contract.source.revision !== receipt.sourceRevision ||
        contract.source.release !== receipt.release ||
        contract.source.cohort !== receipt.sourceCohort ||
        contract.startupProfileContractVersion !== receipt.startupProfileContractVersion ||
        contract.capabilityContractVersion !== receipt.capabilityContractVersion
      ) {
        throw new Error("package publication does not match the durable workload receipt");
      }
      return contract;
    }
    const candidate = {
      contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
      agent,
      platform: receipt.platform,
      image,
      digest,
      reference: receipt.reference,
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: receipt.sourceRevision,
        release: receipt.release,
        cohort: receipt.sourceCohort,
      },
      startupProfileContractVersion: receipt.startupProfileContractVersion,
      capabilityContractVersion: receipt.capabilityContractVersion,
      ...(harnessPackage === null ? {} : { harnessPackage }),
    };
    if (harnessPackage !== null) {
      return parsePackageManagedImageContract(candidate, harnessPackage, declaration!);
    }
    return declaration
      ? parseStockManagedImageContract(candidate, agent as ManagedImageAgent, declaration)
      : parseManagedImageContractV1(candidate, agent as ManagedImageAgent);
  } catch (error) {
    throw new ManagedWorkloadAuthorityError("the durable image contract failed validation", {
      cause: error,
    });
  }
}

function corporateCaFromReceipt(
  receipt: ManagedWorkloadReceipt,
  profile: ManagedStartupDurableProfile,
): ResolvedCorporateCa | null {
  let bytes: Buffer | null;
  try {
    bytes = validateManagedStartupCorporateCaTransport(receipt.corporateCaB64, profile);
  } catch (error) {
    throw new ManagedWorkloadAuthorityError(
      "the corporate CA transport does not match the recorded startup profile",
      { cause: error },
    );
  }
  return bytes === null
    ? null
    : {
        pem: bytes.toString("utf8"),
        sourcePath: "managed-workload-authority",
        sourceEnv: "managed-workload-authority",
      };
}

export const managedWorkloadAuthorityDependencies = {
  resolvePackageBackedSandboxAgent,
};

/**
 * Read a durable managed workload without consulting a mutable release
 * pointer. The returned receipt is cloned and the contract, profile, and CA
 * transport are revalidated as one authority unit.
 *
 * A normal custom/legacy workload returns null. A row that looks managed but
 * cannot prove its exact immutable authority fails closed.
 */
function readDurableAuthority(
  entry: Pick<
    SandboxEntry,
    | "agent"
    | "fromDockerfile"
    | "harnessPackage"
    | "harnessPackageMigration"
    | "imageTag"
    | "workload"
  >,
  definition?: Pick<AgentDefinition, "managedImage" | "name">,
): DurableManagedWorkloadAuthority | null {
  const managedLooking =
    isManagedImageReference(entry.imageTag) || entry.workload?.kind === "managed-image";
  if (!managedLooking) return null;

  const cloned = cloneSandboxWorkloadReceipt(entry.workload);
  if (cloned?.kind !== "managed-image") {
    throw new ManagedWorkloadAuthorityError(
      "the managed image has no valid durable workload receipt",
    );
  }
  if (entry.imageTag !== cloned.reference) {
    throw new ManagedWorkloadAuthorityError(
      "the registry image reference does not match the durable workload receipt",
    );
  }
  if (entry.fromDockerfile) {
    throw new ManagedWorkloadAuthorityError(
      "a managed image receipt cannot be combined with a custom Dockerfile",
    );
  }

  let harnessPackage: HarnessPackageIdentity | null = null;
  let authoritativeDefinition = definition;
  if (entry.harnessPackage !== undefined || entry.harnessPackageMigration !== undefined) {
    let resolved;
    try {
      resolved = managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent(entry);
    } catch (error) {
      throw new ManagedWorkloadAuthorityError(
        "the recorded harness package authority could not be resolved",
        { cause: error },
      );
    }
    if (resolved.harnessPackage === null) {
      throw new ManagedWorkloadAuthorityError(
        "the recorded harness package authority did not resolve an exact package receipt",
      );
    }
    if (
      definition !== undefined &&
      (definition.name !== resolved.definition.name ||
        !isDeepStrictEqual(definition.managedImage, resolved.definition.managedImage))
    ) {
      throw new ManagedWorkloadAuthorityError(
        "the supplied package definition drifted from the recorded harness package authority",
      );
    }
    harnessPackage = resolved.harnessPackage;
    authoritativeDefinition = resolved.definition;
  }

  const agent = exactAgent(entry.agent, harnessPackage);
  const contract = contractFromReceipt(cloned, agent, harnessPackage, authoritativeDefinition);
  let profile: ManagedStartupDurableProfile;
  try {
    profile = decodeManagedStartupDurableProfile(cloned.encodedProfile);
  } catch (error) {
    throw new ManagedWorkloadAuthorityError("the recorded startup profile is invalid", {
      cause: error,
    });
  }
  if (profile.agent !== agent) {
    throw new ManagedWorkloadAuthorityError(
      `the recorded startup profile belongs to '${profile.agent}', not '${agent}'`,
    );
  }
  if (
    (harnessPackage === null && isManagedStartupPackageProfile(profile)) ||
    (harnessPackage !== null &&
      (!isManagedStartupPackageProfile(profile) ||
        !isDeepStrictEqual(profile.harnessPackage, harnessPackage)))
  ) {
    throw new ManagedWorkloadAuthorityError(
      "the recorded startup profile does not match the harness package authority",
    );
  }

  const managedImage = authoritativeDefinition?.managedImage;
  if (managedImage === null || managedImage === undefined) {
    if (!isManagedImageAgent(agent)) {
      throw new ManagedWorkloadAuthorityError(
        "the receipt-backed package does not declare this managed workload",
      );
    }
  }
  const result = cloneAndDeepFreeze({
    agent,
    harnessPackage,
    receipt: cloned,
    contract,
    profile,
    managedImage: managedImage ?? qualifiedManagedImageDeclaration(agent as ManagedImageAgent),
    corporateCa: corporateCaFromReceipt(cloned, profile),
  });
  return result as DurableManagedWorkloadAuthority;
}

/** Read both legacy and receipt-backed package workload authority. */
export function readDurableManagedWorkloadAuthority(
  entry: Pick<
    SandboxEntry,
    | "agent"
    | "fromDockerfile"
    | "harnessPackage"
    | "harnessPackageMigration"
    | "imageTag"
    | "workload"
  >,
  definition?: Pick<AgentDefinition, "managedImage" | "name">,
): DurableManagedWorkloadAuthority | null {
  return readDurableAuthority(entry, definition);
}

/**
 * Legacy compatibility reader. Package-aware lifecycle code must use
 * readDurableManagedWorkloadAuthority so an opaque package profile cannot be
 * mistaken for the closed legacy profile shape.
 */
export function readManagedWorkloadAuthority(
  entry: Pick<
    SandboxEntry,
    | "agent"
    | "fromDockerfile"
    | "harnessPackage"
    | "harnessPackageMigration"
    | "imageTag"
    | "workload"
  >,
  definition?: Pick<AgentDefinition, "managedImage" | "name">,
): ManagedWorkloadAuthority | null {
  const authority = readDurableAuthority(entry, definition);
  if (authority && authority.harnessPackage !== null) {
    throw new ManagedWorkloadAuthorityError(
      "receipt-backed package authority requires a package-aware workload reader",
    );
  }
  return authority;
}
