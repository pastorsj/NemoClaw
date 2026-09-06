// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import type { AgentAliasTarget } from "../agent/aliases";
import { TOOL_DISCLOSURE_VALUES, type ToolDisclosure } from "../tool-disclosure";
import { describeAgentFlag } from "./agent-flag-help";
import { PORTABLE_EXPERIMENTAL_PROFILE } from "./docker-driver-platform";
import { NOTICE_ACCEPT_FLAG, NOTICE_ACCEPT_FLAG_NAME } from "./usage-notice";

export interface OnboardAgentRegistryEntry extends AgentAliasTarget {
  readonly displayName: string;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
}

type AgentRegistryReader = () => readonly OnboardAgentRegistryEntry[];

let agentRegistryReaderForTest: AgentRegistryReader | null = null;

export function setAgentRegistryReaderForTest(reader: AgentRegistryReader | null): void {
  agentRegistryReaderForTest = reader;
}

function registryEntry(record: {
  readonly id: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly aliasSummary: string | null;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
}): OnboardAgentRegistryEntry {
  return Object.freeze({
    name: record.id,
    displayName: record.displayName,
    aliases: record.aliases,
    aliasSummary: record.aliasSummary,
    isDefaultOnboardingChoice: record.isDefaultOnboardingChoice,
    defaultSandboxName: record.defaultSandboxName,
  });
}

function packageInventory() {
  const { listHarnessPackageInventory } =
    require("../agent-runtime/package/catalog") as typeof import("../agent-runtime/package/catalog");
  return listHarnessPackageInventory();
}

function orderRegistryEntries(
  entries: readonly OnboardAgentRegistryEntry[],
): readonly OnboardAgentRegistryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDefaultOnboardingChoice !== right.isDefaultOnboardingChoice) {
      return left.isDefaultOnboardingChoice ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/** Read only packages whose active receipt and installed tree pass integrity checks. */
export function readInstalledAgentRegistryEntries(): readonly OnboardAgentRegistryEntry[] {
  if (agentRegistryReaderForTest) return orderRegistryEntries(agentRegistryReaderForTest());
  return orderRegistryEntries(
    packageInventory().installed.flatMap((record) =>
      record.state === "installed" ? [registryEntry(record)] : [],
    ),
  );
}

/**
 * Read every selector that onboarding can explain: reviewed packages may
 * produce install guidance, while installed-only packages proceed from their
 * verified receipt. Installed metadata wins for an active package identity.
 */
export function readSelectableAgentRegistryEntries(): readonly OnboardAgentRegistryEntry[] {
  const inventory = packageInventory();
  const entries = new Map(
    inventory.available.map((record) => [record.id, registryEntry(record)] as const),
  );
  for (const record of inventory.installed) entries.set(record.id, registryEntry(record));
  return orderRegistryEntries([...entries.values()]);
}

export function readAgentRegistryNames(): readonly string[] {
  return readInstalledAgentRegistryEntries().map(({ name }) => name);
}

// Read installed package metadata lazily because oclif constructs static flag
// help while loading the command class. If the catalogue is unavailable, keep
// the command loadable and show the generic description (#5779).
function agentFlagDescription(): string {
  try {
    const entries = readInstalledAgentRegistryEntries();
    return describeAgentFlag(
      entries.map(({ name }) => name),
      entries,
    );
  } catch {
    return describeAgentFlag([]);
  }
}

export const onboardUsage = [
  `onboard [--profile <name>] [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--apf-interceptor] [--gpu | --no-gpu] [--from <Dockerfile>] [--name <sandbox>] [--host-mount <host:/sandbox/path>] [--sandbox-gpu | --no-sandbox-gpu] [--sandbox-gpu-device <device>] [--vllm-gpu-device <index-or-uuid>] [--agent <name>] [--agents <agents.yaml>] [--tool-disclosure <progressive|direct>] [--observability | --no-observability] [--control-ui-port <N>] [--events=jsonl] [--yes | -y] [--no-ollama-autostart] [${NOTICE_ACCEPT_FLAG}]`,
];

export const onboardExamples = [
  "<%= config.bin %> onboard",
  "<%= config.bin %> onboard --name alpha",
  "<%= config.bin %> onboard --resume",
  "<%= config.bin %> onboard --fresh",
  "<%= config.bin %> onboard --profile <profile-id>",
  "<%= config.bin %> onboard --from ./Dockerfile --name alpha",
  "<%= config.bin %> onboard --name alpha --host-mount /home/user/project:/sandbox/project",
  "<%= config.bin %> onboard --agents ./agents.yaml",
  "<%= config.bin %> onboard --sandbox-gpu --sandbox-gpu-device nvidia.com/gpu=0",
  `<%= config.bin %> onboard --non-interactive --yes --name alpha ${NOTICE_ACCEPT_FLAG}`,
];

export type OnboardFlags = {
  "temp-managed-runtime"?: boolean;
  "temp-managed-runtime-catalog"?: string;
  "non-interactive"?: boolean;
  resume?: boolean;
  fresh?: boolean;
  "recreate-sandbox"?: boolean;
  "apf-interceptor"?: boolean;
  gpu?: boolean;
  "no-gpu"?: boolean;
  from?: string;
  name?: string;
  "host-mount"?: string[];
  "sandbox-gpu"?: boolean;
  "no-sandbox-gpu"?: boolean;
  "sandbox-gpu-device"?: string;
  "vllm-gpu-device"?: string;
  agent?: string;
  agents?: string;
  "tool-disclosure"?: ToolDisclosure;
  observability?: boolean;
  "control-ui-port"?: number;
  events?: "jsonl";
  yes?: boolean;
  "no-ollama-autostart"?: boolean;
  "experimental-profile"?: string;
  profile?: string;
  [NOTICE_ACCEPT_FLAG_NAME]?: boolean;
};

export function buildOnboardFlags(options: { includeEvents?: boolean } = {}): Record<string, any> {
  const flags = {
    "temp-managed-runtime": Flags.boolean({ hidden: true }),
    "temp-managed-runtime-catalog": Flags.string({ hidden: true }),
    "non-interactive": Flags.boolean({ description: "Run without interactive prompts" }),
    resume: Flags.boolean({
      description: "Resume an interrupted onboarding session",
      exclusive: ["fresh"],
    }),
    fresh: Flags.boolean({
      description: "Ignore any saved onboarding session",
      exclusive: ["resume"],
    }),
    "recreate-sandbox": Flags.boolean({ description: "Delete and recreate an existing sandbox" }),
    "apf-interceptor": Flags.boolean({
      description:
        "Create a providerless sandbox without a caller policy and require a contained sandbox-scoped policy without claiming its provenance",
      exclusive: ["resume", "recreate-sandbox"],
    }),
    gpu: Flags.boolean({
      description: "Require OpenShell GPU passthrough for the gateway and sandbox",
      exclusive: ["no-gpu", "no-sandbox-gpu"],
    }),
    "no-gpu": Flags.boolean({
      description: "Disable GPU passthrough even when an NVIDIA GPU is detected",
      exclusive: ["gpu", "sandbox-gpu"],
    }),
    from: Flags.string({ description: "Path to a Dockerfile to use as the sandbox image source" }),
    name: Flags.string({ description: "Sandbox name" }),
    "host-mount": Flags.string({
      description:
        "Expose an existing absolute host directory read-only below /sandbox (repeatable)",
      multiple: true,
    }),
    "sandbox-gpu": Flags.boolean({
      description: "Enable direct NVIDIA GPU access inside the sandbox",
      exclusive: ["no-gpu", "no-sandbox-gpu"],
    }),
    "no-sandbox-gpu": Flags.boolean({
      description:
        "Force CPU sandbox behavior (equivalent to NEMOCLAW_SANDBOX_GPU=0; alternative to --no-gpu when Docker Desktop WSL CDI injection fails)",
      exclusive: ["gpu", "sandbox-gpu"],
    }),
    "sandbox-gpu-device": Flags.string({
      description: "NVIDIA GPU index, UUID, or CDI device name; requires --sandbox-gpu",
      dependsOn: ["sandbox-gpu"],
    }),
    "vllm-gpu-device": Flags.string({
      description: "GPU index or UUID for the host-side vLLM container managed by NemoClaw",
    }),
    agent: Flags.string({ description: agentFlagDescription() }),
    agents: Flags.string({
      description:
        "Path to a YAML manifest declaring secondary OpenClaw agents, agents.defaults, and main-agent overrides; baked into the sandbox image",
    }),
    "tool-disclosure": Flags.string({
      description:
        "Choose progressive tool discovery or direct exposure of all session-authorized tools",
      options: [...TOOL_DISCLOSURE_VALUES],
    }),
    observability: Flags.boolean({
      allowNo: true,
      description:
        "Export bounded prompt, response, tool argument, and tool result content to a local OTLP collector (Deep Agents Code only)",
    }),
    "control-ui-port": Flags.integer({
      description: "Host port for the local control UI",
      max: 65535,
      min: 1024,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Auto-confirm prompts that are safe for unattended onboarding",
    }),
    "no-ollama-autostart": Flags.boolean({
      description:
        "Skip the wizard's eager Ollama auto-start during inference-provider selection so onboard surfaces the unreachable-Ollama warning and the default fallback model; later setup steps still expect a reachable Ollama, and on Linux/systemd hosts the loopback-override path may still restart the daemon",
    }),
    "experimental-profile": Flags.string({
      hidden: true,
      options: [PORTABLE_EXPERIMENTAL_PROFILE],
      exclusive: ["profile"],
    }),
    profile: Flags.string({
      description: "Select a serving profile shown by `nemoclaw profiles list`",
      exclusive: ["experimental-profile"],
    }),
    [NOTICE_ACCEPT_FLAG_NAME]: Flags.boolean({
      description: "Accept the third-party software notice",
    }),
  } as Record<string, any>;
  if (options.includeEvents) {
    flags.events = Flags.string({
      description: "Emit versioned read-only onboarding events as JSON Lines on stdout",
      options: ["jsonl"],
    });
  }
  return flags;
}
