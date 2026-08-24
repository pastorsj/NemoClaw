// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw Blueprint Runner
 *
 * Orchestrates OpenClaw sandbox lifecycle inside OpenShell.
 *
 * Protocol:
 *   - stdout lines starting with PROGRESS:<0-100>:<label> are parsed as progress updates
 *   - stdout line RUN_ID:<id> reports the run identifier
 *   - exit code 0 = success, non-zero = failure
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { execa } from "execa";

import { DASHBOARD_PORT } from "../lib/ports.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { isPlainObject } from "../shared/object-record.js";
import * as importedSandboxName from "#nemoclaw-shared/sandbox-name.cjs";
import {
  loadBlueprint,
  mergePolicyAdditions,
  type Blueprint,
  type InferenceProfile,
  type InferenceProfileMap,
  type RouterConfig,
  type SandboxConfig,
} from "./blueprint-config.js";
import {
  attachRuntimeIdentity,
  compensateRuntimeIdentityApply,
  isRuntimeIdentityReceipt,
  mintRuntimeIdentityCredential,
  parseRuntimeIdentityProviderMetadata,
  prepareRuntimeIdentity,
  type RuntimeIdentityCommandDeps,
  type RuntimeIdentityCommandOptions,
  type RuntimeIdentityDeps,
  type RuntimeIdentityProfilePolicy,
  type RuntimeIdentityReceipt,
  removeRuntimeIdentity,
} from "./runtime-identity.js";
import {
  buildPersistedRunPlan,
  buildSafePublicRunPlan,
  buildStatusRunPlan,
  type RunPlan,
} from "./run-plan.js";
import { emitRunId, writeRunLog, writeRunProgress } from "./run-output.js";
import type { SnapshotCommandOptions } from "./snapshot-command.js";
import { actionSnapshots } from "./snapshot-command.js";
import { safeEndpointUrlForDownstream, validateEndpointUrl } from "./ssrf.js";

// sourceOfTruth: src/lib/shared/sandbox-name.cts
const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { assertValidName, assertValidProviderName } =
  sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

export { loadBlueprint } from "./blueprint-config.js";
export { emitRunId } from "./run-output.js";
export type { RunPlan } from "./run-plan.js";

type Action = "plan" | "apply" | "status" | "rollback";

type RollbackPlanSource = {
  sandbox_name?: unknown;
  sandbox_created_by_apply?: unknown;
  inference_provider_created_by_apply?: unknown;
  inference?: unknown;
  identity?: unknown;
};
const MISSING_SANDBOX_PATTERN = /\b(?:not found|does not exist)\b/i;
const MISSING_SANDBOX_INSPECTION_PATTERN =
  /(?:\bsandbox\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bsandbox\b)/i;
const MISSING_PROVIDER_INSPECTION_PATTERN =
  /(?:\bprovider\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bprovider\b|\bunknown provider\b)/i;

interface InferenceRouteBinding {
  provider: string;
  model: string;
  timeoutSeconds?: number;
}

function assertReusableRuntimeIdentitySandbox(output: string, expectedName: string): void {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const nameLine = lines.find((line) => /^\s*Name:/i.test(line));
  const phaseLine = lines.find((line) => /^\s*Phase:/i.test(line));
  const name = /^\s*Name:\s*(.+)$/i.exec(nameLine ?? "")?.[1]?.trim();
  const phase = /^\s*Phase:\s*(.+)$/i.exec(phaseLine ?? "")?.[1]?.trim();
  if (name !== expectedName || phase !== "Ready") {
    throw new Error(
      `Sandbox '${expectedName}' is not reusable for runtime identity apply: expected exact name and Ready phase, received ${boundedCommandError(output)}`,
    );
  }
}

function parseInferenceRouteBinding(output: string): InferenceRouteBinding | null {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  let inGatewayInference = false;
  let provider = "";
  let model = "";
  let timeoutSeconds: number | undefined;
  for (const line of lines) {
    if (/^(?:Gateway )?Inference:\s*$/i.test(line)) {
      inGatewayInference = true;
      continue;
    }
    if (inGatewayInference && /^\S.*:$/.test(line)) break;
    if (!inGatewayInference) continue;
    const trimmed = line.trim();
    const providerMatch = /^Provider:\s*(.+)$/i.exec(trimmed);
    const modelMatch = /^Model:\s*(.+)$/i.exec(trimmed);
    const timeoutMatch = /^Timeout:\s*(\d+)s?$/i.exec(trimmed);
    if (providerMatch) provider = providerMatch[1].trim();
    if (modelMatch) model = modelMatch[1].trim();
    if (timeoutMatch) timeoutSeconds = Number(timeoutMatch[1]);
  }
  return provider && model ? { provider, model, timeoutSeconds } : null;
}

function isUnconfiguredInferenceRoute(output: string): boolean {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^(?:Gateway )?Inference:\s*$/i.test(line));
  if (headingIndex < 0) return false;
  const routeLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^\S.*:$/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed) routeLines.push(trimmed);
  }
  return routeLines.length === 1 && routeLines[0]?.toLowerCase() === "not configured";
}

function isAction(value: string | undefined): value is Action {
  return value === "plan" || value === "apply" || value === "status" || value === "rollback";
}

// Redact credential-shaped output before bounding OpenShell stderr to a compact,
// single-line diagnostic. (#6703)
const MAX_COMMAND_ERROR_CHARS = 500;
const SENSITIVE_ERROR_ASSIGNMENT =
  /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*)[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function boundedCommandError(stderr: string, secretValues: readonly string[] = []): string {
  let redacted = stderr;
  for (const secret of [...new Set(secretValues)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("<REDACTED>");
  }
  redacted = redacted
    .replace(SENSITIVE_ERROR_ASSIGNMENT, "$1=<REDACTED>")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 <REDACTED>");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "no error output";
  return collapsed.length > MAX_COMMAND_ERROR_CHARS
    ? `${collapsed.slice(0, MAX_COMMAND_ERROR_CHARS)}…`
    : collapsed;
}

function readRollbackSandboxName(value: RollbackPlanSource | null): string {
  if (!value || typeof value.sandbox_name !== "string" || value.sandbox_name.trim() === "") {
    throw new Error("rollback plan sandbox_name must be a non-empty string");
  }

  // The persisted plan is untrusted input at this boundary too: validate before
  // the name reaches `openshell sandbox stop/remove`, mirroring the apply path.
  return assertValidName(value.sandbox_name, "sandbox name");
}

function readRollbackInferenceProviderName(value: RollbackPlanSource): string {
  if (
    !isPlainObject(value.inference) ||
    typeof value.inference.provider_name !== "string" ||
    value.inference.provider_name.trim() === ""
  ) {
    throw new Error(
      "rollback plan inference.provider_name must be a non-empty string for an owned provider",
    );
  }
  return assertValidProviderName(value.inference.provider_name, "rollback inference provider name");
}

function assertReusableInferenceProvider(
  output: string,
  expected: {
    name: string;
    type: string;
    requiresEndpointConfig: boolean;
    requiresCredential: boolean;
  },
): void {
  const metadata = parseRuntimeIdentityProviderMetadata(output);
  const hasExpectedConfigShape =
    !expected.requiresEndpointConfig || metadata?.configKeys.includes("OPENAI_BASE_URL") === true;
  const hasExpectedCredentialShape =
    !expected.requiresCredential || metadata?.credentialKeys.includes("OPENAI_API_KEY") === true;
  if (
    !metadata ||
    metadata.name !== expected.name ||
    metadata.type !== expected.type ||
    !hasExpectedConfigShape ||
    !hasExpectedCredentialShape
  ) {
    throw new Error(
      `Inference provider '${expected.name}' does not match the requested non-secret binding; refusing runtime identity apply`,
    );
  }
}

async function runCmd(
  args: string[],
  options?: { reject?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: options?.reject ?? true,
    stdout: "pipe",
    stderr: "pipe",
    env: buildSubprocessEnv(),
    extendEnv: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runRuntimeIdentityCommand(
  args: string[],
  options?: RuntimeIdentityCommandOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
    env: buildSubprocessEnv(options?.env),
    extendEnv: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runtimeIdentityCommandDeps(): RuntimeIdentityCommandDeps {
  return {
    run: runRuntimeIdentityCommand,
    formatError: boundedCommandError,
  };
}

function runtimeIdentityDeps(
  persistReceipt: (receipt: RuntimeIdentityReceipt) => void,
  profilePolicy?: RuntimeIdentityProfilePolicy,
): RuntimeIdentityDeps {
  return {
    ...runtimeIdentityCommandDeps(),
    validateEndpointUrl,
    persistReceipt,
    blueprintPath: process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".",
    env: process.env,
    profilePolicy,
  };
}

async function openshellAvailable(): Promise<boolean> {
  const result = await execa("which", ["openshell"], {
    reject: false,
    stdout: "pipe",
    env: buildSubprocessEnv(),
    extendEnv: false,
  });
  return result.exitCode === 0;
}

/**
 * Resolve inference config and sandbox config from a blueprint, applying
 * endpoint URL override and SSRF validation if provided.
 */
async function resolveRunConfig(
  profile: string,
  blueprint: Blueprint,
  endpointUrl?: string,
): Promise<{
  inferenceProfiles: InferenceProfileMap;
  inferenceCfg: InferenceProfile;
  sandboxCfg: SandboxConfig;
  routerCfg: RouterConfig;
}> {
  const inferenceProfiles = blueprint.components?.inference?.profiles ?? {};
  if (!(profile in inferenceProfiles)) {
    const available = Object.keys(inferenceProfiles).join(", ");
    throw new Error(`Profile '${profile}' not found. Available: ${available}`);
  }

  let inferenceCfg = { ...inferenceProfiles[profile] };
  if (endpointUrl) {
    const validated = await validateEndpointUrl(endpointUrl);
    inferenceCfg = { ...inferenceCfg, endpoint: safeEndpointUrlForDownstream(validated) };
  }

  // Validate the final endpoint (whether from CLI override or blueprint profile)
  if (inferenceCfg.endpoint) {
    const validated = await validateEndpointUrl(inferenceCfg.endpoint);
    inferenceCfg = { ...inferenceCfg, endpoint: safeEndpointUrlForDownstream(validated) };
  }

  const sandboxCfg = blueprint.components?.sandbox ?? {};
  const routerCfg = blueprint.components?.router ?? {};

  // A blueprint is untrusted input. Validate the identifiers that flow into
  // `openshell ... --name <value>` argv slots (and onward to shell scripts and
  // Kubernetes pod names) at this ingestion boundary and fail closed, so every
  // downstream consumer receives a name that is safe by construction. Absent
  // values fall back to validated defaults ("openclaw" / "default") at the use
  // sites and are intentionally not rejected here.
  if (sandboxCfg.name !== undefined) {
    assertValidName(sandboxCfg.name, "sandbox name");
  }
  if (inferenceCfg.provider_name !== undefined) {
    assertValidProviderName(inferenceCfg.provider_name);
  }

  return { inferenceProfiles, inferenceCfg, sandboxCfg, routerCfg };
}

// ── Actions ─────────────────────────────────────────────────────

export async function actionPlan(
  profile: string,
  blueprint: Blueprint,
  options?: { dryRun?: boolean; endpointUrl?: string },
): Promise<RunPlan> {
  const rid = emitRunId();
  writeRunProgress(10, "Validating blueprint");

  const { inferenceCfg, sandboxCfg, routerCfg } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  writeRunProgress(20, "Checking prerequisites");
  if (!(await openshellAvailable())) {
    throw new Error(
      "openshell CLI not found. Install OpenShell first.\n  See: https://github.com/NVIDIA/OpenShell",
    );
  }

  const plan = buildSafePublicRunPlan({
    runId: rid,
    profile,
    inferenceCfg,
    sandboxCfg,
    routerCfg,
    runtimeIdentityConfig: blueprint.components?.identity,
    policyAdditions: blueprint.components?.policy?.additions ?? {},
    dryRun: options?.dryRun ?? false,
  });

  writeRunProgress(100, "Plan complete");
  writeRunLog(JSON.stringify(plan, null, 2));
  return plan;
}

export async function actionApply(
  profile: string,
  blueprint: Blueprint,
  options?: {
    planPath?: string;
    endpointUrl?: string;
    /** Code-only conformance-test seam. No CLI flag or environment input populates this policy. */
    runtimeIdentityProfilePolicy?: RuntimeIdentityProfilePolicy;
  },
): Promise<void> {
  if (options?.planPath) {
    throw new Error(
      "--plan is not yet implemented. Run apply without --plan to use the live blueprint.",
    );
  }

  const rid = emitRunId();

  const { inferenceCfg, sandboxCfg } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  const sandboxName = sandboxCfg.name ?? "openclaw";
  const sandboxImage = sandboxCfg.image ?? "openclaw";
  const forwardPorts = sandboxCfg.forward_ports ?? [DASHBOARD_PORT];
  const policyAdditions = blueprint.components?.policy?.additions ?? {};
  const runtimeIdentityConfig = blueprint.components?.identity;
  const providerName = inferenceCfg.provider_name ?? "default";
  const providerType = inferenceCfg.provider_type ?? "openai";
  const endpoint = inferenceCfg.endpoint ?? "";
  const model = inferenceCfg.model ?? "";
  const credentialEnv = inferenceCfg.credential_env;
  const credentialDefault = inferenceCfg.credential_default ?? "";
  let credential = "";
  if (credentialEnv) {
    credential = process.env[credentialEnv] ?? credentialDefault;
  }
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });

  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  let sandboxCreatedByApply = false;
  let inferenceProviderCreatedByApply = false;
  const persistRunPlan = (): void => {
    writeFileSync(
      join(stateDir, "plan.json"),
      JSON.stringify(
        buildPersistedRunPlan({
          runId: rid,
          profile,
          sandboxName,
          sandboxCreatedByApply,
          inferenceProviderCreatedByApply,
          policyAdditions,
          inferenceCfg,
          runtimeIdentityReceipt,
          timestamp: new Date().toISOString(),
        }),
        null,
        2,
      ),
    );
  };
  const identityDeps = runtimeIdentityDeps((receipt) => {
    runtimeIdentityReceipt = receipt;
    persistRunPlan();
  }, options?.runtimeIdentityProfilePolicy);

  try {
    let reuseExistingSandbox = false;
    let reuseExistingInferenceProvider = false;
    let reuseExistingInferenceRoute = false;
    if (runtimeIdentityConfig) {
      const sandboxResult = await runCmd(["openshell", "sandbox", "get", sandboxName], {
        reject: false,
      });
      const sandboxOutput = `${sandboxResult.stderr}\n${sandboxResult.stdout}`;
      if (sandboxResult.exitCode === 0) {
        assertReusableRuntimeIdentitySandbox(sandboxResult.stdout, sandboxName);
        reuseExistingSandbox = true;
      } else if (!MISSING_SANDBOX_INSPECTION_PATTERN.test(sandboxOutput)) {
        throw new Error(
          `Failed to inspect sandbox '${sandboxName}' before runtime identity apply: ${boundedCommandError(sandboxOutput)}`,
        );
      }

      const providerResult = await runCmd(["openshell", "provider", "get", providerName], {
        reject: false,
      });
      const providerOutput = `${providerResult.stderr}\n${providerResult.stdout}`;
      if (providerResult.exitCode === 0) {
        assertReusableInferenceProvider(providerResult.stdout, {
          name: providerName,
          type: providerType,
          requiresEndpointConfig: endpoint !== "",
          requiresCredential: credential !== "",
        });
        reuseExistingInferenceProvider = true;
      } else if (!MISSING_PROVIDER_INSPECTION_PATTERN.test(providerOutput)) {
        throw new Error(
          `Failed to inspect inference provider '${providerName}' before runtime identity apply: ${boundedCommandError(providerOutput)}`,
        );
      }

      if (reuseExistingSandbox && reuseExistingInferenceProvider) {
        const routeResult = await runCmd(["openshell", "inference", "get"], {
          reject: false,
        });
        const routeOutput = `${routeResult.stderr}\n${routeResult.stdout}`;
        if (routeResult.exitCode !== 0) {
          throw new Error(
            `Failed to inspect the active inference route before runtime identity apply: ${boundedCommandError(routeOutput)}`,
          );
        }
        const activeRoute = parseInferenceRouteBinding(routeResult.stdout);
        if (!activeRoute && !isUnconfiguredInferenceRoute(routeResult.stdout)) {
          throw new Error(
            `Failed to parse the active inference route before runtime identity apply: ${boundedCommandError(routeOutput)}`,
          );
        }
        reuseExistingInferenceRoute =
          activeRoute?.provider === providerName &&
          activeRoute.model === model &&
          (inferenceCfg.timeout_secs === undefined ||
            activeRoute.timeoutSeconds === inferenceCfg.timeout_secs);
      }

      writeRunProgress(10, "Configuring runtime identity");
      // Establish durable state before the first identity mutation, then update
      // the receipt after each acquired resource.
      persistRunPlan();
      runtimeIdentityReceipt = await prepareRuntimeIdentity(runtimeIdentityConfig, identityDeps);
      persistRunPlan();
    }

    writeRunProgress(20, "Creating OpenClaw sandbox");
    if (reuseExistingSandbox) {
      writeRunLog(`Sandbox '${sandboxName}' already exists, reusing.`);
    } else {
      const createArgs = [
        "openshell",
        "sandbox",
        "create",
        "--from",
        sandboxImage,
        "--name",
        sandboxName,
      ];
      for (const port of forwardPorts) {
        createArgs.push("--forward", String(port));
      }

      const createResult = await runCmd(createArgs, { reject: false });
      sandboxCreatedByApply = createResult.exitCode === 0;
      if (sandboxCreatedByApply) {
        // Persist ownership immediately so a later-process rollback stays safe
        // if apply is interrupted before its final state write.
        persistRunPlan();
      }
      if (createResult.exitCode !== 0) {
        if (createResult.stderr.includes("already exists")) {
          if (runtimeIdentityConfig) {
            const racedSandbox = await runCmd(["openshell", "sandbox", "get", sandboxName], {
              reject: false,
            });
            if (racedSandbox.exitCode !== 0) {
              throw new Error(
                `Failed to inspect sandbox '${sandboxName}' after concurrent creation: ${boundedCommandError(`${racedSandbox.stderr}\n${racedSandbox.stdout}`)}`,
              );
            }
            assertReusableRuntimeIdentitySandbox(racedSandbox.stdout, sandboxName);
          }
          writeRunLog(`Sandbox '${sandboxName}' already exists, reusing.`);
        } else {
          throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
        }
      }
    }

    // Keep runtime credentials unattached until OpenShell accepts the
    // sandbox's requested inference route.
    writeRunProgress(50, "Configuring inference provider");
    if (reuseExistingInferenceProvider) {
      writeRunLog(`Provider '${providerName}' already exists, reusing.`);
    } else {
      const providerArgs = [
        "openshell",
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        providerType,
      ];
      // Pass the env-var NAME (not the value) to --credential; openshell reads the value from the env.
      // Scope the credential to the subprocess to avoid leaking into later commands.
      const credEnv: Record<string, string> = {};
      if (credential) {
        credEnv.OPENAI_API_KEY = credential;
        providerArgs.push("--credential", "OPENAI_API_KEY");
      }
      if (endpoint) {
        providerArgs.push("--config", `OPENAI_BASE_URL=${endpoint}`);
      }

      const providerResult = await execa(providerArgs[0], providerArgs.slice(1), {
        reject: false,
        stdout: "pipe",
        stderr: "pipe",
        env: buildSubprocessEnv(credEnv),
        extendEnv: false,
      });
      // A required mutation: a silently-ignored failure would persist plan.json and
      // report a ready sandbox that cannot perform inference. Mirror the
      // sandbox-create contract above — tolerate an already-existing provider as a
      // reuse (keeps re-apply idempotent) and fail on any other non-zero result.
      // The credential is passed via env (never argv); redact it from stderr before
      // surfacing bounded diagnostic context. (#6703)
      if (providerResult.exitCode !== 0) {
        if (providerResult.stderr.includes("already exists")) {
          if (runtimeIdentityConfig) {
            const racedProvider = await runCmd(["openshell", "provider", "get", providerName], {
              reject: false,
            });
            if (racedProvider.exitCode !== 0) {
              throw new Error(
                `Failed to inspect inference provider '${providerName}' after concurrent creation: ${boundedCommandError(`${racedProvider.stderr}\n${racedProvider.stdout}`)}`,
              );
            }
            assertReusableInferenceProvider(racedProvider.stdout, {
              name: providerName,
              type: providerType,
              requiresEndpointConfig: endpoint !== "",
              requiresCredential: credential !== "",
            });
          }
          writeRunLog(`Provider '${providerName}' already exists, reusing.`);
        } else {
          throw new Error(
            `Failed to create inference provider '${providerName}': ${boundedCommandError(providerResult.stderr, [credential])}`,
          );
        }
      } else {
        inferenceProviderCreatedByApply = true;
        // Persist ownership before a later route or policy mutation can fail.
        persistRunPlan();
      }
    }

    writeRunProgress(70, "Setting inference route");
    if (reuseExistingInferenceRoute) {
      writeRunLog(`Inference route '${providerName} / ${model}' is already active, reusing.`);
    } else {
      const inferenceArgs = [
        "openshell",
        "inference",
        "set",
        "--provider",
        providerName,
        "--model",
        model,
      ];
      if (inferenceCfg.timeout_secs !== undefined) {
        inferenceArgs.push("--timeout", String(inferenceCfg.timeout_secs));
      }
      const inferenceResult = await runCmd(inferenceArgs, { reject: false });
      // Another required mutation: without a routed provider the sandbox cannot
      // perform inference, so a non-zero result must abort the apply. (#6703)
      if (inferenceResult.exitCode !== 0) {
        throw new Error(
          `Failed to set inference route (provider '${providerName}', model '${model}'): ${boundedCommandError(inferenceResult.stderr)}`,
        );
      }
    }

    if (runtimeIdentityReceipt) {
      const attachmentSandbox = await runCmd(["openshell", "sandbox", "get", sandboxName], {
        reject: false,
      });
      if (attachmentSandbox.exitCode !== 0) {
        throw new Error(
          `Failed to inspect sandbox '${sandboxName}' immediately before runtime identity attachment: ${boundedCommandError(`${attachmentSandbox.stderr}\n${attachmentSandbox.stdout}`)}`,
        );
      }
      assertReusableRuntimeIdentitySandbox(attachmentSandbox.stdout, sandboxName);
      const attachmentCreated = await attachRuntimeIdentity(
        runtimeIdentityReceipt,
        sandboxName,
        identityDeps,
      );
      runtimeIdentityReceipt = {
        ...runtimeIdentityReceipt,
        attachment_created: attachmentCreated,
      };
      persistRunPlan();
      await mintRuntimeIdentityCredential(runtimeIdentityReceipt, identityDeps);
    }

    if (Object.keys(policyAdditions).length > 0) {
      writeRunProgress(78, "Applying policy additions");
      const currentPolicy = await runCmd(["openshell", "policy", "get", "--base", sandboxName], {
        reject: false,
      });
      if (currentPolicy.exitCode !== 0) {
        throw new Error(
          `Failed to read current policy before applying additions: ${currentPolicy.stderr}`,
        );
      }

      const mergedPolicyFile = join(stateDir, "merged-policy.yaml");
      writeFileSync(mergedPolicyFile, mergePolicyAdditions(currentPolicy.stdout, policyAdditions), {
        encoding: "utf-8",
        mode: 0o600,
      });

      const policySet = await runCmd(
        ["openshell", "policy", "set", "--policy", mergedPolicyFile, "--wait", sandboxName],
        { reject: false },
      );
      if (policySet.exitCode !== 0) {
        throw new Error(`Failed to apply policy additions: ${policySet.stderr}`);
      }
    }

    writeRunProgress(85, "Saving run state");
    persistRunPlan();

    writeRunProgress(100, "Apply complete");
    writeRunLog(`Sandbox '${sandboxName}' is ready.`);
    writeRunLog(`Inference: ${providerName} -> ${model} @ ${endpoint}`);
  } catch (error) {
    const cleanupFailures: string[] = [];
    if (runtimeIdentityReceipt) {
      try {
        await compensateRuntimeIdentityApply(runtimeIdentityReceipt, sandboxName, identityDeps);
        runtimeIdentityReceipt = {
          ...runtimeIdentityReceipt,
          provider_created: false,
          attachment_created: false,
        };
        persistRunPlan();
      } catch (cleanupError) {
        cleanupFailures.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
    }
    if (sandboxCreatedByApply) {
      await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });
      const remove = await runCmd(["openshell", "sandbox", "remove", sandboxName], {
        reject: false,
      });
      if (remove.exitCode === 0 || MISSING_SANDBOX_PATTERN.test(remove.stderr)) {
        sandboxCreatedByApply = false;
        persistRunPlan();
      } else {
        cleanupFailures.push(
          `Failed to remove sandbox '${sandboxName}': ${boundedCommandError(remove.stderr)}`,
        );
      }
    }
    if (inferenceProviderCreatedByApply && !sandboxCreatedByApply) {
      const removeProvider = await runCmd(["openshell", "provider", "delete", providerName], {
        reject: false,
      });
      if (
        removeProvider.exitCode === 0 ||
        MISSING_PROVIDER_INSPECTION_PATTERN.test(removeProvider.stderr)
      ) {
        inferenceProviderCreatedByApply = false;
        persistRunPlan();
      } else {
        cleanupFailures.push(
          `Failed to remove inference provider '${providerName}': ${boundedCommandError(removeProvider.stderr)}`,
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    if (cleanupFailures.length > 0) {
      throw new Error(`${message}; cleanup failed: ${cleanupFailures.join("; ")}`);
    }
    throw error;
  }
}

function validateRunId(rid: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(rid)) {
    throw new Error(
      `Invalid run ID: must contain only alphanumeric characters, hyphens, and underscores`,
    );
  }
}

function safeRunDir(runsDir: string, rid: string): string {
  validateRunId(rid);
  const resolved = join(runsDir, rid);
  if (!resolved.startsWith(runsDir + sep)) {
    throw new Error("Run ID resolves outside expected directory");
  }
  return resolved;
}

export function actionStatus(rid?: string): void {
  emitRunId();
  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");

  let runDir: string;
  if (rid) {
    runDir = safeRunDir(runsDir, rid);
  } else {
    let runs: string[];
    try {
      runs = readdirSync(runsDir).sort().reverse();
    } catch {
      writeRunLog("No runs found.");
      return;
    }
    if (runs.length === 0) {
      writeRunLog("No runs found.");
      return;
    }
    runDir = join(runsDir, runs[0]);
  }

  const name = runDir.split("/").pop() ?? "unknown";
  try {
    const planData = readFileSync(join(runDir, "plan.json"), "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const safePlan = buildStatusRunPlan(parsedPlan, name);
    if (!safePlan) {
      throw new Error("plan.json must contain a JSON object");
    }
    writeRunLog(JSON.stringify(safePlan, null, 2));
  } catch {
    writeRunLog(JSON.stringify({ run_id: name, status: "unknown" }));
  }
}

export async function actionRollback(rid: string): Promise<void> {
  emitRunId();

  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");
  const stateDir = safeRunDir(runsDir, rid);
  try {
    readdirSync(stateDir);
  } catch {
    throw new Error(`Run ${rid} not found.`);
  }

  const planFile = join(stateDir, "plan.json");
  let sandboxName: string;
  let sandboxCreatedByApply = false;
  let inferenceProviderCreatedByApply = false;
  let inferenceProviderName: string | undefined;
  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  try {
    const planData = readFileSync(planFile, "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const rollbackPlan: RollbackPlanSource | null =
      typeof parsedPlan === "object" && parsedPlan !== null && !Array.isArray(parsedPlan)
        ? parsedPlan
        : null;
    sandboxName = readRollbackSandboxName(rollbackPlan);
    sandboxCreatedByApply = rollbackPlan?.sandbox_created_by_apply === true;
    inferenceProviderCreatedByApply = rollbackPlan?.inference_provider_created_by_apply === true;
    if (inferenceProviderCreatedByApply) {
      inferenceProviderName = readRollbackInferenceProviderName(rollbackPlan!);
    }
    if (rollbackPlan?.identity !== undefined) {
      if (!isRuntimeIdentityReceipt(rollbackPlan.identity)) {
        throw new Error("identity ownership receipt is invalid");
      }
      runtimeIdentityReceipt = rollbackPlan.identity;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read rollback plan for run ${rid}: ${detail}`);
  }

  if (runtimeIdentityReceipt) {
    writeRunProgress(
      20,
      `Removing runtime identity provider ${runtimeIdentityReceipt.provider_name}`,
    );
    await removeRuntimeIdentity(runtimeIdentityReceipt, sandboxName, runtimeIdentityCommandDeps());
  }

  if (sandboxCreatedByApply) {
    writeRunProgress(30, `Stopping sandbox ${sandboxName}`);
    const stop = await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });

    writeRunProgress(60, `Removing sandbox ${sandboxName}`);
    const remove = await runCmd(["openshell", "sandbox", "remove", sandboxName], {
      reject: false,
    });
    if (remove.exitCode !== 0 && !MISSING_SANDBOX_PATTERN.test(remove.stderr)) {
      const stopFailure =
        stop.exitCode !== 0 && !MISSING_SANDBOX_PATTERN.test(stop.stderr)
          ? `; sandbox stop also failed: ${boundedCommandError(stop.stderr)}`
          : "";
      throw new Error(
        `Failed to remove owned sandbox '${sandboxName}': ${boundedCommandError(remove.stderr)}` +
          stopFailure,
      );
    }
  } else {
    writeRunProgress(60, `Preserving unowned sandbox ${sandboxName}`);
  }

  if (inferenceProviderCreatedByApply) {
    writeRunProgress(80, `Removing inference provider ${inferenceProviderName!}`);
    const removeProvider = await runCmd(
      ["openshell", "provider", "delete", inferenceProviderName!],
      { reject: false },
    );
    if (
      removeProvider.exitCode !== 0 &&
      !MISSING_PROVIDER_INSPECTION_PATTERN.test(removeProvider.stderr)
    ) {
      throw new Error(
        `Failed to remove owned inference provider '${inferenceProviderName!}': ${boundedCommandError(removeProvider.stderr)}`,
      );
    }
  }

  writeRunProgress(90, "Cleaning up run state");
  writeFileSync(join(stateDir, "rolled_back"), new Date().toISOString());

  writeRunProgress(100, "Rollback complete");
}

// ── CLI ─────────────────────────────────────────────────────────

export async function main(
  argv: string[] = process.argv.slice(2),
  options: {
    snapshotCommand?: SnapshotCommandOptions;
    /** Code-only conformance-test seam. No CLI flag or environment input populates this policy. */
    runtimeIdentityProfilePolicy?: RuntimeIdentityProfilePolicy;
  } = {},
): Promise<void> {
  const rawAction = argv.at(0);
  const action = isAction(rawAction) ? rawAction : undefined;
  let profile = "default";
  let planPath: string | undefined;
  let runId: string | undefined;
  let dryRun = false;
  let endpointUrl: string | undefined;

  function requireValue(flag: string, i: number): string {
    if (i >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i];
  }

  if (!action) {
    if (rawAction === "snapshots") {
      actionSnapshots(argv.slice(1), options.snapshotCommand);
      return;
    }
    throw new Error(
      `Unknown action '${rawAction ?? "(missing)"}'. Use: plan, apply, status, rollback, snapshots`,
    );
  }

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--profile":
        profile = requireValue("--profile", ++i);
        break;
      case "--plan":
        planPath = requireValue("--plan", ++i);
        break;
      case "--run-id":
        runId = requireValue("--run-id", ++i);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--endpoint-url":
        endpointUrl = requireValue("--endpoint-url", ++i);
        break;
    }
  }

  switch (action) {
    case "plan": {
      const blueprint = loadBlueprint();
      await actionPlan(profile, blueprint, { dryRun, endpointUrl });
      break;
    }
    case "apply": {
      const blueprint = loadBlueprint();
      await actionApply(profile, blueprint, {
        planPath,
        endpointUrl,
        runtimeIdentityProfilePolicy: options.runtimeIdentityProfilePolicy,
      });
      break;
    }
    case "status":
      actionStatus(runId);
      break;
    case "rollback":
      if (!runId) {
        throw new Error("--run-id is required for rollback");
      }
      await actionRollback(runId);
      break;
  }
}
