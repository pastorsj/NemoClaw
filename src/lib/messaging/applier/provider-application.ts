// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildMessagingBridgeRefreshMaterial,
  resolveMessagingBridgeSecret,
  type MessagingBridgeProfile,
  type RefreshingMessagingBridgeProfile,
} from "../../onboard/messaging-bridge-provider";
import type { MessagingTokenDef } from "../../onboard/messaging-prep";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import type {
  MessagingCredentialProviderEphemeralInput,
  MessagingProviderRefreshEphemeralInput,
} from "./types";

export interface BuildMessagingProviderApplicationInput {
  readonly tokenDefs: readonly MessagingTokenDef[];
  /** Override only for the core-owned endpointless compatibility profile. */
  readonly root?: string;
  /** Compatibility-only metadata; provider selection never branches on this value. */
  readonly agent?: string | null;
  readonly getCredential: (envKey: string) => string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly normalizeCredentialValue?: (value: unknown) => string;
  readonly channelIdForCredential?: (envKey: string, providerName: string) => string | null;
  /** Compatibility-only input; active profiles must be carried by each token definition. */
  readonly profiles?: readonly MessagingBridgeProfile[];
}

/** Process-memory-only inputs for one immediate provider application. */
export interface MessagingProviderEphemeralInputs {
  readonly definitions: readonly MessagingCredentialProviderEphemeralInput[];
  readonly refreshes: readonly MessagingProviderRefreshEphemeralInput[];
}

export function buildMessagingProviderApplication(
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderEphemeralInputs {
  const definitions: MessagingCredentialProviderEphemeralInput[] = [];
  const refreshes: MessagingProviderRefreshEphemeralInput[] = [];

  for (const tokenDef of input.tokenDefs) {
    const providerType = tokenDef.providerType ?? "generic";
    const bridgeProfile = tokenDef.messagingProviderProfile;
    if (bridgeProfile && bridgeProfile.profileId !== providerType) {
      throw new Error(
        `Messaging provider '${tokenDef.name}' disagrees with its receipt-owned profile.`,
      );
    }
    const profile = providerProfile(tokenDef, providerType, input.root ?? REPOSITORY_ROOT);
    const channelId =
      bridgeProfile?.channelId ??
      input.channelIdForCredential?.(tokenDef.envKey, tokenDef.name) ??
      "messaging";
    definitions.push({
      channelId,
      credentialId: tokenDef.envKey,
      providerName: tokenDef.name,
      providerType,
      credentials: [
        { name: tokenDef.envKey, value: normalizeToken(tokenDef.token) },
        ...(tokenDef.additionalCredentials ?? []).map(({ envKey, token }) => ({
          name: envKey,
          value: normalizeToken(token),
        })),
      ],
      ...(profile ? { profile } : {}),
      ...(tokenDef.expectedProviderId ? { expectedProviderId: tokenDef.expectedProviderId } : {}),
      ...(tokenDef.allowProviderReplacement === undefined
        ? {}
        : { allowProviderReplacement: tokenDef.allowProviderReplacement }),
    });
    if (bridgeProfile?.strategy) {
      refreshes.push(
        buildRefreshDefinition(
          tokenDef,
          { ...bridgeProfile, strategy: bridgeProfile.strategy },
          input,
        ),
      );
    }
  }

  return { definitions, refreshes };
}

function providerProfile(
  tokenDef: MessagingTokenDef,
  providerType: string,
  coreRoot: string,
): MessagingCredentialProviderEphemeralInput["profile"] {
  const bridgeProfile = tokenDef.messagingProviderProfile;
  if (bridgeProfile) {
    return {
      profilePath: bridgeProfile.profilePath,
      profileType: providerType,
      ...(bridgeProfile.profileSource === undefined
        ? {}
        : { profileSource: bridgeProfile.profileSource }),
    };
  }
  if (tokenDef.providerProfilePath) {
    return { profilePath: tokenDef.providerProfilePath, profileType: providerType };
  }
  if (providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE) {
    return {
      profilePath: messagingCredentialProviderProfilePath(coreRoot),
      profileType: providerType,
    };
  }
  return undefined;
}

function buildRefreshDefinition(
  tokenDef: MessagingTokenDef,
  profile: RefreshingMessagingBridgeProfile,
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderRefreshEphemeralInput {
  const secret = resolveMessagingBridgeSecret(profile.sourceSecretEnv, {
    getCredential: input.getCredential,
    env: input.env,
    normalizeCredentialValue: input.normalizeCredentialValue ?? normalizeUnknownCredential,
  });
  if (!secret) {
    throw new Error(
      `${profile.channelId} bridge secret material is unavailable for gateway token minting.`,
    );
  }
  const built = buildMessagingBridgeRefreshMaterial(profile, secret);
  if (!built.ok) {
    throw new Error(
      `${profile.channelId} bridge cannot configure gateway token minting: ${built.reason}.`,
    );
  }
  const secretKeys = new Set(built.secretKeys);
  return {
    channelId: profile.channelId,
    providerName: tokenDef.name,
    credentialKey: profile.credentialKey,
    strategy: profile.strategy,
    material: built.material.filter(({ key }) => !secretKeys.has(key)),
    secretMaterial: built.material.filter(({ key }) => secretKeys.has(key)),
  };
}

function normalizeToken(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r/gu, "").trim();
  return normalized || null;
}

function normalizeUnknownCredential(value: unknown): string {
  return typeof value === "string" ? (normalizeToken(value) ?? "") : "";
}
