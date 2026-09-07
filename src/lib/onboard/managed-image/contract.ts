// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessManagedImageDeclaration,
  HarnessManagedImagePublicationDeclaration,
} from "@nvidia/nemoclaw-harness-contract";
import { parseHarnessPackageIdentity } from "../../agent-runtime/package/identity-validation";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { MANAGED_IMAGE_REPOSITORIES } from "./qualified-images";

export { MANAGED_IMAGE_REPOSITORIES } from "./qualified-images";

export const MANAGED_IMAGE_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_SOURCE_REPOSITORY = "NVIDIA/NemoClaw" as const;

export type ManagedImagePlatform = (typeof MANAGED_IMAGE_PLATFORMS)[number];

export const SHIPPED_MANAGED_IMAGE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export const CANDIDATE_MANAGED_IMAGE_AGENTS = ["pi"] as const;

export const MANAGED_IMAGE_AGENTS = [
  ...SHIPPED_MANAGED_IMAGE_AGENTS,
  ...CANDIDATE_MANAGED_IMAGE_AGENTS,
] as const;

export type ShippedManagedImageAgent = (typeof SHIPPED_MANAGED_IMAGE_AGENTS)[number];
export type CandidateManagedImageAgent = (typeof CANDIDATE_MANAGED_IMAGE_AGENTS)[number];
export type ManagedImageAgent = (typeof MANAGED_IMAGE_AGENTS)[number];

export interface ManagedImageRuntimeIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly workdir: "/sandbox";
}

/**
 * Shipped images bake in these numeric sandbox identities. Candidate
 * qualification verifies the declared identity before activation. Runtime
 * providers consume this workload contract without adding agent switches to
 * central orchestration.
 */
export const MANAGED_IMAGE_RUNTIME_IDENTITIES = Object.freeze({
  openclaw: Object.freeze({ uid: 998, gid: 998, workdir: "/sandbox" }),
  hermes: Object.freeze({ uid: 998, gid: 999, workdir: "/sandbox" }),
  "langchain-deepagents-code": Object.freeze({ uid: 999, gid: 999, workdir: "/sandbox" }),
  pi: Object.freeze({ uid: 999, gid: 999, workdir: "/sandbox" }),
} as const satisfies Record<ManagedImageAgent, ManagedImageRuntimeIdentity>);

export function managedImageRuntimeIdentity(agent: ManagedImageAgent): ManagedImageRuntimeIdentity {
  return MANAGED_IMAGE_RUNTIME_IDENTITIES[agent];
}

const MANAGED_IMAGE_WORKSPACES = {
  openclaw: { owner: "runtime", mode: "0755" },
  hermes: { owner: "runtime", mode: "0755" },
  "langchain-deepagents-code": { owner: "root", mode: "1775" },
  pi: { owner: "runtime", mode: "0755" },
} as const satisfies Record<
  ManagedImageAgent,
  NonNullable<HarnessManagedImageDeclaration["workspace"]>
>;

const MANAGED_IMAGE_STATE_ROOTS = {
  openclaw: { mount_target: "/sandbox/.openclaw", mode: "2770" },
  hermes: { mount_target: "/sandbox/.hermes", mode: "3770" },
  "langchain-deepagents-code": null,
  pi: null,
} as const satisfies Record<ManagedImageAgent, HarnessManagedImageDeclaration["state_root"] | null>;

/** Product-qualified compatibility declaration used by publication tooling and legacy callers. */
export function qualifiedManagedImageDeclaration(
  agent: ManagedImageAgent,
): HarnessManagedImageDeclaration {
  const stateRoot = MANAGED_IMAGE_STATE_ROOTS[agent];
  return Object.freeze({
    repository: MANAGED_IMAGE_REPOSITORIES[agent],
    architectures: MANAGED_IMAGE_PLATFORMS,
    runtime_identity: MANAGED_IMAGE_RUNTIME_IDENTITIES[agent],
    workspace: MANAGED_IMAGE_WORKSPACES[agent],
    ...(stateRoot ? { state_root: stateRoot } : {}),
  });
}

export type PublicManagedImageRepository = (typeof MANAGED_IMAGE_REPOSITORIES)[ManagedImageAgent];
export type ManagedImageDigest = `sha256:${string}`;
export type ManagedImageReference = `${PublicManagedImageRepository}@${ManagedImageDigest}`;
export type ManagedImagePublicationCohort = `ghrun-${number}-${number}`;

export interface ManagedImageSourceIdentity {
  readonly repository: typeof MANAGED_IMAGE_SOURCE_REPOSITORY;
  readonly revision: string;
  readonly release: string;
  readonly cohort: ManagedImagePublicationCohort;
}

/**
 * Source identity carried by an operator-selected package publication. The
 * installed package receipt is the trust boundary; this identity records
 * provenance but does not claim that NemoClaw authenticated the publisher.
 */
export interface PackageManagedImageSourceIdentity {
  readonly repository: string;
  readonly revision: string;
  readonly release: string;
  readonly cohort: string;
}

/**
 * Immutable identity consumed by stock buildless onboarding for shipped
 * agents and by protected qualification for candidates.
 *
 * The validated cohort binds all shipped agent images to one publication.
 * Other publication evidence (mutable aliases and base-image provenance) stays
 * outside this runtime identity.
 */
interface ManagedImageContractFields<
  TAgent extends string,
  TSource extends PackageManagedImageSourceIdentity,
> {
  readonly contractVersion: typeof MANAGED_IMAGE_CONTRACT_VERSION;
  readonly agent: TAgent;
  readonly platform: ManagedImagePlatform;
  readonly image: string;
  readonly digest: ManagedImageDigest;
  readonly reference: `${string}@${ManagedImageDigest}`;
  readonly source: TSource;
  readonly startupProfileContractVersion: typeof MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION;
  readonly capabilityContractVersion: typeof MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION;
}

/**
 * Package-qualified image evidence binds the image to the exact package
 * receipt that declared it. A different installed version or package tree
 * cannot reuse qualification issued for another receipt.
 */
export interface PackageManagedImageContract<
  TAgent extends string = string,
> extends ManagedImageContractFields<TAgent, PackageManagedImageSourceIdentity> {
  readonly harnessPackage: HarnessPackageIdentity;
}

/** Legacy product-qualified image evidence for NemoClaw's closed stock set. */
export type ManagedImageContractV1 = ManagedImageContractFields<
  ManagedImageAgent,
  ManagedImageSourceIdentity
>;

export type ManagedImageContractCatalog = Readonly<Record<string, unknown>>;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_PATTERN = /^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const COHORT_PATTERN = /^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;
const PACKAGE_SOURCE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const PACKAGE_SOURCE_COHORT_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,127})$/u;
const MAX_PACKAGE_SOURCE_REPOSITORY_BYTES = 201;
const MAX_PACKAGE_SOURCE_RELEASE_BYTES = 128;
const OCI_REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const MAX_OCI_REPOSITORY_BYTES = 512;

export class ManagedImageContractError extends Error {
  constructor(message: string) {
    super(`Invalid managed image contract: ${message}`);
    this.name = "ManagedImageContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ManagedImageContractError(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ManagedImageContractError(`${field} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new ManagedImageContractError(`${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ManagedImageContractError(`${field} has an unsupported format`);
  }
  return value;
}

function requireBoundedPattern(
  value: unknown,
  pattern: RegExp,
  maxBytes: number,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    !pattern.test(value)
  ) {
    throw new ManagedImageContractError(`${field} has an unsupported format`);
  }
  return value;
}

const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const MANAGED_IMAGE_CONTRACT_KEYS = [
  "agent",
  "capabilityContractVersion",
  "contractVersion",
  "digest",
  "image",
  "platform",
  "reference",
  "source",
  "startupProfileContractVersion",
] as const;

const PACKAGE_MANAGED_IMAGE_CONTRACT_KEYS = [
  ...MANAGED_IMAGE_CONTRACT_KEYS,
  "harnessPackage",
] as const;

function requireHarnessPackageIdentity(value: unknown, field: string): HarnessPackageIdentity {
  try {
    return parseHarnessPackageIdentity(value);
  } catch {
    throw new ManagedImageContractError(`${field} must be an exact harness package receipt`);
  }
}

function harnessPackageIdentitiesEqual(
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

function parseDeclaredManagedImageContract<TAgent extends string>(
  contract: Record<string, unknown>,
  expectedAgent: TAgent,
  declaration: HarnessManagedImageDeclaration,
  expectedKeys: readonly string[],
  expectedPlatform?: ManagedImagePlatform,
): ManagedImageContractFields<TAgent, ManagedImageSourceIdentity> {
  requireExactKeys(contract, expectedKeys, "contract");

  requireLiteral(
    contract.contractVersion,
    MANAGED_IMAGE_CONTRACT_VERSION,
    "contract.contractVersion",
  );
  if (!AGENT_ID_PATTERN.test(expectedAgent)) {
    throw new ManagedImageContractError("expected agent is not a canonical package identifier");
  }
  const agent = requireLiteral(contract.agent, expectedAgent, "contract.agent");
  if (!isManagedImagePlatform(contract.platform)) {
    throw new ManagedImageContractError(
      `contract.platform must be one of: ${MANAGED_IMAGE_PLATFORMS.join(", ")}`,
    );
  }
  const platform = contract.platform;
  if (!declaration.architectures.includes(platform)) {
    throw new ManagedImageContractError(
      `contract.platform is not declared by package '${expectedAgent}'`,
    );
  }
  if (expectedPlatform !== undefined && platform !== expectedPlatform) {
    throw new ManagedImageContractError(
      `contract.platform must be ${JSON.stringify(expectedPlatform)}`,
    );
  }
  const image = requireLiteral(contract.image, declaration.repository, "contract.image");
  const digest = requirePattern(contract.digest, DIGEST_PATTERN, "contract.digest");
  const reference = requireLiteral(contract.reference, `${image}@${digest}`, "contract.reference");

  const source = requireRecord(contract.source, "contract.source");
  requireExactKeys(source, ["cohort", "release", "repository", "revision"], "contract.source");
  const sourceRepository = requireLiteral(
    source.repository,
    MANAGED_IMAGE_SOURCE_REPOSITORY,
    "contract.source.repository",
  );
  const sourceRevision = requirePattern(
    source.revision,
    REVISION_PATTERN,
    "contract.source.revision",
  );
  const sourceRelease = requirePattern(source.release, RELEASE_PATTERN, "contract.source.release");
  const sourceCohort = requirePattern(source.cohort, COHORT_PATTERN, "contract.source.cohort");
  const startupProfileContractVersion = requireLiteral(
    contract.startupProfileContractVersion,
    MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    "contract.startupProfileContractVersion",
  );
  const capabilityContractVersion = requireLiteral(
    contract.capabilityContractVersion,
    MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    "contract.capabilityContractVersion",
  );

  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest: digest as ManagedImageDigest,
    reference: reference as `${string}@${ManagedImageDigest}`,
    source: {
      repository: sourceRepository,
      revision: sourceRevision,
      release: sourceRelease,
      cohort: sourceCohort as ManagedImagePublicationCohort,
    },
    startupProfileContractVersion,
    capabilityContractVersion,
  };
}

export function hasPackageManagedImagePublication(
  declaration: HarnessManagedImageDeclaration,
): declaration is HarnessManagedImageDeclaration & {
  readonly publication: HarnessManagedImagePublicationDeclaration;
} {
  return declaration.publication !== undefined;
}

/**
 * Bind package-declared immutable image publication data to the exact selected
 * package receipt. This path intentionally does not consult NemoClaw's stock
 * image catalogue and does not grant publisher authenticity.
 */
export function bindPackageDeclaredManagedImageContract<TAgent extends string>(
  expectedHarnessPackage: HarnessPackageIdentity & { readonly id: TAgent },
  declaration: HarnessManagedImageDeclaration,
  expectedPlatform: ManagedImagePlatform,
): PackageManagedImageContract<TAgent> {
  const harnessPackage = requireHarnessPackageIdentity(
    expectedHarnessPackage,
    "expected harness package",
  );
  const publication: HarnessManagedImagePublicationDeclaration | undefined =
    declaration.publication;
  if (!publication) {
    throw new ManagedImageContractError(
      "package managed image declaration has no immutable publication",
    );
  }
  if (!isRecord(publication)) {
    throw new ManagedImageContractError("managed_image.publication must be an object");
  }
  requireBoundedPattern(
    declaration.repository,
    OCI_REPOSITORY_PATTERN,
    MAX_OCI_REPOSITORY_BYTES,
    "managed_image.repository",
  );
  if (
    !Array.isArray(declaration.architectures) ||
    declaration.architectures.length === 0 ||
    declaration.architectures.length > MANAGED_IMAGE_PLATFORMS.length ||
    new Set(declaration.architectures).size !== declaration.architectures.length ||
    declaration.architectures.some((platform) => !isManagedImagePlatform(platform))
  ) {
    throw new ManagedImageContractError(
      "managed_image.architectures must contain unique supported platforms",
    );
  }
  requireExactKeys(publication, ["digests", "source"], "managed_image.publication");
  const source = requireRecord(publication.source, "managed_image.publication.source");
  requireExactKeys(
    source,
    ["cohort", "release", "repository", "revision"],
    "managed_image.publication.source",
  );
  const digests = requireRecord(publication.digests, "managed_image.publication.digests");
  const declaredPlatforms = [...declaration.architectures].sort();
  requireExactKeys(digests, declaredPlatforms, "managed_image.publication.digests");
  if (!declaration.architectures.includes(expectedPlatform)) {
    throw new ManagedImageContractError(
      `managed_image publication does not support ${JSON.stringify(expectedPlatform)}`,
    );
  }

  const digest = requirePattern(
    digests[expectedPlatform],
    DIGEST_PATTERN,
    `managed_image.publication.digests.${expectedPlatform}`,
  ) as ManagedImageDigest;
  const sourceRepository = requireBoundedPattern(
    source.repository,
    PACKAGE_SOURCE_REPOSITORY_PATTERN,
    MAX_PACKAGE_SOURCE_REPOSITORY_BYTES,
    "managed_image.publication.source.repository",
  );
  const sourceRevision = requirePattern(
    source.revision,
    REVISION_PATTERN,
    "managed_image.publication.source.revision",
  );
  const sourceRelease = requireBoundedPattern(
    source.release,
    RELEASE_PATTERN,
    MAX_PACKAGE_SOURCE_RELEASE_BYTES,
    "managed_image.publication.source.release",
  );
  const sourceCohort = requirePattern(
    source.cohort,
    PACKAGE_SOURCE_COHORT_PATTERN,
    "managed_image.publication.source.cohort",
  );

  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent: harnessPackage.id as TAgent,
    platform: expectedPlatform,
    image: declaration.repository,
    digest,
    reference: `${declaration.repository}@${digest}`,
    source: {
      repository: sourceRepository,
      revision: sourceRevision,
      release: sourceRelease,
      cohort: sourceCohort,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    harnessPackage,
  };
}

function parsePackageDeclaredManagedImageContract<TAgent extends string>(
  value: Record<string, unknown>,
  expectedHarnessPackage: HarnessPackageIdentity & { readonly id: TAgent },
  declaration: HarnessManagedImageDeclaration,
  expectedPlatform?: ManagedImagePlatform,
): PackageManagedImageContract<TAgent> {
  requireExactKeys(value, PACKAGE_MANAGED_IMAGE_CONTRACT_KEYS, "contract");
  const harnessPackage = requireHarnessPackageIdentity(
    value.harnessPackage,
    "contract.harnessPackage",
  );
  const expectedPackage = requireHarnessPackageIdentity(
    expectedHarnessPackage,
    "expected harness package",
  );
  if (!harnessPackageIdentitiesEqual(harnessPackage, expectedPackage)) {
    throw new ManagedImageContractError(
      "contract.harnessPackage must match the exact expected harness package receipt",
    );
  }
  if (!isManagedImagePlatform(value.platform)) {
    throw new ManagedImageContractError(
      `contract.platform must be one of: ${MANAGED_IMAGE_PLATFORMS.join(", ")}`,
    );
  }
  if (expectedPlatform !== undefined && value.platform !== expectedPlatform) {
    throw new ManagedImageContractError(
      `contract.platform must be ${JSON.stringify(expectedPlatform)}`,
    );
  }
  const expected = bindPackageDeclaredManagedImageContract(
    expectedHarnessPackage,
    declaration,
    value.platform,
  );
  requireLiteral(value.contractVersion, expected.contractVersion, "contract.contractVersion");
  requireLiteral(value.agent, expected.agent, "contract.agent");
  requireLiteral(value.image, expected.image, "contract.image");
  requireLiteral(value.digest, expected.digest, "contract.digest");
  requireLiteral(value.reference, expected.reference, "contract.reference");
  requireLiteral(
    value.startupProfileContractVersion,
    expected.startupProfileContractVersion,
    "contract.startupProfileContractVersion",
  );
  requireLiteral(
    value.capabilityContractVersion,
    expected.capabilityContractVersion,
    "contract.capabilityContractVersion",
  );
  const source = requireRecord(value.source, "contract.source");
  requireExactKeys(source, ["cohort", "release", "repository", "revision"], "contract.source");
  requireLiteral(source.repository, expected.source.repository, "contract.source.repository");
  requireLiteral(source.revision, expected.source.revision, "contract.source.revision");
  requireLiteral(source.release, expected.source.release, "contract.source.release");
  requireLiteral(source.cohort, expected.source.cohort, "contract.source.cohort");
  return expected;
}

/**
 * Validate one qualified immutable image against the selected package's
 * receipt-pinned declaration. The declaration constrains composition but is
 * not qualification evidence; callers must establish catalogue authority
 * before invoking this parser.
 */
export function parsePackageManagedImageContract<TAgent extends string>(
  value: unknown,
  expectedHarnessPackage: HarnessPackageIdentity & { readonly id: TAgent },
  declaration: HarnessManagedImageDeclaration,
  expectedPlatform?: ManagedImagePlatform,
): PackageManagedImageContract<TAgent> {
  const contract = requireRecord(value, "contract");
  if (hasPackageManagedImagePublication(declaration)) {
    return parsePackageDeclaredManagedImageContract(
      contract,
      expectedHarnessPackage,
      declaration,
      expectedPlatform,
    );
  }
  const expectedPackage = requireHarnessPackageIdentity(
    expectedHarnessPackage,
    "expected harness package",
  );
  const harnessPackage = requireHarnessPackageIdentity(
    contract.harnessPackage,
    "contract.harnessPackage",
  );
  if (!harnessPackageIdentitiesEqual(harnessPackage, expectedPackage)) {
    throw new ManagedImageContractError(
      "contract.harnessPackage must match the exact expected harness package receipt",
    );
  }
  const parsed = parseDeclaredManagedImageContract(
    contract,
    expectedPackage.id as TAgent,
    declaration,
    PACKAGE_MANAGED_IMAGE_CONTRACT_KEYS,
    expectedPlatform,
  );

  return {
    ...parsed,
    harnessPackage,
  };
}

/**
 * Bind trusted image-publication evidence to the exact package receipt that
 * selected it. Public catalogues are reusable and therefore cannot contain an
 * install-specific content digest; an already-bound package contract is also
 * accepted and must agree exactly.
 */
export function bindPackageManagedImageContract<TAgent extends string>(
  value: unknown,
  expectedHarnessPackage: HarnessPackageIdentity & { readonly id: TAgent },
  declaration: HarnessManagedImageDeclaration,
  expectedPlatform?: ManagedImagePlatform,
): PackageManagedImageContract<TAgent> {
  const contract = requireRecord(value, "contract");
  if (Object.hasOwn(contract, "harnessPackage")) {
    return parsePackageManagedImageContract(
      contract,
      expectedHarnessPackage,
      declaration,
      expectedPlatform,
    );
  }
  const harnessPackage = requireHarnessPackageIdentity(
    expectedHarnessPackage,
    "expected harness package",
  );
  const parsed = parseDeclaredManagedImageContract(
    contract,
    harnessPackage.id as TAgent,
    declaration,
    MANAGED_IMAGE_CONTRACT_KEYS,
    expectedPlatform,
  );
  return { ...parsed, harnessPackage };
}

/**
 * Validate legacy product-qualified evidence for NemoClaw's closed stock set.
 * Package integrations must use parsePackageManagedImageContract instead.
 */
export function parseStockManagedImageContract(
  value: unknown,
  expectedAgent: ManagedImageAgent,
  declaration: HarnessManagedImageDeclaration,
  expectedPlatform?: ManagedImagePlatform,
): ManagedImageContractV1 {
  return parseDeclaredManagedImageContract(
    requireRecord(value, "contract"),
    expectedAgent,
    declaration,
    MANAGED_IMAGE_CONTRACT_KEYS,
    expectedPlatform,
  );
}

export function isShippedManagedImageAgent(value: string): value is ShippedManagedImageAgent {
  return (SHIPPED_MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isCandidateManagedImageAgent(value: string): value is CandidateManagedImageAgent {
  return (CANDIDATE_MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isManagedImageAgent(value: string): value is ManagedImageAgent {
  return (MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isManagedImagePlatform(value: unknown): value is ManagedImagePlatform {
  return (
    typeof value === "string" && (MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(value)
  );
}

export function managedImagePlatformForNodeArchitecture(
  nodeArchitecture: string,
): ManagedImagePlatform | null {
  if (nodeArchitecture === "x64" || nodeArchitecture === "amd64") return "linux/amd64";
  if (nodeArchitecture === "arm64") return "linux/arm64";
  return null;
}

export function parseManagedImageContractV1(
  value: unknown,
  expectedAgent?: ManagedImageAgent,
  expectedPlatform?: ManagedImagePlatform,
): ManagedImageContractV1 {
  const contract = requireRecord(value, "contract");
  if (typeof contract.agent !== "string" || !isManagedImageAgent(contract.agent)) {
    throw new ManagedImageContractError("contract.agent is not a managed image agent");
  }
  const agent = contract.agent;
  if (expectedAgent !== undefined && agent !== expectedAgent) {
    throw new ManagedImageContractError(`contract.agent must be ${JSON.stringify(expectedAgent)}`);
  }

  return parseStockManagedImageContract(
    contract,
    agent,
    qualifiedManagedImageDeclaration(agent),
    expectedPlatform,
  );
}
