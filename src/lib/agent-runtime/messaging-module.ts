// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  HARNESS_MESSAGING_ADAPTER_CONTRACT,
  type HarnessMessagingIntegration,
} from "./adapter/messaging";
import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import { readObject, readString, readStringArray } from "./manifest-readers";
import type { ManifestRecord } from "./manifest-types";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type { HarnessMessagingIntegration } from "./adapter/messaging";

interface DeclaredMessagingIntegration {
  readonly support: "channels" | "disabled";
  readonly channelIds: readonly string[];
}

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
  integration: HarnessMessagingIntegration,
): HarnessMessagingIntegration {
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
  return integration;
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
    return requireDeclarationAgreement(
      identity,
      declaration,
      adapter.describeIntegration({ packageId: identity.id }),
    );
  } catch (error) {
    messagingModuleFailure(error);
  }
}
