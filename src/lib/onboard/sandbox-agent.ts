// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { createImmutableAgentDefinition, loadAgent, loadAgentFresh } from "../agent/defs";
import { isCandidateAgent } from "../agent/candidate";
import { buildAgentDefinition } from "../agent/definition-loader";
import { getVersion } from "../core/version";
import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../harness/package-identity";
import {
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
} from "../harness/package-store";
import { getNameValidationGuidance, NAME_ALLOWED_FORMAT } from "../name-validation";
import { validateName } from "../runner";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";

// Names that collide with CLI command namespaces. A sandbox named 'status'
// makes 'nemoclaw status connect' route to the global status command
// instead of the sandbox, and a sandbox named 'sandbox' collides with the
// oclif-native `nemoclaw sandbox ...` command namespace. Reject these wherever
// a sandbox name enters the system (interactive prompt, --name flag,
// NEMOCLAW_SANDBOX_NAME).
export const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "update",
  "credentials",
  "help",
  "sandbox",
]);

export const UNKNOWN_SANDBOX_AGENT_NAME = "unknown";
const SANDBOX_AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function normalizeSandboxAgentName(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

export function getRequestedSandboxAgentName(agent: AgentDefinition | null | undefined): string {
  return normalizeSandboxAgentName(agent?.name);
}

export function formatSandboxAgentName(agentName: string | null | undefined): string {
  const normalized = normalizeSandboxAgentName(agentName);
  if (normalized === "openclaw") return "OpenClaw";
  if (normalized === "hermes") return "Hermes";
  if (normalized === "langchain-deepagents-code") return "LangChain Deep Agents Code";
  return normalized;
}

export function getDefaultSandboxNameForAgent(agent: AgentDefinition | null | undefined): string {
  const requestedAgent = getRequestedSandboxAgentName(agent);
  if (requestedAgent === "hermes") return "hermes";
  if (requestedAgent === "langchain-deepagents-code") return "deepagents-code";
  return "my-assistant";
}

export function getSandboxPromptDefault(agent: AgentDefinition | null | undefined): string {
  const envName = (process.env.NEMOCLAW_SANDBOX_NAME || "").trim().toLowerCase();
  const agentDefault = getDefaultSandboxNameForAgent(agent);
  if (!envName) return agentDefault;
  try {
    return validateName(envName, "sandbox name");
  } catch {
    return agentDefault;
  }
}

export function getEffectiveSandboxAgent(
  agent: AgentDefinition | null | undefined,
): AgentDefinition {
  return agent || loadAgent("openclaw");
}

export function getAgentInferenceProviderOptions(
  agent: AgentDefinition | null | undefined,
): string[] {
  const effectiveAgent = agent ?? loadAgent("openclaw");
  return Array.isArray(effectiveAgent.inferenceProviderOptions)
    ? effectiveAgent.inferenceProviderOptions
    : [];
}

/**
 * Resolve the running NemoClaw build fingerprint stamped onto a freshly created
 * or rebuilt sandbox image. Falls back to null when the version cannot be
 * resolved so a transient failure never blocks registration; image-drift
 * detection is simply skipped for that sandbox until its next rebuild (#5026).
 */
export function getNemoclawBuildFingerprint(): string | null {
  try {
    return getVersion();
  } catch {
    return null;
  }
}

export function getSandboxAgentRegistryFields(
  agent: AgentDefinition | null | undefined,
  agentVersionKnown = true,
): Pick<SandboxEntry, "agent" | "agentVersion" | "nemoclawVersion"> {
  const effectiveAgent = getEffectiveSandboxAgent(agent);
  const agentName = normalizeSandboxAgentName(effectiveAgent.name);
  return {
    agent: agentName === "openclaw" ? null : agentName,
    agentVersion: agentVersionKnown ? effectiveAgent.expectedVersion || null : null,
    // Stamp the NemoClaw build that produced this image, but ONLY for
    // NemoClaw-managed images. `agentVersionKnown` is `!fromDockerfile` at the
    // onboard call sites, so it doubles as "this is a managed image."
    // Custom-image sandboxes (`--from`) are not defined by NemoClaw's build and
    // are intentionally left without a fingerprint, so `upgrade-sandboxes` never
    // auto-rebuilds them onto the default image. The reuse path
    // (updateReusedSandboxMetadata) picks only `.agent` from these fields, so a
    // reused (un-rebuilt) sandbox keeps its original fingerprint rather than
    // being silently re-stamped as current. (#5026)
    nemoclawVersion: agentVersionKnown ? getNemoclawBuildFingerprint() : null,
  };
}

export function getSandboxAgentDrift(
  sandboxName: string,
  requestedAgentName: string,
): { changed: boolean; existingAgentName: string; requestedAgentName: string } {
  const existingEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
  if (!existingEntry) {
    return {
      changed: true,
      existingAgentName: UNKNOWN_SANDBOX_AGENT_NAME,
      requestedAgentName,
    };
  }
  const existingAgentName = normalizeSandboxAgentName(existingEntry?.agent);
  return {
    changed: existingAgentName !== requestedAgentName,
    existingAgentName,
    requestedAgentName,
  };
}

export interface ResolvedSandboxAgent {
  readonly recordedAgent: string | null;
  readonly effectiveAgentId: string;
  readonly definition: AgentDefinition;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

export interface ResolveSandboxAgentOptions extends HarnessPackageStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
}

function sandboxAgentAuthorityError(message: string): Error {
  return new Error(`Sandbox agent authority is invalid: ${message}`);
}

function isRepositoryQualifiedAgent(agentId: string): boolean {
  return agentId === "nemocua" || isCandidateAgent(agentId);
}

function requireRecordedSandboxAgent(agent: unknown): string | null {
  if (agent === null || agent === undefined) return null;
  if (typeof agent !== "string" || !SANDBOX_AGENT_ID_PATTERN.test(agent)) {
    throw sandboxAgentAuthorityError(
      "the recorded agent must be null or a canonical lowercase hyphen-separated identifier",
    );
  }
  return agent;
}

/** Resolve one sandbox from its durable, exact agent authority. */
export function resolveSandboxAgent(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: ResolveSandboxAgentOptions = {},
): ResolvedSandboxAgent {
  const recordedAgent = requireRecordedSandboxAgent(entry.agent);
  const effectiveAgentId = normalizeSandboxAgentName(recordedAgent);
  const packageState = inspectHarnessPackageState(
    entry.harnessPackage,
    entry.harnessPackageMigration,
  );

  if (isRepositoryQualifiedAgent(effectiveAgentId)) {
    if (packageState.status !== "absent") {
      throw sandboxAgentAuthorityError(
        `qualified agent '${effectiveAgentId}' must not carry harness package authority`,
      );
    }
    return Object.freeze({
      recordedAgent,
      effectiveAgentId,
      definition: loadAgentFresh(effectiveAgentId, options.env ?? process.env),
      harnessPackage: null,
      harnessPackageMigration: null,
    });
  }

  if (packageState.status === "absent") {
    throw sandboxAgentAuthorityError(
      `agent '${effectiveAgentId}' requires legacy package migration before use`,
    );
  }
  if (packageState.status === "invalid") {
    throw sandboxAgentAuthorityError("the recorded harness package identity is malformed");
  }
  if (packageState.harnessPackage.id !== effectiveAgentId) {
    throw sandboxAgentAuthorityError("the recorded agent does not match its harness package");
  }

  const installed = resolvePinnedHarnessPackage(packageState.harnessPackage, {
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
  });
  const definition = createImmutableAgentDefinition(
    buildAgentDefinition({
      manifest: installed.packageManifest.manifest,
      manifestPath: installed.packageManifest.manifestPath,
      packageRoot: installed.packageRoot,
    }),
  );
  if (definition.name !== effectiveAgentId || definition.packageRoot !== installed.packageRoot) {
    throw sandboxAgentAuthorityError("the installed definition does not match its package receipt");
  }

  return Object.freeze({
    recordedAgent,
    effectiveAgentId,
    definition,
    harnessPackage: packageState.harnessPackage,
    harnessPackageMigration: packageState.harnessPackageMigration,
  });
}

/**
 * Resolve the durable owner that may authorize one legacy backup manifest.
 *
 * Legacy manifests predate package identity, so callers must first prove that
 * the current registry row still resolves to its qualified repository agent or
 * to the exact installed package recorded by its migration receipt.
 */
export function resolveLegacyBackupRecoveryOwner(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: ResolveSandboxAgentOptions = {},
): string | null {
  const authority = resolveSandboxAgent(entry, options);
  if (authority.harnessPackage === null) return authority.recordedAgent;
  if (
    authority.harnessPackageMigration === null ||
    authority.harnessPackageMigration.legacyAgent !== authority.recordedAgent
  ) {
    throw sandboxAgentAuthorityError(
      "legacy backup owner is missing exact legacy-current-bundle migration provenance",
    );
  }
  return authority.recordedAgent;
}

export interface PromptSandboxNameDeps {
  promptOrDefault(question: string, envVar: string, defaultValue: string): Promise<string>;
  cliDisplayName(): string;
  isNonInteractive(): boolean;
  checkpointSandboxName(sandboxName: string, agent: AgentDefinition | null): Promise<void>;
  exit(code: number): never;
}

export function createPromptValidatedSandboxName(deps: PromptSandboxNameDeps) {
  return async function promptValidatedSandboxName(
    agent: AgentDefinition | null = null,
    previousName: string | null = null,
  ) {
    const MAX_ATTEMPTS = 3;
    const defaultSandboxName = previousName ?? getSandboxPromptDefault(agent);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const nameAnswer = await deps.promptOrDefault(
        `  Sandbox name (${NAME_ALLOWED_FORMAT}) [${defaultSandboxName}]: `,
        "NEMOCLAW_SANDBOX_NAME",
        defaultSandboxName,
      );
      const sandboxName = (nameAnswer || defaultSandboxName).trim();

      let validatedSandboxName: string;
      try {
        validatedSandboxName = validateName(sandboxName, "sandbox name");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`  ${errorMessage}`);
        for (const line of getNameValidationGuidance("sandbox name", sandboxName, {
          includeAllowedFormat: false,
        })) {
          console.error(`  ${line}`);
        }

        // Non-interactive runs cannot re-prompt — abort so the caller can fix the
        // NEMOCLAW_SANDBOX_NAME env var and retry.
        if (deps.isNonInteractive()) {
          deps.exit(1);
        }

        if (attempt < MAX_ATTEMPTS - 1) {
          console.error("  Please try again.\n");
        }
        continue;
      }

      if (RESERVED_SANDBOX_NAMES.has(sandboxName)) {
        console.error(
          `  Reserved name: '${sandboxName}' is a ${deps.cliDisplayName()} CLI command.`,
        );
        console.error("  Choose a different name to avoid routing conflicts.");
        if (deps.isNonInteractive()) {
          deps.exit(1);
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          console.error("  Please try again.\n");
        }
        continue;
      }

      await deps.checkpointSandboxName(validatedSandboxName, agent);
      return validatedSandboxName;
    }

    console.error("  Too many invalid attempts.");
    deps.exit(1);
  };
}
