// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessAgentManifest,
  HarnessMcpAdapterCommandPlan,
  HarnessMcpAdapterIdentifier,
  HarnessMcpCapability,
  HarnessManagedImageDeclaration,
  HarnessPackageEnvelope,
  HarnessRuntimeCommandDeclaration,
  HarnessSandboxTmpfsMountDeclaration,
} from "./src/index.js";

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
  },
  messaging: { support: "disabled" },
  state_lifecycle: {
    backup_quiescence: { kind: "not-required" },
    snapshot_restore: [],
    rebuild: {
      image_plugin_provenance: "not-required",
      scheduled_work: { support: "disabled", reason: "No scheduled work." },
      post_restore: { kind: "not-required" },
    },
  },
} as const;

const terminalManifest = {
  ...manifestFields,
  runtime: {
    kind: "terminal",
    headless_command: "future-harness --prompt",
    prompt_transport: "stdin",
  },
} satisfies HarnessAgentManifest;

const pairingManifest = {
  ...manifestFields,
  device_pairing: true,
  runtime: {
    kind: "gateway",
    device_pairing_settlement: {
      command: ["/usr/local/bin/future-pairing-settle"],
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
  prompt_transport: "stdin",
};

// @ts-expect-error Device pairing requires its bounded settlement command.
const pairingWithoutSettlement: HarnessAgentManifest = {
  ...manifestFields,
  device_pairing: true,
  runtime: { kind: "gateway" },
};

// @ts-expect-error A settlement command is unavailable unless device pairing is enabled.
const settlementWithoutPairing: HarnessAgentManifest = {
  ...manifestFields,
  runtime: {
    kind: "gateway",
    device_pairing_settlement: {
      command: ["/usr/local/bin/future-pairing-settle"],
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
void packagePublishedImage;
void packageImageWithMutableReference;
void mcpBridgeWithoutPolicy;
void tmpfsMountWithoutOptions;
void terminalWithoutCommand;
void managedTerminal;
void transportWithoutHeadlessCommand;
void pairingWithoutSettlement;
void settlementWithoutPairing;
