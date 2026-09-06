// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";

import {
  HARNESS_MESSAGING_ADAPTER_CONTRACT,
  type HarnessMessagingDisabledIntegration,
  type HarnessMessagingIntegration,
  type HarnessMessagingProfileReference,
  validateHarnessMessagingChannelProfiles,
} from "./adapter/messaging";
import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import { readObject, readString, readStringArray } from "./manifest-readers";
import type { ManifestRecord } from "./manifest-types";
import type { HarnessPackageStoreOptions } from "./package/store";
import { resolvePinnedHarnessPackage } from "./package/store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "./package/tree";
import type { HarnessPackageIdentity } from "./package/types";

export type { HarnessMessagingIntegration } from "./adapter/messaging";

interface DeclaredMessagingIntegration {
  readonly support: "channels" | "disabled";
  readonly channelIds: readonly string[];
}

const PROFILE_MAX_BYTES = 128 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class HarnessMessagingModuleError extends Error {
  override readonly name = "HarnessMessagingModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function messagingModuleFailure(error: unknown): never {
  if (error instanceof HarnessMessagingModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessMessagingModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessMessagingModuleError(
    "Installed harness messaging adapter failed",
    "invalid-adapter",
    { cause: error },
  );
}

function readMessagingDeclaration(manifest: ManifestRecord): DeclaredMessagingIntegration {
  const messaging = readObject(manifest, "messaging");
  const support = readString(messaging ?? {}, "support");
  if (support === "disabled") {
    return Object.freeze({ support, channelIds: Object.freeze([]) });
  }
  const channels = readStringArray(messaging ?? {}, "channels");
  if (support !== "channels" || !channels || channels.length === 0) {
    throw new HarnessMessagingModuleError(
      "Installed harness package has an invalid messaging declaration",
    );
  }
  return Object.freeze({ support, channelIds: Object.freeze([...channels]) });
}

function requireDeclarationAgreement(
  identity: HarnessPackageIdentity,
  declaration: DeclaredMessagingIntegration,
  integration: HarnessMessagingProfileReference | HarnessMessagingDisabledIntegration,
): void {
  if (integration.packageId !== identity.id) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging adapter does not match its package identity",
    );
  }
  if (
    declaration.support === "disabled"
      ? integration.kind !== "disabled"
      : integration.kind !== "channels" ||
        !isDeepStrictEqual(integration.channelIds, declaration.channelIds)
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging adapter does not match its manifest declaration",
    );
  }
}

function readChannelProfiles(
  identity: HarnessPackageIdentity,
  profilePath: string,
  options: HarnessPackageStoreOptions,
) {
  const installed = resolvePinnedHarnessPackage(identity, options);
  const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
  if (tree.contentDigest !== identity.contentDigest) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile failed integrity validation",
    );
  }
  const authority = getPackageTreeAuthority(tree);
  const relativePath = path.posix.join(
    path.posix.dirname(installed.packageManifest.envelope.manifest),
    profilePath,
  );
  const entry = authority.entries.find((candidate) => candidate.relativePath === relativePath);
  if (!entry || entry.type !== "file" || entry.stat.size > BigInt(PROFILE_MAX_BYTES)) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile is missing or oversized",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(readVerifiedFile(entry, PROFILE_MAX_BYTES)));
  } catch (error) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile must be valid JSON",
      "invalid-adapter",
      { cause: error },
    );
  }
  assertTreeAuthority(authority);
  return validateHarnessMessagingChannelProfiles(parsed);
}

function validateChannelProfileSemantics(profiles: ReturnType<typeof readChannelProfiles>): void {
  const channelIds = new Set<string>();
  for (const profile of profiles) {
    if (channelIds.has(profile.channelId)) {
      throw new HarnessMessagingModuleError(
        `Installed harness messaging profile repeats channel '${profile.channelId}'`,
      );
    }
    channelIds.add(profile.channelId);
    for (const statePath of profile.config.statePaths ?? []) {
      if (!isSafePackageStatePath(statePath)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has unsafe state path '${statePath}'`,
        );
      }
    }
    const renderIds = new Set<string>();
    for (const render of profile.config.renders) {
      if (renderIds.has(render.id)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile repeats render '${render.id}'`,
        );
      }
      renderIds.add(render.id);
      if (
        path.posix.isAbsolute(render.target) ||
        render.target.includes("\\") ||
        render.target.split("/").includes("..")
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has unsafe target '${render.target}'`,
        );
      }
      if (
        render.kind === "json-fragment" &&
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(render.path)
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has invalid config path '${render.path}'`,
        );
      }
      if (render.kind === "env-lines" && render.lines.some((line) => /[\r\n]/u.test(line))) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has a multiline env value in '${render.id}'`,
        );
      }
    }
  }
}

function isSafePackageStatePath(statePath: string): boolean {
  return (
    !path.posix.isAbsolute(statePath) &&
    !statePath.includes("\\") &&
    statePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Resolve one immutable messaging profile from an exact installed package receipt. */
export function loadHarnessMessagingIntegration(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessMessagingIntegration {
  let declaration: DeclaredMessagingIntegration | null = null;
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_MESSAGING_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_MESSAGING_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        declaration = readMessagingDeclaration(manifest);
      },
    });
    if (declaration === null) {
      throw new HarnessMessagingModuleError(
        "Installed harness package has no messaging declaration",
      );
    }
    const described = adapter.describeIntegration({ packageId: identity.id });
    requireDeclarationAgreement(identity, declaration, described);
    if (described.kind === "disabled") return described;
    const channels = readChannelProfiles(identity, described.profilePath, options);
    validateChannelProfileSemantics(channels);
    const channelById = new Map(channels.map((profile) => [profile.channelId, profile]));
    if (
      channelById.size !== described.channelIds.length ||
      described.channelIds.some((channelId) => !channelById.has(channelId))
    ) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging profile does not match its adapter declaration",
      );
    }
    return Object.freeze({
      kind: "channels",
      packageId: identity.id,
      build: described.build,
      channels: described.channelIds.map((channelId) => channelById.get(channelId)!),
    });
  } catch (error) {
    messagingModuleFailure(error);
  }
}
