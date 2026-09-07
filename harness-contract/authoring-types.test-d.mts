// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessAgentRosterAdapterModule,
  HarnessAgentRosterCapability,
  HarnessAgentManifest,
  HarnessDashboardUiDeclaration,
  HarnessInferenceContextWindowRequirement,
  HarnessMcpAdapterCommandPlan,
  HarnessMcpAdapterIdentifier,
  HarnessMcpCapability,
  HarnessManagedImageDeclaration,
  HarnessMessagingBuildRuntimeProfile,
  HarnessMessagingCredentialProvider,
  HarnessMessagingHookOperation,
  HarnessMessagingRuntimeProfile,
  HarnessPackageEnvelope,
  HarnessPolicyCapability,
  HarnessProviderAuthCapability,
  HarnessToolGatewayCapability,
  HarnessRuntimeCommandDeclaration,
  HarnessSemanticTurnDeclaration,
  HarnessSemanticTurnEvent,
  HarnessSemanticTurnRequest,
  HarnessStructuredTurnEnvelope,
  HarnessSelectionQualificationDeclaration,
  HarnessSandboxDockerUlimitDeclaration,
  HarnessSandboxStartupControl,
  HarnessSandboxTmpfsMountDeclaration,
} from "./src/index.js";

const structuredTurnEnvelope = {
  status: "ok",
  result: {
    payloads: [{ text: "complete" }],
    meta: {},
  },
} satisfies HarnessStructuredTurnEnvelope;

void structuredTurnEnvelope;

const agentRosterCapability = {
  support: "managed",
  adapter: "agent-roster",
  onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
} satisfies HarnessAgentRosterCapability;

const agentRosterAdapter = {
  buildAgentRosterCommand(request) {
    return { kind: "stream", command: ["future-harness", "agents", request.operation] };
  },
  buildAgentRosterInspection() {
    return { kind: "capture", command: ["future-harness", "agents", "inspect"] };
  },
  buildAgentRosterApplyPlan() {
    return {
      kind: "ready",
      current_count: 0,
      additions: [],
      deletions: [],
      rebuild_only_fields: [],
      notices: [],
    };
  },
} satisfies HarnessAgentRosterAdapterModule;

void agentRosterCapability;
void agentRosterAdapter;

const dashboardUi = {
  label: "Future dashboard",
  path: "/console",
  port: 9120,
  enable_env: "FUTURE_DASHBOARD_ENABLED",
  port_env: "FUTURE_DASHBOARD_PORT",
  internal_port: 19120,
  internal_port_env: "FUTURE_DASHBOARD_INTERNAL_PORT",
  tui_env: "FUTURE_DASHBOARD_TUI",
} satisfies HarnessDashboardUiDeclaration;

void dashboardUi;

const selectionQualification = {
  command: ["/usr/local/bin/future-selection-qualify"],
  timeout_seconds: 30,
} satisfies HarnessSelectionQualificationDeclaration;

void selectionQualification;

const semanticTurn = {
  support: "managed",
  command: ["/usr/local/bin/future-semantic-turn"],
  timeout_seconds: 120,
  protocol: "semantic-turn-ndjson",
} satisfies HarnessSemanticTurnDeclaration;

const semanticTurnRequest = {
  type: "turn",
  message: "summarize the repository",
  conversationKey: "nemoclaw:conversation",
  runtimeTarget: "primary",
  idempotencyKey: "turn-identifier",
} satisfies HarnessSemanticTurnRequest;

const semanticTurnEvents = [
  { type: "started" },
  { type: "text", text: "ready" },
  { type: "completed" },
] satisfies readonly HarnessSemanticTurnEvent[];

void semanticTurn;
void semanticTurnRequest;
void semanticTurnEvents;

const messagingCredentialProvider = {
  profilePath: "provider-profiles/future.yaml",
  profileId: "future-messaging-static",
  credentialEnv: "FUTURE_MESSAGING_TOKEN",
  sourceInputId: "token",
} satisfies HarnessMessagingCredentialProvider;

void messagingCredentialProvider;

const messagingBuildRuntimeProfile = {
  packageId: "future-harness",
  channelsPath: "profile.json",
  build: { configRoot: "~/.future-harness", packageManagers: [] },
} satisfies HarnessMessagingBuildRuntimeProfile;
const messagingChannelRuntimeProfile = {
  channelName: "future-channel",
  visibility: { configKeys: [], logPatterns: [] },
} satisfies HarnessMessagingRuntimeProfile;
// @ts-expect-error Build runtime identity must never merge into the per-channel runtime profile.
const mergedMessagingRuntimeProfile: HarnessMessagingRuntimeProfile = messagingBuildRuntimeProfile;
void messagingBuildRuntimeProfile;
void messagingChannelRuntimeProfile;
void mergedMessagingRuntimeProfile;

const messagingHookOperations = [
  {
    hookId: "future-config",
    kind: "config-prompt",
    outputIds: ["allowFrom"],
  },
  {
    hookId: "future-status",
    kind: "sandbox-command",
    command: { argv: ["future-harness", "channel-status"] },
    output: "channel-health",
    context: "channel-health",
  },
  {
    hookId: "future-build",
    kind: "build-files",
    inputIds: ["accountId"],
    outputs: [
      {
        id: "accountFile",
        pathTemplate: "accounts/{{input:accountId}}.json",
        content: { accountId: { $input: "accountId" } },
      },
    ],
  },
] satisfies readonly HarnessMessagingHookOperation[];

void messagingHookOperations;

const packageEnvelope = {
  schemaVersion: 1,
  kind: "agent-runtime",
  id: "future-harness",
  displayName: "Future Harness",
  packageVersion: "1.0.0",
  minimumNemoClawVersion: "0.0.113",
  maximumNemoClawVersionExclusive: "0.0.121",
  manifest: "manifest.yaml",
} satisfies HarnessPackageEnvelope;

// @ts-expect-error A package must declare both ends of its compatibility window.
const packageEnvelopeWithoutMaximum: HarnessPackageEnvelope = {
  schemaVersion: 1,
  kind: "agent-runtime",
  id: "future-harness",
  displayName: "Future Harness",
  packageVersion: "1.0.0",
  minimumNemoClawVersion: "0.0.113",
  manifest: "manifest.yaml",
};

const manifestFields = {
  name: "future-harness",
  agent_roster: agentRosterCapability,
  config: {
    dir: "/sandbox/.future-harness",
    config_file: "config.json",
    format: "json",
  },
  inference: {
    config_update: {
      support: "unsupported",
      reason: "This synthetic package has fixed inference configuration.",
    },
    route_probe: { rebuild_preflight: "inference-invocation" },
  },
  messaging: { support: "disabled" },
  policy: {
    owned_presets: [],
    automatic_presets: [],
    baseline_exclusion_impacts: {},
  },
  state_lifecycle: {
    backup_quiescence: { kind: "not-required" },
    snapshot_restore: [],
    rebuild: {
      managed_extensions: {
        support: "disabled",
        reason: "This package has no managed extensions.",
      },
      scheduled_work: { support: "disabled", reason: "No scheduled work." },
      post_restore: { kind: "not-required" },
    },
  },
} as const;

const terminalManifest = {
  ...manifestFields,
  sandbox_create: {
    startup_controls: ["approval-mode", "observability"],
    docker_ulimits: [{ name: "nofile", soft: 4096, hard: 8192 }],
  },
  runtime: {
    kind: "terminal",
    headless_command: "future-harness --prompt",
    prompt_transport: "stdin",
    prompt_protocol: "raw-stdin",
  },
} satisfies HarnessAgentManifest;

const pairingManifest = {
  ...manifestFields,
  device_pairing: true,
  gateway_command: "future-harness gateway run",
  health_probe: {
    url: "http://127.0.0.1:19090/health",
    port: 19_090,
    timeout_seconds: 30,
  },
  managed_image: {
    repository: "registry.example.test/future/harness",
    architectures: ["linux/amd64"],
    runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
  },
  runtime: {
    kind: "gateway",
    interactive_command: "future-harness",
    process_lifecycle: {
      support: "managed",
      command: ["/usr/local/bin/future-process-control"],
    },
    device_pairing_settlement: {
      command: ["/usr/local/bin/future-pairing-settle"],
      timeout_seconds: 30,
    },
    session_qualification: {
      command: ["/usr/local/bin/future-session-qualify"],
      timeout_seconds: 30,
    },
  },
} satisfies HarnessAgentManifest;

const mcpBridge = {
  support: "bridge",
  adapter: "future-harness",
  policy_binaries: ["/usr/local/bin/future-harness"],
} satisfies HarnessMcpCapability;

const mcpAdapterIdentifier = "future-harness" satisfies HarnessMcpAdapterIdentifier;
const mcpArgvCommand = {
  kind: "argv",
  argv: ["future-harness", "mcp", "probe"],
} satisfies HarnessMcpAdapterCommandPlan;
const mcpShellCommand = {
  kind: "shell",
  script: "future-harness mcp probe",
  shellTrust: "package-authored-code",
} satisfies HarnessMcpAdapterCommandPlan;

// @ts-expect-error Adapter identifiers are lowercase so manifest and durable-state keys agree.
const uppercaseMcpAdapterIdentifier: HarnessMcpAdapterIdentifier = "Future-Harness";

// @ts-expect-error Shell execution must declare its package-authored trust boundary.
const untrustedMcpShellCommand: HarnessMcpAdapterCommandPlan = {
  kind: "shell",
  script: "future-harness mcp probe",
};

// @ts-expect-error Raw command strings do not identify an execution transport.
const rawMcpCommand: HarnessMcpAdapterCommandPlan = "future-harness mcp probe";

const tmpfsMount = {
  type: "tmpfs",
  drivers: ["docker"],
  target: "/run/future-harness",
  options: ["noexec"],
  size_bytes: 1_048_576,
  mode: 0o1777,
} satisfies HarnessSandboxTmpfsMountDeclaration;

const startupControl = "approval-mode" satisfies HarnessSandboxStartupControl;
const dockerUlimit = {
  name: "nofile",
  soft: 4096,
  hard: 8192,
} satisfies HarnessSandboxDockerUlimitDeclaration;

// @ts-expect-error Startup controls are a finite core-consumed vocabulary.
const unknownStartupControl: HarnessSandboxStartupControl = "automatic";

const stringDockerUlimit: HarnessSandboxDockerUlimitDeclaration = {
  name: "nofile",
  // @ts-expect-error Docker limit values are numeric declarations.
  soft: "4096",
  hard: 8192,
};

const packagePublishedImage = {
  repository: "registry.example/team/future-harness",
  architectures: ["linux/amd64"],
  runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
  publication: {
    source: {
      repository: "ExampleOrg/future-harness",
      revision: "a".repeat(40),
      release: "v1.2.3",
      cohort: "build-42",
    },
    digests: { "linux/amd64": `sha256:${"ab".repeat(32)}` },
  },
} satisfies HarnessManagedImageDeclaration;

const packagePolicy = {
  context_target: "/sandbox/.future-harness/context/POLICY.md",
  owned_presets: ["future-observability"],
  automatic_presets: [
    {
      name: "future-observability",
      activation: { kind: "observability-enabled" },
      apply_during_create: true,
      suppress_in_tiers: ["restricted"],
    },
  ],
  baseline_exclusion_impacts: {},
} satisfies HarnessPolicyCapability;

const packageProviderAuth = {
  support: "managed",
  adapter: "provider-auth",
  operation: "resolve-auth-method",
  request_environment: ["NEMOCLAW_FUTURE_AUTH_METHOD"],
  default_method: "api-key",
  selection: {
    key: "futureProvider",
    aliases: ["future"],
    label: "Future Provider",
    provider_name: "future-provider",
    provider_type: "openai",
    endpoint_url: "https://inference.example.com/v1",
    help_url: "https://example.com/keys",
    default_model: "future/default",
    models: ["future/default"],
    preferred_inference_api: "openai-completions",
  },
  methods: [
    {
      id: "api-key",
      label: "API key",
      kind: "api-key",
      credential_env: "FUTURE_API_KEY",
      source_env: "FUTURE_API_KEY",
      prompt_label: "Future API key",
    },
  ],
} satisfies HarnessProviderAuthCapability;

const packageToolGateways = {
  support: "managed",
  selection_label: "Future managed tools",
  selection_prompt: "Managed tools",
  request_environment: ["NEMOCLAW_FUTURE_TOOL_GATEWAYS"],
  incompatible_auth_message: "Managed tools require browser authentication.",
  gateways: [
    {
      id: "future-search",
      aliases: ["search"],
      label: "Future search",
      description: "Search through the future provider",
      default_selected: true,
      authentication_methods: ["api-key"],
      policy_presets: ["future-search"],
    },
  ],
} satisfies HarnessToolGatewayCapability;

void packageToolGateways;

const localInferenceContextRequirement = {
  provider: "ollama-local",
  minimum_tokens: 64_000,
} satisfies HarnessInferenceContextWindowRequirement;

const unsupportedLocalInferenceContextRequirement: HarnessInferenceContextWindowRequirement = {
  // @ts-expect-error Core accepts only local runtime providers with an implemented consumer.
  provider: "future-local",
  minimum_tokens: 64_000,
};

const packageImageWithMutableReference: HarnessManagedImageDeclaration = {
  ...packagePublishedImage,
  publication: {
    ...packagePublishedImage.publication,
    digests: {
      // @ts-expect-error A package publication accepts an exact digest, never a tag.
      "linux/amd64": "latest",
    },
  },
};

// @ts-expect-error A bridge must declare the binaries its policy allows.
const mcpBridgeWithoutPolicy: HarnessMcpCapability = {
  support: "bridge",
  adapter: "future-harness",
};

// @ts-expect-error A tmpfs mount must explicitly choose its finite option list.
const tmpfsMountWithoutOptions: HarnessSandboxTmpfsMountDeclaration = {
  type: "tmpfs",
  drivers: ["docker"],
  target: "/run/future-harness",
  size_bytes: 1_048_576,
  mode: 0o1777,
};

// @ts-expect-error A terminal runtime needs an interactive or headless command.
const terminalWithoutCommand: HarnessRuntimeCommandDeclaration = { kind: "terminal" };

// @ts-expect-error A terminal runtime cannot ask core to manage a gateway process.
const managedTerminal: HarnessRuntimeCommandDeclaration = {
  kind: "terminal",
  interactive_command: "future-harness",
  process_lifecycle: {
    support: "managed",
    command: ["/usr/local/bin/future-process-control"],
  },
};

// @ts-expect-error Prompt transport has no meaning without a headless command.
const transportWithoutHeadlessCommand: HarnessRuntimeCommandDeclaration = {
  kind: "gateway",
  interactive_command: "future-harness",
  process_lifecycle: {
    support: "unsupported",
    reason: "This type fixture does not manage a gateway process.",
  },
  prompt_transport: "stdin",
};

// @ts-expect-error Device pairing requires its bounded settlement command.
const pairingWithoutSettlement: HarnessAgentManifest = {
  ...manifestFields,
  device_pairing: true,
  gateway_command: "future-harness gateway run",
  health_probe: {
    url: "http://127.0.0.1:19090/health",
    port: 19_090,
    timeout_seconds: 30,
  },
  runtime: {
    kind: "gateway",
    interactive_command: "future-harness",
    process_lifecycle: {
      support: "unsupported",
      reason: "This type fixture does not manage a gateway process.",
    },
  },
};

// @ts-expect-error A settlement command is unavailable unless device pairing is enabled.
const settlementWithoutPairing: HarnessAgentManifest = {
  ...manifestFields,
  gateway_command: "future-harness gateway run",
  health_probe: {
    url: "http://127.0.0.1:19090/health",
    port: 19_090,
    timeout_seconds: 30,
  },
  runtime: {
    kind: "gateway",
    interactive_command: "future-harness",
    process_lifecycle: {
      support: "unsupported",
      reason: "This type fixture does not manage a gateway process.",
    },
    device_pairing_settlement: {
      command: ["/usr/local/bin/future-pairing-settle"],
      timeout_seconds: 30,
    },
    session_qualification: {
      command: ["/usr/local/bin/future-session-qualify"],
      timeout_seconds: 30,
    },
  },
};

void terminalManifest;
void pairingManifest;
void mcpBridge;
void mcpAdapterIdentifier;
void mcpArgvCommand;
void mcpShellCommand;
void uppercaseMcpAdapterIdentifier;
void untrustedMcpShellCommand;
void rawMcpCommand;
void tmpfsMount;
void startupControl;
void dockerUlimit;
void unknownStartupControl;
void stringDockerUlimit;
void packagePublishedImage;
void packagePolicy;
void packageProviderAuth;
void localInferenceContextRequirement;
void unsupportedLocalInferenceContextRequirement;
void packageImageWithMutableReference;
void mcpBridgeWithoutPolicy;
void tmpfsMountWithoutOptions;
void terminalWithoutCommand;
void managedTerminal;
void transportWithoutHeadlessCommand;
void pairingWithoutSettlement;
void settlementWithoutPairing;
