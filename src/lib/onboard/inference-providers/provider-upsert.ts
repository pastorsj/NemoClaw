// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

import {
  matchesGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} from "../gateway-provider-metadata";
import { deleteProviderWithRecovery } from "../sandbox-provider-cleanup";

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
    readonly stdio?: StdioOptions;
    readonly suppressOutput?: boolean;
  },
) => ProviderCommandResult;

export type UpsertProviderOptions = {
  readonly replaceExisting?: boolean;
  readonly knownExists?: boolean;
  readonly allowedSandboxes?: readonly string[];
  readonly requireExactBinding?: boolean;
  readonly allowExtendedCredentialKeys?: boolean;
  readonly credentialEnvs?: readonly string[];
  readonly revalidateSandboxIdentity?: (operation: string) => void;
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
  const formatDiagnostic = (value: unknown): string => {
    if (!options.formatDiagnostic) return "";
    try {
      return options.formatDiagnostic(value).slice(0, 8192);
    } catch {
      return "";
    }
  };
  const runOpenshell = identityCheckedRunner(
    providerRunner,
    options.revalidateSandboxIdentity,
    `inspect or change provider ${JSON.stringify(name)}`,
  );
  const exists = options.knownExists ?? providerExistsInGateway(name, runOpenshell);
  const credentialEnvs = options.credentialEnvs ?? [credentialEnv];
  const bindingMatches = (metadata: ReturnType<typeof readGatewayProviderMetadata>) =>
    options.allowExtendedCredentialKeys
      ? matchesGatewayCredentialFamilyProviderBinding(metadata, {
          name,
          type,
          credentialKey: credentialEnv,
        })
      : matchesGatewayCredentialOnlyProviderBinding(metadata, {
          name,
          type,
          credentialKey: credentialEnv,
        });
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
        const commandResult = runOpenshell(args, commandOptions);
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
  const result = runOpenshell(args, {
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
  return { ok: true };
}
