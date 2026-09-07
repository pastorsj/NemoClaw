// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { HarnessProviderAuthCapability } from "@nvidia/nemoclaw-harness-contract";

import { installHarnessPackage } from "../../src/lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../src/lib/agent-runtime/package/receipt";
import type { InstalledHarnessPackage } from "../../src/lib/agent-runtime/package/store";
import { TEST_CONFIG_ADAPTER_SOURCE, TEST_STARTUP_ADAPTER_SOURCE } from "./adapter-fixtures";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

const HARNESS_PACKAGE_FIXTURES = Object.freeze([
  {
    id: "hermes",
    displayName: "Hermes Agent",
    packageVersion: "0.1.0",
    aliases: ["nemohermes", "nemo-hermes"],
    defaultChoice: false,
  },
  {
    id: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    packageVersion: "0.1.4",
    aliases: [
      "nemo-deepagents",
      "dcode",
      "deepagent",
      "deepagents",
      "deepagents-code",
      "langchain",
    ],
    defaultChoice: false,
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion: "0.1.1",
    aliases: ["nemoclaw", "nemo-claw"],
    defaultChoice: true,
  },
  {
    id: "pi",
    displayName: "Pi",
    packageVersion: "0.1.0",
    aliases: [],
    defaultChoice: false,
  },
  {
    id: "future-harness",
    displayName: "Future Harness",
    packageVersion: "1.0.0",
    aliases: [],
    defaultChoice: false,
  },
] as const);

interface HarnessPackageFixtureDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly aliases: readonly string[];
  readonly defaultChoice: boolean;
  readonly manifestPath: string;
}

export type HarnessPackageFixtureId = (typeof HARNESS_PACKAGE_FIXTURES)[number]["id"];
export type McpHarnessPackageFixtureId = Exclude<HarnessPackageFixtureId, "future-harness" | "pi">;

type ManagedProviderAuthCapability = Extract<
  HarnessProviderAuthCapability,
  { readonly support: "managed" }
>;

export interface HarnessPackageProviderAuthFixture {
  readonly packageId: HarnessPackageFixtureId;
  readonly capability: ManagedProviderAuthCapability;
}

export interface HarnessPackageMessagingFixture {
  readonly packageId: HarnessPackageFixtureId;
  readonly channelIds?: readonly string[];
  readonly failAdapter?: boolean;
}

export interface HarnessPackageFixtureOptions {
  readonly fixtureParent?: string;
  readonly storeRoot?: string;
  /** Optional agent runtime version declared by generated package manifests. */
  readonly agentExpectedVersion?: string;
  /** Optional non-OpenClaw baseline used by package-authority tests. */
  readonly agentPolicyAdditionsContent?: string;
  /** Optional receipt-backed messaging behavior for rebuild integration tests. */
  readonly messaging?: HarnessPackageMessagingFixture;
  /** Optional managed mutable-config behavior for receipt-backed rebuild tests. */
  readonly postRestoreMutableConfig?: "repair" | "verify";
  /** Optional web-search providers declared by a receipt-backed rebuild fixture. */
  readonly webSearchProviders?: readonly ("brave" | "tavily")[];
  /** Optional package-owned provider authentication used by receipt tests. */
  readonly providerAuth?: HarnessPackageProviderAuthFixture;
}

export interface HarnessPackageFixture {
  readonly fixtureRoot: string;
  readonly bundledRoot: string;
  readonly storeRoot: string;
  readonly executionSentinel: string;
  readonly packageRoots: ReadonlyMap<HarnessPackageFixtureId, string>;
  install(id: HarnessPackageFixtureId): InstalledHarnessPackage;
  installLocal(input: {
    readonly id: string;
    readonly displayName?: string;
    readonly packageVersion?: string;
    readonly aliases?: readonly string[];
    readonly defaultChoice?: boolean;
  }): InstalledHarnessPackage;
  installMany(ids: readonly HarnessPackageFixtureId[]): readonly InstalledHarnessPackage[];
  advanceActivePointer(
    id: HarnessPackageFixtureId,
    packageVersion?: string,
  ): InstalledHarnessPackage;
  damageActivePointer(id: HarnessPackageFixtureId): void;
  cleanup(): void;
}

const FIXTURE_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-harness-package-fixtures",
);
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = Object.freeze({
  kind: "bundled",
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  }),
});
const DEFAULT_HERMES_PROVIDER_AUTH = Object.freeze({
  support: "managed",
  adapter: "provider-auth",
  operation: "resolve-auth-method",
  request_environment: ["NEMOCLAW_HERMES_AUTH_METHOD"],
  default_method: "oauth",
  selection: {
    key: "hermesProvider",
    aliases: ["hermes-provider"],
    label: "Hermes Provider",
    provider_name: "hermes-provider",
    provider_type: "openai",
    endpoint_url: "https://inference-api.nousresearch.com/v1",
    help_url: "https://portal.nousresearch.com/manage-subscription",
    default_model: "hermes-model",
    models: ["hermes-model"],
    preferred_inference_api: "openai-completions",
  },
  methods: [
    {
      id: "oauth",
      label: "Nous Portal OAuth",
      kind: "oauth-device-code",
      credential_env: "OPENAI_API_KEY",
      device_code: {
        portal_base_url: "https://portal.nousresearch.com",
        client_id: "hermes-cli",
        scope: "inference:mint_agent_key",
        minimum_credential_ttl_seconds: 1800,
      },
    },
    {
      id: "api-key",
      label: "Nous API Key",
      kind: "api-key",
      credential_env: "NOUS_API_KEY",
      source_env: "NOUS_API_KEY",
      prompt_label: "Nous API Key",
    },
  ],
} as const) satisfies ManagedProviderAuthCapability;
function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  privateDirectory(path.dirname(target));
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function fixtureManifest(
  declaration: HarnessPackageFixtureDeclaration,
  agentExpectedVersion?: string,
  messaging?: HarnessPackageMessagingFixture,
  postRestoreMutableConfig?: "repair" | "verify",
  webSearchProviders: readonly ("brave" | "tavily")[] = [],
  providerAuth?: ManagedProviderAuthCapability,
): string {
  const terminalCommand =
    declaration.id === "langchain-deepagents-code"
      ? "deepagents"
      : declaration.id === "pi"
        ? "pi"
        : null;
  const terminalRuntime = terminalCommand
    ? ["runtime:", "  kind: terminal", `  interactive_command: ${terminalCommand}`]
    : [
        "runtime:",
        "  kind: gateway",
        `  interactive_command: ${declaration.id}`,
        "  process_lifecycle:",
        "    support: unsupported",
        "    reason: This fixture does not manage a gateway process.",
        `gateway_command: ${declaration.id} gateway run`,
        "health_probe:",
        "  url: http://127.0.0.1:19090/health",
        "  port: 19090",
        "  timeout_seconds: 30",
      ];
  const snapshotRestoreActions = declaration.id === "openclaw" ? ["repair-mutable-config"] : [];
  const postRestore = postRestoreMutableConfig
    ? [
        "      kind: managed",
        "      command: null",
        "      reapply_messaging: false",
        "      restart_runtime: false",
        `      mutable_config: ${postRestoreMutableConfig}`,
        "      config_integrity:",
        "        kind: not-required",
        "      settle_device_pairing: false",
        "      notify_gateway_token_change: false",
      ]
    : declaration.id === "hermes"
      ? [
          "      kind: managed",
          "      command: null",
          "      reapply_messaging: false",
          "      restart_runtime: true",
          "      mutable_config: not-required",
          "      config_integrity:",
          "        kind: not-required",
          "      settle_device_pairing: false",
          "      notify_gateway_token_change: true",
        ]
      : ["      kind: not-required"];
  return [
    `name: ${declaration.id}`,
    `display_name: ${JSON.stringify(declaration.displayName)}`,
    `description: ${JSON.stringify(`Reviewed ${declaration.displayName} fixture adapter`)}`,
    ...(declaration.aliases.length > 0
      ? ["aliases:", ...declaration.aliases.map((alias) => `  - ${alias}`)]
      : []),
    "onboarding:",
    `  default: ${declaration.defaultChoice ? "true" : "false"}`,
    `  sandbox_name: ${declaration.id === "openclaw" ? "my-assistant" : declaration.id}`,
    `binary_path: ${declaration.id}`,
    ...(agentExpectedVersion ? [`expected_version: ${JSON.stringify(agentExpectedVersion)}`] : []),
    ...terminalRuntime,
    "config:",
    `  dir: /sandbox/.${declaration.id}`,
    "  config_file: config.json",
    "  format: json",
    "inference:",
    "  config_update:",
    "    support: unsupported",
    "    reason: This synthetic package has fixed inference configuration.",
    ...(providerAuth ? [`provider_auth: ${JSON.stringify(providerAuth)}`] : []),
    ...(webSearchProviders.length > 0
      ? [
          "web_search:",
          "  support: providers",
          "  providers:",
          ...webSearchProviders.flatMap((provider) => [
            `    - provider: ${provider}`,
            `      credential_env: ${provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY"}`,
            `      profile_type: ${provider}`,
            "      config_verification:",
            `        path: /sandbox/.${declaration.id}/config.json`,
            "        format: json",
            "        assertions:",
            "          - path: [web, provider]",
            `            equals: ${provider}`,
            "        credential_paths: []",
            "      egress_verification:",
            `        method: ${provider === "brave" ? "GET" : "POST"}`,
            `        url: ${provider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "https://api.tavily.com/search"}`,
            "        parameters: []",
            "        credential:",
            ...(provider === "brave"
              ? [
                  "          kind: header",
                  "          name: X-Subscription-Token",
                  "          prefix: none",
                ]
              : ["          kind: json-body", "          name: api_key"]),
            "        result_array_path: [results]",
          ]),
        ]
      : []),
    "mcp:",
    "  support: disabled",
    "messaging:",
    ...(messaging?.packageId === declaration.id && (messaging.channelIds?.length ?? 0) > 0
      ? [
          "  support: channels",
          "  channels:",
          ...messaging.channelIds!.map((channelId) => `    - ${channelId}`),
        ]
      : ["  support: disabled"]),
    "policy:",
    "  owned_presets: []",
    "  automatic_presets: []",
    "  baseline_exclusion_impacts: {}",
    "state_lifecycle:",
    "  backup_quiescence:",
    "    kind: not-required",
    ...(snapshotRestoreActions.length > 0
      ? ["  snapshot_restore:", ...snapshotRestoreActions.map((action) => `    - ${action}`)]
      : ["  snapshot_restore: []"]),
    "  rebuild:",
    "    managed_extensions:",
    "      support: disabled",
    "      reason: Test package has no managed extensions.",
    "    scheduled_work:",
    "      support: disabled",
    "      reason: This package does not run scheduled work.",
    "    post_restore:",
    ...postRestore,
    "",
  ].join("\n");
}

function writePackageArtifact(input: {
  readonly agentPolicyAdditionsContent?: string;
  readonly declaration: HarnessPackageFixtureDeclaration;
  readonly executionSentinel: string;
  readonly agentExpectedVersion?: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly payload: string;
  readonly messaging?: HarnessPackageMessagingFixture;
  readonly postRestoreMutableConfig?: "repair" | "verify";
  readonly webSearchProviders?: readonly ("brave" | "tavily")[];
  readonly providerAuth?: HarnessPackageProviderAuthFixture;
}): string {
  const providerAuth =
    input.providerAuth?.packageId === input.declaration.id
      ? input.providerAuth.capability
      : input.declaration.id === "hermes"
        ? DEFAULT_HERMES_PROVIDER_AUTH
        : undefined;
  privateDirectory(input.packageRoot);
  writePrivateFile(
    input.packageRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: input.declaration.id,
      displayName: input.declaration.displayName,
      packageVersion: input.packageVersion,
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: input.declaration.manifestPath,
    })}\n`,
  );
  writePrivateFile(
    input.packageRoot,
    input.declaration.manifestPath,
    fixtureManifest(
      input.declaration,
      input.agentExpectedVersion,
      input.messaging,
      input.postRestoreMutableConfig,
      input.webSearchProviders,
      providerAuth,
    ),
  );
  const packageDirectory = path.posix.dirname(input.declaration.manifestPath);
  const messaging =
    input.messaging?.packageId === input.declaration.id ? input.messaging : undefined;
  const messagingAdapterBody = messaging?.failAdapter
    ? '    throw new Error("Synthetic messaging adapter failure");'
    : (messaging?.channelIds?.length ?? 0) > 0
      ? [
          "    return {",
          '      kind: "channels",',
          "      packageId: PACKAGE_ID,",
          `      channelIds: ${JSON.stringify(messaging!.channelIds)},`,
          '      profilePath: "messaging/profile.json",',
          "      build: {",
          `        configRoot: ${JSON.stringify(`~/.${input.declaration.id}`)},`,
          "        packageManagers: [],",
          "      },",
          "    };",
        ].join("\n")
      : [
          "    return {",
          '      kind: "disabled",',
          "      packageId: PACKAGE_ID,",
          '      reason: "This synthetic package does not provide messaging.",',
          "    };",
        ].join("\n");
  writePrivateFile(
    input.packageRoot,
    path.posix.join(packageDirectory, "host/config-adapter.cts"),
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  writePrivateFile(
    input.packageRoot,
    path.posix.join(packageDirectory, "host/messaging-adapter.cts"),
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      '"use strict";',
      `const PACKAGE_ID = ${JSON.stringify(input.declaration.id)};`,
      "module.exports = {",
      "  describeMessagingIntegration(request) {",
      '    if (request.packageId !== PACKAGE_ID) throw new Error("Messaging request does not match this package");',
      messagingAdapterBody,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writePrivateFile(
    input.packageRoot,
    path.posix.join(packageDirectory, "host/startup-adapter.cts"),
    TEST_STARTUP_ADAPTER_SOURCE,
  );
  if (providerAuth) {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(packageDirectory, "host/provider-auth-adapter.cts"),
      [
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
        "// SPDX-License-Identifier: Apache-2.0",
        '"use strict";',
        `const DEFAULT_METHOD = ${JSON.stringify(providerAuth.default_method)};`,
        `const METHODS = new Set(${JSON.stringify(providerAuth.methods.map((method) => method.id))});`,
        "module.exports = {",
        "  resolveProviderAuthMethod(request) {",
        '    const requested = typeof request.requestedMethod === "string" ? request.requestedMethod : null;',
        '    return { kind: "managed", methodId: requested && METHODS.has(requested) ? requested : DEFAULT_METHOD };',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  }
  if ((messaging?.channelIds?.length ?? 0) > 0) {
    if (input.declaration.id !== "openclaw" && input.declaration.id !== "hermes") {
      throw new Error(`Messaging profile fixture is unavailable for '${input.declaration.id}'`);
    }
    const profilePath = path.join(
      REPOSITORY_ROOT,
      "packages",
      `nemoclaw-${input.declaration.id}`,
      "messaging",
      "profile.json",
    );
    const requestedChannelIds = new Set(messaging!.channelIds);
    const profiles = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Array<{
      readonly channelId?: unknown;
      readonly credentialProvider?: { readonly profilePath?: unknown };
    }>;
    const selectedProfiles = profiles.filter(
      (profile) =>
        typeof profile.channelId === "string" && requestedChannelIds.has(profile.channelId),
    );
    if (selectedProfiles.length !== requestedChannelIds.size) {
      throw new Error(`Messaging profile fixture is incomplete for '${input.declaration.id}'`);
    }
    writePrivateFile(
      input.packageRoot,
      path.posix.join(packageDirectory, "messaging/profile.json"),
      `${JSON.stringify(selectedProfiles)}\n`,
    );
    for (const profile of selectedProfiles) {
      const providerProfilePath = profile.credentialProvider?.profilePath;
      if (typeof providerProfilePath !== "string") continue;
      writePrivateFile(
        input.packageRoot,
        path.posix.join(packageDirectory, providerProfilePath),
        fs.readFileSync(
          path.join(
            REPOSITORY_ROOT,
            "packages",
            `nemoclaw-${input.declaration.id}`,
            ...providerProfilePath.split("/"),
          ),
          "utf8",
        ),
      );
    }
  }
  const baselineContent = input.agentPolicyAdditionsContent ?? "version: 1\nnetwork_policies: {}\n";
  writePrivateFile(
    input.packageRoot,
    path.posix.join(path.posix.dirname(input.declaration.manifestPath), "policy-additions.yaml"),
    baselineContent,
  );
  if (input.declaration.id === "openclaw" || input.declaration.id === "hermes") {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(path.posix.dirname(input.declaration.manifestPath), "Dockerfile"),
      [
        "FROM scratch",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        `ARG NEMOCLAW_WEB_SEARCH_PROVIDER=${input.declaration.id === "hermes" ? "tavily" : "brave"}`,
        "",
      ].join("\n"),
    );
  }
  if (input.declaration.id === "langchain-deepagents-code") {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(path.posix.dirname(input.declaration.manifestPath), "Dockerfile.base"),
      "FROM scratch\n",
    );
  }
  writePrivateFile(input.packageRoot, "runtime/payload.txt", input.payload);
  writePrivateFile(
    input.packageRoot,
    "runtime/install-sentinel.cjs",
    `require("node:fs").writeFileSync(${JSON.stringify(input.executionSentinel)}, "ran");\n`,
  );
  writePrivateFile(
    input.packageRoot,
    "package.json",
    `${JSON.stringify({ scripts: { install: "node runtime/install-sentinel.cjs" } })}\n`,
  );
  return input.packageRoot;
}

/** Create reviewed package bytes and an installed store under one exact private test root. */
export function createHarnessPackageFixture(
  options: HarnessPackageFixtureOptions = {},
): HarnessPackageFixture {
  const fixtureParent = options.fixtureParent ?? FIXTURE_PARENT;
  privateDirectory(fixtureParent);
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  const bundledRoot = path.join(fixtureRoot, "bundled");
  const storeRoot = options.storeRoot ?? path.join(fixtureRoot, "store");
  const versionRoot = path.join(fixtureRoot, "versions");
  const executionSentinel = path.join(fixtureRoot, "package-code-ran");
  privateDirectory(bundledRoot);
  privateDirectory(storeRoot);
  privateDirectory(versionRoot);

  const declarations = HARNESS_PACKAGE_FIXTURES.map((declaration) => ({
    ...declaration,
    manifestPath: "manifest.yaml",
  }));
  const declarationById = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const packageRoots = new Map(
    declarations.map((declaration) => {
      const packageRoot = path.join(bundledRoot, `nemoclaw-${declaration.id}`);
      writePackageArtifact({
        agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
        declaration,
        executionSentinel,
        agentExpectedVersion: options.agentExpectedVersion,
        packageRoot,
        packageVersion: declaration.packageVersion,
        payload: `${declaration.id} reviewed fixture\n`,
        messaging: options.messaging,
        postRestoreMutableConfig: options.postRestoreMutableConfig,
        webSearchProviders: options.webSearchProviders,
        providerAuth: options.providerAuth,
      });
      return [declaration.id, packageRoot] as const;
    }),
  );
  let advancedVersionSequence = 0;
  let localPackageSequence = 0;

  function install(id: HarnessPackageFixtureId): InstalledHarnessPackage {
    const packageRoot = packageRoots.get(id);
    if (!packageRoot) throw new Error(`Unknown harness fixture package '${id}'`);
    return installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
  }

  function advanceActivePointer(
    id: HarnessPackageFixtureId,
    packageVersion = "0.2.0",
  ): InstalledHarnessPackage {
    const declaration = declarationById.get(id);
    if (!declaration) throw new Error(`Unknown harness fixture package '${id}'`);
    advancedVersionSequence += 1;
    const packageRoot = path.join(
      versionRoot,
      `${id}-${packageVersion}-${String(advancedVersionSequence)}`,
    );
    writePackageArtifact({
      agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
      declaration,
      executionSentinel,
      agentExpectedVersion: options.agentExpectedVersion,
      packageRoot,
      packageVersion,
      payload: `${id} advanced fixture ${String(advancedVersionSequence)}\n`,
      messaging: options.messaging,
      postRestoreMutableConfig: options.postRestoreMutableConfig,
      webSearchProviders: options.webSearchProviders,
      providerAuth: options.providerAuth,
    });
    return installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
  }

  function installLocal(input: {
    readonly id: string;
    readonly displayName?: string;
    readonly packageVersion?: string;
    readonly aliases?: readonly string[];
    readonly defaultChoice?: boolean;
  }): InstalledHarnessPackage {
    localPackageSequence += 1;
    const packageVersion = input.packageVersion ?? "1.0.0";
    const declaration: HarnessPackageFixtureDeclaration = {
      id: input.id,
      displayName: input.displayName ?? input.id,
      packageVersion,
      aliases: input.aliases ?? [],
      defaultChoice: input.defaultChoice ?? false,
      manifestPath: "manifest.yaml",
    };
    const packageRoot = path.join(
      versionRoot,
      `local-${input.id}-${packageVersion}-${String(localPackageSequence)}`,
    );
    writePackageArtifact({
      agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
      declaration,
      executionSentinel,
      agentExpectedVersion: options.agentExpectedVersion,
      packageRoot,
      packageVersion,
      payload: `${input.id} local fixture ${String(localPackageSequence)}\n`,
      messaging: options.messaging,
      postRestoreMutableConfig: options.postRestoreMutableConfig,
      webSearchProviders: options.webSearchProviders,
      providerAuth: options.providerAuth,
    });
    return installHarnessPackage(
      { packageRoot, expectedId: input.id, sourceIdentity: { kind: "local" } },
      { storeRoot },
    );
  }

  return Object.freeze({
    fixtureRoot,
    bundledRoot,
    storeRoot,
    executionSentinel,
    packageRoots,
    install,
    installLocal,
    installMany: (ids: readonly HarnessPackageFixtureId[]) => ids.map(install),
    advanceActivePointer,
    damageActivePointer(id: HarnessPackageFixtureId): void {
      const pointer = path.join(storeRoot, "active", `${id}.json`);
      fs.writeFileSync(pointer, "damaged\n", { mode: 0o600 });
      fs.chmodSync(pointer, 0o600);
    },
    cleanup(): void {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    },
  });
}

/** Install one reviewed package fixture into the default store owned by an isolated HOME. */
export function installHomeHarnessPackageFixture(
  home: string,
  id: HarnessPackageFixtureId,
): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const agentPolicyAdditionsContent =
    id === "openclaw"
      ? fs.readFileSync(
          path.join(
            import.meta.dirname,
            "../..",
            "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
          ),
          "utf8",
        )
      : undefined;
  const fixture = createHarnessPackageFixture({
    fixtureParent: path.join(canonicalHome, "harness-package-fixtures"),
    storeRoot: path.join(canonicalHome, ".nemoclaw", "harnesses"),
    agentPolicyAdditionsContent,
  });
  if (id === "openclaw") {
    const packageRoot = fixture.packageRoots.get(id);
    if (!packageRoot) throw new Error("OpenClaw fixture package root is unavailable");
    writePrivateFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
    writePrivateFile(packageRoot, "Dockerfile", "FROM scratch\n");
  }
  return fixture.install(id);
}

function installMcpHarnessPackageFixture(
  sourceParent: string,
  storeRoot: string,
  id: McpHarnessPackageFixtureId,
): InstalledHarnessPackage {
  const declaration = HARNESS_PACKAGE_FIXTURES.find((candidate) => candidate.id === id);
  if (!declaration) throw new Error(`Unknown MCP harness fixture package '${id}'`);

  const sourceRoot = path.join(sourceParent, id);
  const packageDirectory = `packages/nemoclaw-${id}`;
  const repositoryPackageRoot = path.join(REPOSITORY_ROOT, packageDirectory);
  privateDirectory(path.join(sourceRoot, packageDirectory, "host"));
  writePrivateFile(
    sourceRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id,
      displayName: declaration.displayName,
      packageVersion: declaration.packageVersion,
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: `${packageDirectory}/manifest.yaml`,
    })}\n`,
  );
  const hostAdapters = fs
    .readdirSync(path.join(repositoryPackageRoot, "host"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cts"))
    .map((entry) => `host/${entry.name}`);
  for (const relativePath of ["manifest.yaml", ...hostAdapters]) {
    writePrivateFile(
      sourceRoot,
      `${packageDirectory}/${relativePath}`,
      fs.readFileSync(path.join(repositoryPackageRoot, relativePath), "utf8"),
    );
  }

  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

/** Install a package's real manifest and MCP adapter under an isolated test HOME. */
export function installHomeMcpHarnessPackageFixture(
  home: string,
  id: McpHarnessPackageFixtureId,
): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const storeRoot = path.join(canonicalHome, ".nemoclaw", "harnesses");
  const sourceParent = path.join(canonicalHome, "mcp-harness-package-sources");
  // Publish into each isolated store through the production boundary. Copying a
  // prebuilt store would bypass its ownership and immutable-object checks.
  return installMcpHarnessPackageFixture(sourceParent, storeRoot, id);
}

/** Install the real OpenClaw restore manifest and adapter under an isolated HOME. */
export function installHomeOpenClawRestorePackageFixture(home: string): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const sourceRoot = path.join(canonicalHome, "openclaw-restore-package");
  const packageRoot = path.join(sourceRoot, "packages", "nemoclaw-openclaw");
  const repositoryPackageRoot = path.join(
    import.meta.dirname,
    "../..",
    "packages",
    "nemoclaw-openclaw",
  );
  privateDirectory(path.join(packageRoot, "host"));
  fs.copyFileSync(
    path.join(repositoryPackageRoot, "manifest.yaml"),
    path.join(packageRoot, "manifest.yaml"),
  );
  fs.copyFileSync(
    path.join(repositoryPackageRoot, "host", "restore-adapter.cts"),
    path.join(packageRoot, "host", "restore-adapter.cts"),
  );
  fs.copyFileSync(
    path.join(repositoryPackageRoot, "host", "messaging-adapter.cts"),
    path.join(packageRoot, "host", "messaging-adapter.cts"),
  );
  for (const relativePath of ["messaging/profile.json", "provider-profiles/googlechat.yaml"]) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, relativePath)), {
      recursive: true,
      mode: 0o700,
    });
    fs.copyFileSync(
      path.join(repositoryPackageRoot, relativePath),
      path.join(packageRoot, relativePath),
    );
  }
  writePrivateFile(
    sourceRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "0.1.1",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-openclaw/manifest.yaml",
    })}\n`,
  );
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot: path.join(canonicalHome, ".nemoclaw", "harnesses") },
  );
}
