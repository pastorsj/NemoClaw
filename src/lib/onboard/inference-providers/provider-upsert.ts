// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/provider-command";
import { inspectProviderAttachmentOwnership } from "../../adapters/openshell/provider-ownership";
import {
  matchesGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} from "../gateway-provider-metadata";
import { deleteProviderWithRecovery } from "../sandbox-provider-cleanup";

const PROVIDER_MUTATION_MAX_BUFFER_BYTES = 64 * 1024;
const UNSAFE_PROVIDER_DIAGNOSTIC_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function diagnosticText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

/** Remove exact submitted credentials and terminal controls before formatting a child diagnostic. */
function sanitizeProviderDiagnostic(value: unknown, credentialValues: readonly string[]): string {
  let diagnostic = diagnosticText(value);
  for (const credentialValue of credentialValues) {
    diagnostic = diagnostic.replaceAll(credentialValue, "<REDACTED>");
  }
  return stripVTControlCharacters(diagnostic).replace(UNSAFE_PROVIDER_DIAGNOSTIC_CHARACTERS, " ");
}

export type ProviderCommandResult = {
  readonly status?: number | null;
  readonly output?: string | Buffer | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
};

export type ProviderCommandRunner = (
  args: string[],
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly ignoreError?: boolean;
    readonly maxBuffer?: number;
    readonly stdio?: StdioOptions;
    readonly suppressOutput?: boolean;
    readonly timeout?: number;
  },
) => ProviderCommandResult;

export type UpsertProviderOptions = {
  readonly replaceExisting?: boolean;
  readonly knownExists?: boolean;
  readonly requireExistingProvider?: boolean;
  readonly allowedSandboxes?: readonly string[];
  readonly requireExactBinding?: boolean;
  readonly allowExtendedCredentialKeys?: boolean;
  readonly credentialEnvs?: readonly string[];
  readonly expectedProviderId?: string;
  readonly revalidateSandboxIdentity?: (operation: string) => void;
  /** Record an attempted gateway mutation after identity revalidation and before transport. */
  readonly recordMutationAttempt?: () => void;
  /** Convert command output into a bounded, redacted diagnostic. Omit to keep failures generic. */
  readonly formatDiagnostic?: (value: unknown) => string;
};

export type UpsertProviderResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly reason?: "binding-conflict";
    };

/** Build one OpenShell provider create or update command. */
export function buildProviderArgs(
  action: "create" | "update",
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  options: {
    readonly includeCredential?: boolean;
    readonly credentialEnvs?: readonly string[];
  } = {},
): string[] {
  const { includeCredential = true, credentialEnvs } = options;
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type]
      : ["provider", "update", name];
  if (includeCredential) {
    for (const envKey of credentialEnvs ?? [credentialEnv]) {
      args.push("--credential", envKey);
    }
  }
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

/** Check whether one provider name exists in the selected OpenShell gateway. */
export function providerExistsInGateway(
  name: string,
  runOpenshell: ProviderCommandRunner,
): boolean {
  const result = runOpenshell(["provider", "get", name], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

export function identityCheckedRunner(
  runOpenshell: ProviderCommandRunner,
  revalidateSandboxIdentity: ((operation: string) => void) | undefined,
  operation: string,
): ProviderCommandRunner {
  if (!revalidateSandboxIdentity) return runOpenshell;
  return (args, options) => {
    revalidateSandboxIdentity(operation);
    return runOpenshell(args, options);
  };
}

/** Create, update, or explicitly replace one OpenShell provider binding. */
export function upsertProvider(
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv,
  providerRunner: ProviderCommandRunner,
  options: UpsertProviderOptions = {},
): UpsertProviderResult {
  const credentialEnvs = options.credentialEnvs ?? [credentialEnv];
  const credentialValues = [
    ...new Set(
      credentialEnvs
        .map((envKey) => env[envKey])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);
  const formatDiagnostic = (value: unknown): string => {
    if (!options.formatDiagnostic) return "";
    try {
      const formatted = options.formatDiagnostic(
        sanitizeProviderDiagnostic(value, credentialValues),
      );
      return sanitizeProviderDiagnostic(formatted, credentialValues).slice(0, 8192);
    } catch {
      return "";
    }
  };
  const operation = `inspect or change provider ${JSON.stringify(name)}`;
  const runOpenshell = identityCheckedRunner(
    providerRunner,
    options.revalidateSandboxIdentity,
    operation,
  );
  const runMutation = (args: string[], commandOptions?: Parameters<ProviderCommandRunner>[1]) => {
    options.revalidateSandboxIdentity?.(operation);
    options.recordMutationAttempt?.();
    return providerRunner(args, {
      ...commandOptions,
      maxBuffer: PROVIDER_MUTATION_MAX_BUFFER_BYTES,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
  };
  const exists = options.knownExists ?? providerExistsInGateway(name, runOpenshell);
  const bindingMatches = (metadata: ReturnType<typeof readGatewayProviderMetadata>) =>
    (!options.expectedProviderId || metadata?.id === options.expectedProviderId) &&
    (options.allowExtendedCredentialKeys
      ? matchesGatewayCredentialFamilyProviderBinding(metadata, {
          name,
          type,
          credentialKey: credentialEnv,
        })
      : matchesGatewayCredentialOnlyProviderBinding(metadata, {
          name,
          type,
          credentialKey: credentialEnv,
        }));
  const attachmentOwnershipFailure = (): UpsertProviderResult | null => {
    if (!options.expectedProviderId || !options.allowedSandboxes) return null;
    const ownership = inspectProviderAttachmentOwnership(
      name,
      options.allowedSandboxes,
      runOpenshell,
    );
    if (ownership.kind === "authorized") return null;
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message:
        ownership.kind === "foreign"
          ? `Existing provider '${name}' is attached outside the authorized sandbox set; refusing credential mutation.`
          : `Could not verify every sandbox attachment for existing provider '${name}'; refusing credential mutation.`,
    };
  };
  if (!exists && options.requireExistingProvider) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' is missing; refusing to create a replacement identity.`,
    };
  }
  if (
    exists &&
    options.expectedProviderId &&
    !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
  ) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' does not match its recorded stable identity.`,
    };
  }
  if (exists && !options.replaceExisting) {
    const ownershipFailure = attachmentOwnershipFailure();
    if (ownershipFailure) return ownershipFailure;
  }
  if (
    exists &&
    options.requireExactBinding &&
    !options.replaceExisting &&
    !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
  ) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' does not match the required '${type}' credential binding.`,
    };
  }
  if (exists && options.replaceExisting) {
    const result = deleteProviderWithRecovery(name, {
      runOpenshell: (args, commandOptions) => {
        if (
          args[0] === "provider" &&
          args[1] === "delete" &&
          options.expectedProviderId &&
          !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
        ) {
          return {
            status: 1,
            stdout: "",
            stderr: `Provider '${name}' changed before replacement.`,
          };
        }
        const commandResult =
          args[0] === "provider" && args[1] === "delete"
            ? runMutation(args, commandOptions)
            : runOpenshell(args, commandOptions);
        return { ...commandResult, status: commandResult.status ?? null };
      },
      allowedSandboxes: options.allowedSandboxes,
    });
    if (!result.ok) {
      const base =
        formatDiagnostic(result.stderr) ||
        formatDiagnostic(result.stdout) ||
        `Failed to replace provider '${name}'.`;
      const detail =
        result.recoveryFailures.length > 0
          ? ` (detach failures: ${result.recoveryFailures
              .map((failure) => {
                const diagnostic = formatDiagnostic(failure.output);
                return `${failure.sandbox}${diagnostic ? `: ${diagnostic}` : ""}`;
              })
              .join("; ")})`
          : "";
      return { ok: false, status: result.status || 1, message: `${base}${detail}` };
    }
  }
  const action = exists && !options.replaceExisting ? "update" : "create";
  const availableCredentialEnvs = credentialEnvs.filter(
    (envKey) => typeof env[envKey] === "string" && env[envKey].length > 0,
  );
  if (
    action === "create" &&
    options.allowExtendedCredentialKeys &&
    !availableCredentialEnvs.includes(credentialEnv)
  ) {
    return {
      ok: false,
      status: 1,
      message: `Cannot create provider '${name}' without its canonical credential '${credentialEnv}'.`,
    };
  }
  const submittedCredentialEnvs = action === "create" ? credentialEnvs : availableCredentialEnvs;
  const includeCredential = submittedCredentialEnvs.length > 0;
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl, {
    includeCredential,
    credentialEnvs: submittedCredentialEnvs,
  });
  if (
    action === "update" &&
    options.expectedProviderId &&
    !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
  ) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' changed before credential update.`,
    };
  }
  if (action === "update") {
    const ownershipFailure = attachmentOwnershipFailure();
    if (ownershipFailure) return ownershipFailure;
    if (
      options.expectedProviderId &&
      !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
    ) {
      return {
        ok: false,
        status: 1,
        reason: "binding-conflict",
        message: `Existing provider '${name}' changed during attachment inspection.`,
      };
    }
  }
  const result = runMutation(args, {
    ignoreError: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output =
      formatDiagnostic(result.stderr) ||
      formatDiagnostic(result.stdout) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  if (
    action === "update" &&
    options.expectedProviderId &&
    !bindingMatches(readGatewayProviderMetadata(name, runOpenshell))
  ) {
    return {
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message: `Existing provider '${name}' changed during credential update.`,
    };
  }
  return { ok: true };
}
