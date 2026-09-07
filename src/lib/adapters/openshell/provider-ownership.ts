// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../sandbox-name-contract";
import { parseCliOpenShellProviderAttachmentNames } from "./provider-attachment-cli";
import { isValidCliOpenShellProviderIdentifier } from "./provider-metadata-cli";
import { parseStrictOpenShellSandboxListJson } from "./sandbox-identity";

const MAX_PROVIDER_INVENTORY_BYTES = 64 * 1024;
const MAX_PROVIDER_INVENTORY_SANDBOXES = 256;
const PROVIDER_INVENTORY_TIMEOUT_MS = 5_000;

type ProviderInventoryCommandResult = {
  readonly error?: unknown;
  readonly signal?: unknown;
  readonly status?: number | null;
  readonly stderr?: string | Buffer | null;
  readonly stdout?: string | Buffer | null;
};

export type ProviderInventoryCommandRunner = (
  args: string[],
  options: {
    readonly ignoreError: true;
    readonly maxBuffer: number;
    readonly suppressOutput: true;
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly timeout: number;
  },
) => ProviderInventoryCommandResult;

export type ProviderAttachmentOwnershipInspection =
  | {
      readonly kind: "authorized";
      readonly attachedSandboxNames: readonly string[];
    }
  | {
      readonly kind: "foreign";
      readonly attachedSandboxNames: readonly string[];
      readonly foreignSandboxNames: readonly string[];
    }
  | { readonly kind: "indeterminate" };

function boundedCommandText(value: unknown): string | null {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return value == null ? "" : null;
  const text = value.toString();
  return Buffer.byteLength(text, "utf8") <= MAX_PROVIDER_INVENTORY_BYTES ? text : null;
}

function runBoundedInventoryCommand(
  args: string[],
  runOpenshell: ProviderInventoryCommandRunner,
): { readonly stdout: string } | null {
  let result: ProviderInventoryCommandResult;
  try {
    result = runOpenshell(args, {
      ignoreError: true,
      maxBuffer: MAX_PROVIDER_INVENTORY_BYTES,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROVIDER_INVENTORY_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const stdout = boundedCommandText(result.stdout);
  const stderr = boundedCommandText(result.stderr);
  if (
    result.status !== 0 ||
    result.error ||
    result.signal ||
    stdout === null ||
    stderr === null ||
    stderr.trim().length > 0
  ) {
    return null;
  }
  return { stdout };
}

function isCanonicalSandboxName(value: string): boolean {
  return isValidName(value);
}

/**
 * Inspect every sandbox in the selected gateway before changing a receipt-owned
 * provider. The inventory fails closed because an update or refresh changes the
 * credential observed by every attached sandbox, not only the caller's target.
 */
export function inspectProviderAttachmentOwnership(
  providerName: string,
  allowedSandboxes: readonly string[],
  runOpenshell: ProviderInventoryCommandRunner,
): ProviderAttachmentOwnershipInspection {
  if (
    !isValidCliOpenShellProviderIdentifier(providerName) ||
    allowedSandboxes.some((name) => !isCanonicalSandboxName(name)) ||
    new Set(allowedSandboxes).size !== allowedSandboxes.length
  ) {
    return { kind: "indeterminate" };
  }

  const listResult = runBoundedInventoryCommand(["sandbox", "list", "-o", "json"], runOpenshell);
  if (!listResult) return { kind: "indeterminate" };
  const rows = parseStrictOpenShellSandboxListJson(listResult.stdout);
  if (
    !rows ||
    rows.length > MAX_PROVIDER_INVENTORY_SANDBOXES ||
    rows.some((row) => !isCanonicalSandboxName(row.name)) ||
    new Set(rows.map((row) => row.name)).size !== rows.length ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    return { kind: "indeterminate" };
  }

  const attachedSandboxNames: string[] = [];
  for (const row of rows) {
    const attachmentResult = runBoundedInventoryCommand(
      ["sandbox", "provider", "list", row.name],
      runOpenshell,
    );
    if (!attachmentResult) return { kind: "indeterminate" };
    const attachedProviderNames = parseCliOpenShellProviderAttachmentNames(attachmentResult.stdout);
    if (!attachedProviderNames) return { kind: "indeterminate" };
    if (attachedProviderNames.includes(providerName)) attachedSandboxNames.push(row.name);
  }

  const allowed = new Set(allowedSandboxes);
  const foreignSandboxNames = attachedSandboxNames.filter((name) => !allowed.has(name));
  return foreignSandboxNames.length > 0
    ? {
        kind: "foreign",
        attachedSandboxNames: Object.freeze(attachedSandboxNames),
        foreignSandboxNames: Object.freeze(foreignSandboxNames),
      }
    : {
        kind: "authorized",
        attachedSandboxNames: Object.freeze(attachedSandboxNames),
      };
}
