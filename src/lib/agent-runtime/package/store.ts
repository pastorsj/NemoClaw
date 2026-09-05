// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { getNemoclawBaseStateRoot, resolveHome } from "../../state/state-root";
import { acquireProcessBoundLockAt, releaseProcessBoundLock } from "../../state/registry/lock";
import {
  HarnessPackageStageCleanupError,
  copyVerifiedPackageTree,
  type CopiedHarnessPackageTree,
} from "./copy";
import { parseHarnessPackageManifest, type ParsedHarnessPackageManifest } from "./manifest";
import {
  HARNESS_PACKAGE_POINTER_MAX_BYTES,
  HARNESS_PACKAGE_RECEIPT_MAX_BYTES,
  assertHarnessPackageReceiptMatchesPointer,
  parseHarnessPackageSourceIdentity,
  parseHarnessPackageActivePointer,
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
  parseHarnessPackageIdentity,
  parseHarnessPackageReceipt,
  serializeHarnessPackageActivePointer,
  serializeHarnessPackageReceipt,
  type HarnessPackageSourceIdentity,
  type HarnessPackageActivePointer,
  type HarnessPackageReceipt,
} from "./receipt";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
  type ValidatedHarnessPackageTree,
} from "./tree";
import type { HarnessPackageIdentity } from "./types";
import {
  assertCanonicalStoreFileUnchanged,
  assertHarnessPackageStoreAuthority,
  assertHarnessPackageStoreFileAuthority,
  captureHarnessPackageStore,
  ensureHarnessPackageStore,
  harnessPackageStorePaths,
  listHarnessPackageStoreDirectory,
  publishAbsentStagedStoreFile,
  publishStagedPackageDirectory,
  publishStagedStoreFile,
  removeCanonicalStoreFile,
  readCanonicalStoreFile,
  readCanonicalStoreFileRecord,
  removeStagedStoreFile,
  storePathIsMissing,
  syncHarnessPackageTree,
  writeStagedStoreFile,
  type HarnessPackageStoreAuthority,
  type HarnessPackageStorePaths,
  type StagedStoreFile,
  type VerifiedStoreFile,
} from "./store-files";

const HARNESS_PACKAGE_STORE_DIRECTORY = "harnesses";
const OBJECT_NAME_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_NAME_PATTERN = /^([0-9a-f]{64})\.json$/u;
const ACTIVE_NAME_PATTERN = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.json$/u;

export type HarnessPackagePublicationCheckpoint =
  | "before-object-publication"
  | "before-receipt-publication"
  | "before-active-pointer-replacement";

export interface HarnessPackageStoreDependencies {
  readonly onPublicationCheckpoint?: (checkpoint: HarnessPackagePublicationCheckpoint) => void;
}

export type HarnessPackagePointerMutationCheckpoint = "before-active-pointer-replacement";

export interface HarnessPackagePointerMutationDependencies {
  readonly onPointerMutationCheckpoint?: (
    checkpoint: HarnessPackagePointerMutationCheckpoint,
  ) => void;
}

export interface HarnessPackageStoreOptions {
  readonly storeRoot?: string;
}

export interface HarnessPackagePointerMutationOptions extends HarnessPackageStoreOptions {
  /** Optional compare-and-swap guard supplied by an earlier user confirmation. */
  readonly expectedIdentity?: HarnessPackageIdentity;
  readonly dependencies?: HarnessPackagePointerMutationDependencies;
}

export interface DeactivatedHarnessPackage {
  readonly state: "deactivated";
  readonly identity: HarnessPackageIdentity;
}

export interface PublishHarnessPackageInput extends HarnessPackageStoreOptions {
  readonly validatedTree: ValidatedHarnessPackageTree;
  readonly expectedIdentity: HarnessPackageIdentity;
  readonly sourceIdentity: HarnessPackageSourceIdentity;
  readonly dependencies?: HarnessPackageStoreDependencies;
}

export interface InstalledHarnessPackage {
  readonly state: "installed";
  readonly identity: HarnessPackageIdentity;
  readonly receipt: HarnessPackageReceipt;
  readonly packageRoot: string;
  readonly packageManifest: ParsedHarnessPackageManifest;
}

export class HarnessPackageStoreIntegrityError extends Error {
  override readonly name = "HarnessPackageStoreIntegrityError";

  constructor(message = "Harness package store integrity validation failed") {
    super(message);
  }
}

export class HarnessPackageVersionConflictError extends Error {
  override readonly name = "HarnessPackageVersionConflictError";

  constructor() {
    super("Harness package version is already bound to different content");
  }
}

export function getHarnessPackageStoreRoot(home: string = resolveHome()): string {
  return path.join(getNemoclawBaseStateRoot(home), HARNESS_PACKAGE_STORE_DIRECTORY);
}

function selectedStoreRoot(options: HarnessPackageStoreOptions): string {
  return path.resolve(options.storeRoot ?? getHarnessPackageStoreRoot());
}

function sameIdentity(left: HarnessPackageIdentity, right: HarnessPackageIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contentDigest === right.contentDigest
  );
}

function sameVersionBinding(left: HarnessPackageIdentity, right: HarnessPackageIdentity): boolean {
  return (
    left.kind === right.kind && left.id === right.id && left.packageVersion === right.packageVersion
  );
}

function derivePackageIdentity(
  packageManifest: ParsedHarnessPackageManifest,
  contentDigest: string,
): HarnessPackageIdentity {
  return parseHarnessPackageIdentity({
    kind: packageManifest.envelope.kind,
    id: packageManifest.envelope.id,
    packageVersion: packageManifest.envelope.packageVersion,
    contentDigest,
  });
}

function requireExpectedPackage(
  packageRoot: string,
  expectedIdentity: HarnessPackageIdentity,
): {
  readonly packageManifest: ParsedHarnessPackageManifest;
  readonly tree: ValidatedHarnessPackageTree;
} {
  const packageManifest = parseHarnessPackageManifest(packageRoot);
  const tree = validateHarnessPackageTree(packageRoot, { sourceTrust: "mutable" });
  const actualIdentity = derivePackageIdentity(packageManifest, tree.contentDigest);
  if (!sameIdentity(actualIdentity, expectedIdentity)) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package object identity does not match its receipt",
    );
  }
  return { packageManifest, tree };
}

function objectPath(paths: HarnessPackageStorePaths, digest: string): string {
  return path.join(paths.objectShard, parseHarnessPackageContentDigest(digest));
}

function receiptPath(paths: HarnessPackageStorePaths, digest: string): string {
  return path.join(paths.receiptShard, `${parseHarnessPackageContentDigest(digest)}.json`);
}

function pointerPath(paths: HarnessPackageStorePaths, id: string): string {
  return path.join(paths.active, `${parseHarnessPackageId(id)}.json`);
}

function readReceipt(
  paths: HarnessPackageStorePaths,
  digest: string,
  authority: HarnessPackageStoreAuthority,
): HarnessPackageReceipt {
  return readCanonicalStoreFile({
    absolutePath: receiptPath(paths, digest),
    authority,
    maxBytes: HARNESS_PACKAGE_RECEIPT_MAX_BYTES,
    parse: parseHarnessPackageReceipt,
    serialize: serializeHarnessPackageReceipt,
  });
}

function readPointer(
  paths: HarnessPackageStorePaths,
  id: string,
  authority: HarnessPackageStoreAuthority,
): HarnessPackageActivePointer {
  return readCanonicalStoreFile({
    absolutePath: pointerPath(paths, id),
    authority,
    maxBytes: HARNESS_PACKAGE_POINTER_MAX_BYTES,
    parse: parseHarnessPackageActivePointer,
    serialize: serializeHarnessPackageActivePointer,
  });
}

function readPointerRecord(
  paths: HarnessPackageStorePaths,
  id: string,
  authority: HarnessPackageStoreAuthority,
): VerifiedStoreFile<HarnessPackageActivePointer> {
  return readCanonicalStoreFileRecord({
    absolutePath: pointerPath(paths, id),
    authority,
    maxBytes: HARNESS_PACKAGE_POINTER_MAX_BYTES,
    parse: parseHarnessPackageActivePointer,
    serialize: serializeHarnessPackageActivePointer,
  });
}

function resolvePinnedWithAuthority(
  identity: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): InstalledHarnessPackage {
  const receipt = readReceipt(paths, identity.contentDigest, authority);
  if (!sameIdentity(receipt.identity, identity)) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package receipt identity does not match the requested package",
    );
  }
  const packageRoot = objectPath(paths, identity.contentDigest);
  const { packageManifest } = requireExpectedPackage(packageRoot, identity);
  assertHarnessPackageStoreAuthority(authority);
  return Object.freeze({
    state: "installed",
    identity,
    receipt,
    packageRoot,
    packageManifest,
  });
}

function integrityFailure(error: unknown): never {
  if (
    error instanceof HarnessPackageStoreIntegrityError ||
    error instanceof HarnessPackageVersionConflictError ||
    error instanceof HarnessPackageStageCleanupError
  ) {
    throw error;
  }
  throw new HarnessPackageStoreIntegrityError();
}

function capturePinnedAuthority(paths: HarnessPackageStorePaths): HarnessPackageStoreAuthority {
  return captureHarnessPackageStore(paths, [
    paths.objects,
    paths.objectShard,
    paths.receipts,
    paths.harnessReceipts,
    paths.receiptShard,
  ]);
}

function resolveActiveWithAuthority(
  id: string,
  paths: HarnessPackageStorePaths,
  pointerAuthority: HarnessPackageStoreAuthority,
  pinnedAuthority: HarnessPackageStoreAuthority,
): {
  readonly installed: InstalledHarnessPackage;
  readonly pointer: HarnessPackageActivePointer;
  readonly pointerRecord: VerifiedStoreFile<HarnessPackageActivePointer>;
} {
  const pointerRecord = readPointerRecord(paths, id, pointerAuthority);
  const pointer = pointerRecord.value;
  if (pointer.id !== id) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package pointer id does not match its file name",
    );
  }
  const receipt = readReceipt(paths, pointer.contentDigest, pinnedAuthority);
  assertHarnessPackageReceiptMatchesPointer(receipt, pointer);
  const installed = resolvePinnedWithAuthority(receipt.identity, paths, pinnedAuthority);
  assertCanonicalStoreFileUnchanged(pointerRecord, pointerAuthority);
  const rereadPointer = readPointer(paths, id, pointerAuthority);
  if (rereadPointer.id !== pointer.id || rereadPointer.contentDigest !== pointer.contentDigest) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package active pointer changed during resolution",
    );
  }
  return {
    installed,
    pointer,
    pointerRecord,
  };
}

export function resolvePinnedHarnessPackage(
  identityValue: unknown,
  options: HarnessPackageStoreOptions = {},
): InstalledHarnessPackage {
  try {
    const identity = parseHarnessPackageIdentity(identityValue);
    const paths = harnessPackageStorePaths(selectedStoreRoot(options), identity.id);
    const authority = capturePinnedAuthority(paths);
    return resolvePinnedWithAuthority(identity, paths, authority);
  } catch (error) {
    return integrityFailure(error);
  }
}

export function readInstalledHarnessPackage(
  idValue: unknown,
  options: HarnessPackageStoreOptions = {},
): InstalledHarnessPackage | null {
  try {
    const id = parseHarnessPackageId(idValue);
    const paths = harnessPackageStorePaths(selectedStoreRoot(options), id);
    if (storePathIsMissing(paths.root) || storePathIsMissing(paths.active)) return null;
    const pointerAuthority = captureHarnessPackageStore(paths, [paths.active]);
    const activePath = pointerPath(paths, id);
    if (storePathIsMissing(activePath)) return null;
    const authority = capturePinnedAuthority(paths);
    return resolveActiveWithAuthority(id, paths, pointerAuthority, authority).installed;
  } catch (error) {
    return integrityFailure(error);
  }
}

export function listActiveHarnessPackageIds(
  options: HarnessPackageStoreOptions = {},
): readonly string[] {
  try {
    const root = selectedStoreRoot(options);
    const placeholderPaths = harnessPackageStorePaths(root, "placeholder");
    if (storePathIsMissing(root) || storePathIsMissing(placeholderPaths.active)) return [];
    const authority = captureHarnessPackageStore(placeholderPaths, [placeholderPaths.active]);
    const ids = listHarnessPackageStoreDirectory(placeholderPaths.active, authority).map(
      (entry) => {
        const match = ACTIVE_NAME_PATTERN.exec(entry);
        if (!match) {
          throw new HarnessPackageStoreIntegrityError(
            "Harness package active directory contains an unexpected entry",
          );
        }
        const id = parseHarnessPackageId(match[1]);
        assertHarnessPackageStoreFileAuthority(
          path.join(placeholderPaths.active, entry),
          authority,
        );
        return id;
      },
    );
    return Object.freeze(ids);
  } catch (error) {
    return integrityFailure(error);
  }
}

function assertRetainedReceiptBindings(
  desired: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): void {
  for (const entry of listHarnessPackageStoreDirectory(paths.receiptShard, authority)) {
    const match = RECEIPT_NAME_PATTERN.exec(entry);
    if (!match) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package receipt directory contains an unexpected entry",
      );
    }
    const digest = parseHarnessPackageContentDigest(match[1]);
    const receipt = readReceipt(paths, digest, authority);
    if (receipt.identity.id !== desired.id || receipt.identity.contentDigest !== digest) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package retained receipt address disagrees with its identity",
      );
    }
    if (
      sameVersionBinding(receipt.identity, desired) &&
      receipt.identity.contentDigest !== desired.contentDigest
    ) {
      throw new HarnessPackageVersionConflictError();
    }
  }
}

function retainedObjectIdentity(
  paths: HarnessPackageStorePaths,
  digest: string,
): HarnessPackageIdentity {
  const retainedRoot = objectPath(paths, digest);
  const packageManifest = parseHarnessPackageManifest(retainedRoot);
  const tree = validateHarnessPackageTree(retainedRoot, { sourceTrust: "mutable" });
  if (tree.contentDigest !== digest) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package retained object address disagrees with its digest",
    );
  }
  return derivePackageIdentity(packageManifest, digest);
}

function assertRetainedObjectBindings(
  desired: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): void {
  for (const entry of listHarnessPackageStoreDirectory(paths.objectShard, authority)) {
    if (!OBJECT_NAME_PATTERN.test(entry)) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package object directory contains an unexpected entry",
      );
    }
    const digest = parseHarnessPackageContentDigest(entry);
    const retained = retainedObjectIdentity(paths, digest);
    if (sameVersionBinding(retained, desired) && retained.contentDigest !== desired.contentDigest) {
      throw new HarnessPackageVersionConflictError();
    }
  }
  assertHarnessPackageStoreAuthority(authority);
}

function optionalReceipt(
  desired: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): HarnessPackageReceipt | null {
  if (storePathIsMissing(receiptPath(paths, desired.contentDigest))) return null;
  const receipt = readReceipt(paths, desired.contentDigest, authority);
  if (!sameIdentity(receipt.identity, desired)) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package retained receipt identity is inconsistent",
    );
  }
  return receipt;
}

function optionalObject(
  desired: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
): InstalledHarnessPackage["packageManifest"] | null {
  const retainedRoot = objectPath(paths, desired.contentDigest);
  if (storePathIsMissing(retainedRoot)) return null;
  return requireExpectedPackage(retainedRoot, desired).packageManifest;
}

function validateCurrentPointer(
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): ReturnType<typeof resolveActiveWithAuthority> | null {
  const activePath = pointerPath(paths, path.basename(paths.lock, ".lock"));
  if (storePathIsMissing(activePath)) return null;
  const id = path.basename(activePath, ".json");
  const pinnedAuthority = capturePinnedAuthority(paths);
  return resolveActiveWithAuthority(id, paths, authority, pinnedAuthority);
}

function publishObject(
  input: PublishHarnessPackageInput,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): CopiedHarnessPackageTree | null {
  if (!storePathIsMissing(objectPath(paths, input.expectedIdentity.contentDigest))) {
    requireExpectedPackage(
      objectPath(paths, input.expectedIdentity.contentDigest),
      input.expectedIdentity,
    );
    return null;
  }
  const copied = copyVerifiedPackageTree(input.validatedTree, { stagingParent: paths.staging });
  try {
    const staged = requireExpectedPackage(copied.packageRoot, input.expectedIdentity);
    syncHarnessPackageTree(staged.tree);
    input.dependencies?.onPublicationCheckpoint?.("before-object-publication");
    const publication = publishStagedPackageDirectory(
      copied.packageRoot,
      objectPath(paths, input.expectedIdentity.contentDigest),
      authority,
    );
    if (publication === "exists") {
      requireExpectedPackage(
        objectPath(paths, input.expectedIdentity.contentDigest),
        input.expectedIdentity,
      );
      copied.removeStagingRoot();
      return null;
    }
    requireExpectedPackage(
      objectPath(paths, input.expectedIdentity.contentDigest),
      input.expectedIdentity,
    );
    return copied;
  } catch (error) {
    copied.removeStagingRoot();
    throw error;
  }
}

function publishReceipt(
  input: PublishHarnessPackageInput,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
  existing: HarnessPackageReceipt | null,
): HarnessPackageReceipt {
  if (existing) return existing;
  const receipt = parseHarnessPackageReceipt(
    serializeHarnessPackageReceipt({
      schemaVersion: 1,
      identity: input.expectedIdentity,
      sourceIdentity: input.sourceIdentity,
      installedAt: new Date().toISOString(),
    }),
  );
  let stagedFile: StagedStoreFile | null = null;
  try {
    stagedFile = writeStagedStoreFile(
      paths.staging,
      "receipt",
      serializeHarnessPackageReceipt(receipt),
      authority,
    );
    input.dependencies?.onPublicationCheckpoint?.("before-receipt-publication");
    const publication = publishAbsentStagedStoreFile(
      stagedFile,
      receiptPath(paths, input.expectedIdentity.contentDigest),
      authority,
    );
    if (publication === "published") stagedFile = null;
    const publishedReceipt = readReceipt(paths, input.expectedIdentity.contentDigest, authority);
    if (!sameIdentity(publishedReceipt.identity, input.expectedIdentity)) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package immutable receipt publication conflicted",
      );
    }
    return publishedReceipt;
  } finally {
    if (stagedFile) removeStagedStoreFile(stagedFile, authority);
  }
}

function replacePointer(
  desiredIdentity: HarnessPackageIdentity,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
  current: ReturnType<typeof resolveActiveWithAuthority> | null,
  beforeReplacement: (() => void) | undefined,
): void {
  const desired: HarnessPackageActivePointer = {
    schemaVersion: 1,
    id: desiredIdentity.id,
    contentDigest: desiredIdentity.contentDigest,
  };
  if (
    current?.pointer.id === desired.id &&
    current.pointer.contentDigest === desired.contentDigest
  ) {
    return;
  }
  let stagedFile: StagedStoreFile | null = null;
  try {
    stagedFile = writeStagedStoreFile(
      paths.staging,
      "active-pointer",
      serializeHarnessPackageActivePointer(desired),
      authority,
    );
    beforeReplacement?.();
    if (current) {
      assertCanonicalStoreFileUnchanged(current.pointerRecord, authority);
    } else if (!storePathIsMissing(pointerPath(paths, desired.id))) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package active pointer appeared before replacement",
      );
    }
    publishStagedStoreFile(stagedFile, pointerPath(paths, desired.id), authority);
    stagedFile = null;
    const published = readPointer(paths, desired.id, authority);
    if (published.id !== desired.id || published.contentDigest !== desired.contentDigest) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package active pointer replacement did not persist",
      );
    }
  } finally {
    if (stagedFile) removeStagedStoreFile(stagedFile, authority);
  }
}

function publishUnderLock(
  input: PublishHarnessPackageInput,
  paths: HarnessPackageStorePaths,
  authority: HarnessPackageStoreAuthority,
): InstalledHarnessPackage {
  assertTreeAuthority(getPackageTreeAuthority(input.validatedTree));
  assertHarnessPackageStoreAuthority(authority);
  const current = validateCurrentPointer(paths, authority);
  assertRetainedReceiptBindings(input.expectedIdentity, paths, authority);
  assertRetainedObjectBindings(input.expectedIdentity, paths, authority);
  const retainedReceipt = optionalReceipt(input.expectedIdentity, paths, authority);
  optionalObject(input.expectedIdentity, paths);
  const copied = publishObject(input, paths, authority);
  let receipt: HarnessPackageReceipt;
  try {
    receipt = publishReceipt(input, paths, authority, retainedReceipt);
    if (!sameIdentity(receipt.identity, input.expectedIdentity)) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package published receipt identity is inconsistent",
      );
    }
  } finally {
    copied?.removeStagingRoot();
  }
  replacePointer(input.expectedIdentity, paths, authority, current, () =>
    input.dependencies?.onPublicationCheckpoint?.("before-active-pointer-replacement"),
  );
  const pointerAuthority = captureHarnessPackageStore(paths, [paths.active]);
  const installed = resolveActiveWithAuthority(
    input.expectedIdentity.id,
    paths,
    pointerAuthority,
    capturePinnedAuthority(paths),
  ).installed;
  if (!sameIdentity(installed.identity, input.expectedIdentity)) {
    throw new HarnessPackageStoreIntegrityError(
      "Harness package active readback selected a different package",
    );
  }
  return installed;
}

export function publishHarnessPackage(
  inputValue: PublishHarnessPackageInput,
): InstalledHarnessPackage {
  const expectedIdentity = parseHarnessPackageIdentity(inputValue.expectedIdentity);
  const sourceIdentity = parseHarnessPackageSourceIdentity(inputValue.sourceIdentity);
  const input = { ...inputValue, expectedIdentity, sourceIdentity };
  try {
    const sourceManifest = parseHarnessPackageManifest(input.validatedTree.rootDir);
    assertTreeAuthority(getPackageTreeAuthority(input.validatedTree));
    const sourceIdentityFromBytes = derivePackageIdentity(
      sourceManifest,
      input.validatedTree.contentDigest,
    );
    if (!sameIdentity(sourceIdentityFromBytes, expectedIdentity)) {
      throw new HarnessPackageStoreIntegrityError(
        "Harness package source identity changed before storage",
      );
    }
    const paths = harnessPackageStorePaths(selectedStoreRoot(input), expectedIdentity.id);
    const authority = ensureHarnessPackageStore(paths);
    const lock = acquireProcessBoundLockAt(paths.lock);
    try {
      return publishUnderLock(input, paths, authority);
    } finally {
      releaseProcessBoundLock(lock);
    }
  } catch (error) {
    return integrityFailure(error);
  }
}

function captureMutableStoreAuthority(
  paths: HarnessPackageStorePaths,
): HarnessPackageStoreAuthority {
  return captureHarnessPackageStore(paths, [
    paths.staging,
    paths.objects,
    paths.objectShard,
    paths.receipts,
    paths.harnessReceipts,
    paths.receiptShard,
    paths.active,
    paths.locks,
  ]);
}

/** Select an existing immutable package receipt as the active package. */
export function activateHarnessPackage(
  idValue: unknown,
  digestValue: unknown,
  options: HarnessPackagePointerMutationOptions = {},
): InstalledHarnessPackage {
  try {
    const id = parseHarnessPackageId(idValue);
    const digest = parseHarnessPackageContentDigest(digestValue);
    const paths = harnessPackageStorePaths(selectedStoreRoot(options), id);
    if (storePathIsMissing(paths.root)) {
      throw new HarnessPackageStoreIntegrityError("Harness package store is unavailable");
    }
    const authority = captureMutableStoreAuthority(paths);
    const lock = acquireProcessBoundLockAt(paths.lock);
    try {
      const receipt = readReceipt(paths, digest, authority);
      if (receipt.identity.id !== id || receipt.identity.contentDigest !== digest) {
        throw new HarnessPackageStoreIntegrityError(
          "Harness package receipt does not match the requested activation",
        );
      }
      const selected = resolvePinnedWithAuthority(receipt.identity, paths, authority);
      const current = validateCurrentPointer(paths, authority);
      replacePointer(selected.identity, paths, authority, current, () =>
        options.dependencies?.onPointerMutationCheckpoint?.("before-active-pointer-replacement"),
      );
      const activated = resolveActiveWithAuthority(
        id,
        paths,
        captureHarnessPackageStore(paths, [paths.active]),
        capturePinnedAuthority(paths),
      ).installed;
      if (!sameIdentity(activated.identity, selected.identity)) {
        throw new HarnessPackageStoreIntegrityError(
          "Harness package activation selected a different package",
        );
      }
      return activated;
    } finally {
      releaseProcessBoundLock(lock);
    }
  } catch (error) {
    return integrityFailure(error);
  }
}

/**
 * Stop selecting a package for new sandboxes while retaining its immutable
 * object and receipt for existing sandboxes and later rollback.
 */
export function deactivateHarnessPackage(
  idValue: unknown,
  options: HarnessPackagePointerMutationOptions = {},
): DeactivatedHarnessPackage | null {
  try {
    const id = parseHarnessPackageId(idValue);
    const paths = harnessPackageStorePaths(selectedStoreRoot(options), id);
    if (
      storePathIsMissing(paths.root) ||
      storePathIsMissing(paths.active) ||
      storePathIsMissing(pointerPath(paths, id))
    ) {
      return null;
    }
    const authority = captureMutableStoreAuthority(paths);
    const lock = acquireProcessBoundLockAt(paths.lock);
    try {
      const current = validateCurrentPointer(paths, authority);
      if (current === null) return null;
      if (
        options.expectedIdentity !== undefined &&
        !sameIdentity(
          current.installed.identity,
          parseHarnessPackageIdentity(options.expectedIdentity),
        )
      ) {
        throw new HarnessPackageStoreIntegrityError(
          "Harness package active identity changed before deactivation",
        );
      }
      options.dependencies?.onPointerMutationCheckpoint?.("before-active-pointer-replacement");
      assertCanonicalStoreFileUnchanged(current.pointerRecord, authority);
      removeCanonicalStoreFile(current.pointerRecord, authority);
      return Object.freeze({ state: "deactivated", identity: current.installed.identity });
    } finally {
      releaseProcessBoundLock(lock);
    }
  } catch (error) {
    return integrityFailure(error);
  }
}
