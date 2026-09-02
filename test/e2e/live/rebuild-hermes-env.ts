// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

const HERMES_BASE_IMAGE_OVERRIDE_ENV = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
const OFFICIAL_HERMES_BASE_DIGEST =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;
const LOCAL_HERMES_BASE = /^nemoclaw-hermes-sandbox-base-local:[^\s]+$/;
const REBUILD_HERMES_ISOLATION_ENV = [
  "NEMOCLAW_GATEWAY_PORT",
  "OPENSHELL_GATEWAY",
  "XDG_BIN_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export interface RebuildHermesBaseReusePlan {
  sourceRef: string;
  preparedRef: string;
  childEnv: NodeJS.ProcessEnv;
}

export type RebuildHermesEnvFactory = (
  apiKey?: string,
  extra?: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;

export function createRebuildHermesEnvFactory(
  baseEnvironment: NodeJS.ProcessEnv,
  options: {
    endpointUrl: string;
    model: string;
    openshellBin?: string;
    sandboxName: string;
  },
): RebuildHermesEnvFactory {
  const openshellBin = options.openshellBin?.trim();
  return (apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    buildRebuildHermesChildEnv(baseEnvironment, {
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_COMPAT_MODEL: options.model,
      NEMOCLAW_ENDPOINT_URL: options.endpointUrl,
      NEMOCLAW_MODEL: options.model,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: options.sandboxName,
      ...(openshellBin ? { NEMOCLAW_OPENSHELL_BIN: openshellBin } : {}),
      ...(apiKey
        ? { COMPATIBLE_API_KEY: apiKey, NVIDIA_INFERENCE_API_KEY: apiKey }
        : {}),
      ...extra,
    });
}

/** Supply the current Discord credential when rebuild replaces the legacy provider. */
export function buildRebuildHermesRecreateEnv(
  discordBotToken: string,
  baseImageEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...baseImageEnv,
    DISCORD_BOT_TOKEN: discordBotToken,
    NEMOCLAW_REBUILD_VERBOSE: "1",
  };
}

/** Select the normal lane's exact phase 1 image under a test-owned local alias. */
export function planRebuildHermesBaseReuse(
  staleBaseMode: boolean,
  metadata: SandboxBaseImageResolutionMetadata | null,
  preparedRef: string,
): RebuildHermesBaseReusePlan | null {
  if (staleBaseMode) return null;
  if (!metadata) {
    throw new Error("normal rebuild-Hermes setup did not record base-image resolution metadata");
  }

  const sourceRef = metadata.ref.trim();
  const trustedSource =
    metadata.source === "pinned"
      ? Boolean(
          sourceRef &&
            OFFICIAL_HERMES_BASE_DIGEST.test(sourceRef) &&
            metadata.pinnedRemoteRef &&
            OFFICIAL_HERMES_BASE_DIGEST.test(metadata.pinnedRemoteRef),
        )
      : metadata.source === "local"
        ? Boolean(sourceRef && LOCAL_HERMES_BASE.test(sourceRef))
        : false;
  if (!trustedSource) {
    throw new Error(
      `normal rebuild-Hermes setup recorded unsupported base-image source '${metadata.source}'`,
    );
  }

  const normalizedPreparedRef = preparedRef.trim();
  if (!LOCAL_HERMES_BASE.test(normalizedPreparedRef)) {
    throw new Error("normal rebuild-Hermes setup requires a test-owned local base-image ref");
  }

  return {
    sourceRef,
    preparedRef: normalizedPreparedRef,
    childEnv: { [HERMES_BASE_IMAGE_OVERRIDE_ENV]: normalizedPreparedRef },
  };
}

/**
 * Build the explicit child environment used by the Hermes rebuild scenario.
 * The fixture-wide allowlist intentionally remains narrow; the selected
 * OpenShell channel and its explicit dev-artifact opt-in are the only extra
 * non-secret compatibility inputs forwarded from the parent test process.
 */
export function buildRebuildHermesChildEnv(
  base: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const openshellChannel = base.NEMOCLAW_OPENSHELL_CHANNEL;
  const acceptDevUnverifiedInstall = base.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL;
  return {
    ...buildAvailabilityProbeEnv(base),
    ...Object.fromEntries(
      REBUILD_HERMES_ISOLATION_ENV.flatMap((key) =>
        base[key] === undefined ? [] : [[key, base[key]]],
      ),
    ),
    ...(acceptDevUnverifiedInstall === undefined
      ? {}
      : { NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: acceptDevUnverifiedInstall }),
    ...(openshellChannel === undefined ? {} : { NEMOCLAW_OPENSHELL_CHANNEL: openshellChannel }),
    ...overlay,
  };
}
