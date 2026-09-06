// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getRegisteredAgent } from "../agent/runtime";
import type { AgentDefinition } from "../agent-runtime/manifest-types";
import { formatEnvAssignment } from "../core/url-utils";
import { isPackageOwnedAgentDefinition } from "./docker-startup-command-agent";
import { appendExtraPlaceholderKeysEnvArg } from "./extra-placeholder-keys";
import { HERMES_API_PORT_ENV } from "./hermes-api-port";
import { appendHermesDashboardEnvArgs, type HermesDashboardOnboardState } from "./hermes-dashboard";
import { appendHostProxyEnvArgs } from "./host-proxy-env";
import { appendLegacyRuntimeEnvironment } from "./legacy-runtime";
import { isValidProxyHost, isValidProxyPort, resolveManagedProxyRoute } from "./proxy-route";

const STARTUP_COMMAND_TOKEN = /^[A-Za-z0-9_./:=,@%+\-\[\]]+$/u;

function appendAgentStartupEnvironment(envArgs: string[], agent: AgentDefinition | null): void {
  for (const [name, value] of Object.entries(agent?.runtime?.startup_environment ?? {})) {
    envArgs.push(formatEnvAssignment(name, value));
  }
}

function appendManagedProxyRoute(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (isPackageOwnedAgentDefinition(agent)) {
    const route = resolveManagedProxyRoute(env);
    if (!route) return;
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", route.host));
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", String(route.port)));
    return;
  }

  // Preserve the legacy explicit-only behavior for definitions that do not
  // come from an installed or authored package.
  const sandboxProxyHost = env.NEMOCLAW_PROXY_HOST;
  if (sandboxProxyHost && isValidProxyHost(sandboxProxyHost)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", sandboxProxyHost));
  }
  const sandboxProxyPort = env.NEMOCLAW_PROXY_PORT;
  if (sandboxProxyPort && isValidProxyPort(sandboxProxyPort)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", sandboxProxyPort));
  }
}

export interface SandboxRuntimeEnvArgsInput {
  agent: AgentDefinition | null;
  chatUiUrl: string;
  manageDashboard: boolean;
  getDashboardForwardPort(chatUiUrl: string): string;
  hermesDashboardState: HermesDashboardOnboardState;
  hermesApiPort?: number | null;
  extraPlaceholderKeys: readonly string[];
  allowHermesApiPortOverride?: boolean;
  observabilityEnabled?: boolean;
  sandboxName?: string;
  env: NodeJS.ProcessEnv;
  omitCredentialEnv?: boolean;
}

export function buildSandboxRuntimeEnvArgs(input: SandboxRuntimeEnvArgsInput): {
  envArgs: string[];
  effectiveDashboardPort: string;
} {
  const { agent, env, manageDashboard } = input;
  const envArgs = manageDashboard ? [formatEnvAssignment("CHAT_UI_URL", input.chatUiUrl)] : [];
  const effectiveDashboardPort = manageDashboard
    ? input.getDashboardForwardPort(input.chatUiUrl)
    : "0";
  if (manageDashboard) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));
    if (env.NEMOCLAW_DASHBOARD_BIND === "0.0.0.0") {
      envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0"));
    }
  }

  appendAgentStartupEnvironment(envArgs, agent);
  if (!isPackageOwnedAgentDefinition(agent)) {
    appendLegacyRuntimeEnvironment(envArgs, agent, env, input.observabilityEnabled === true);
  }
  appendHermesDashboardEnvArgs(envArgs, input.hermesDashboardState, formatEnvAssignment);
  if (input.hermesApiPort != null && input.sandboxName) {
    envArgs.push(formatEnvAssignment(HERMES_API_PORT_ENV, String(input.hermesApiPort)));
  }
  appendHostProxyEnvArgs(envArgs, env, {
    dropCredentialBearingProxyUrls:
      agent?.runtime?.kind === "terminal" || input.omitCredentialEnv === true,
  });

  appendManagedProxyRoute(envArgs, agent, env);
  if (input.sandboxName) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_SANDBOX_NAME", input.sandboxName));
  }
  if (!input.omitCredentialEnv) {
    appendExtraPlaceholderKeysEnvArg(envArgs, input.extraPlaceholderKeys, formatEnvAssignment);
  }
  return { envArgs, effectiveDashboardPort };
}

export function buildCurrentHermesPortableRuntimeEnvArgs(
  input: Omit<SandboxRuntimeEnvArgsInput, "agent">,
): ReturnType<typeof buildSandboxRuntimeEnvArgs> {
  return buildSandboxRuntimeEnvArgs({ ...input, agent: currentHermesPortableAgentDefinition() });
}

export function currentHermesPortableAgentDefinition(): AgentDefinition {
  const agent = getRegisteredAgent({ agent: "hermes" });
  if (!agent) throw new Error("The current Hermes agent manifest is unavailable.");
  return agent;
}

export function openshellSandboxCommandEnvValue(
  command: readonly string[] | null | undefined,
): string | null {
  const parts = (command || []).map(String);
  if (parts.length === 0) return null;
  if (parts.some((part) => part.length === 0 || /[\s\u0085]/u.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens cannot be empty or contain whitespace.",
    );
  }
  if (parts.some((part) => !STARTUP_COMMAND_TOKEN.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens contain unsupported shell metacharacters.",
    );
  }
  return parts.join(" ");
}
