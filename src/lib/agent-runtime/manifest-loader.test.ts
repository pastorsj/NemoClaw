// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROOT } from "../runner";
import { buildAgentDefinition } from "./manifest-loader";
import {
  loadLegacyRepositoryManifest,
  loadValidatedHarnessManifest,
  parseManifestRecord,
  readDashboard,
  readInference,
} from "./manifest-readers";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-agent-definition-tests");
fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");

const VALID_STATE_LIFECYCLE = [
  "state_lifecycle:",
  "  backup_quiescence:",
  "    kind: not-required",
  "  snapshot_restore: []",
  "  rebuild:",
  "    managed_extensions:",
  "      support: disabled",
  "      reason: Test package has no managed extensions.",
  "    scheduled_work:",
  "      support: disabled",
  "      reason: Test package has no scheduled work.",
  "    post_restore:",
  "      kind: not-required",
] as const;

function writeFile(root: string, relativePath: string, contents = "fixture\n"): string {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

function writeAgentRoot(
  root: string,
  options: { readonly displayName?: string; readonly legacyPath?: string } = {},
): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lines = [
    "name: openclaw",
    `display_name: ${options.displayName ?? "OpenClaw"}`,
    "binary_path: /usr/local/bin/openclaw",
    ...(options.legacyPath ? ["_legacy_paths:", `  dockerfile: ${options.legacyPath}`] : []),
    ...VALID_STATE_LIFECYCLE,
  ];
  return writeFile(root, "packages/nemoclaw-openclaw/manifest.yaml", `${lines.join("\n")}\n`);
}

function buildFromRoot(root: string, manifestPath = writeAgentRoot(root)) {
  return buildAgentDefinition({
    manifest: loadLegacyRepositoryManifest(manifestPath),
    manifestPath,
    packageRoot: root,
  });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("inference manifest metadata", () => {
  it("projects the finite receipt-backed rebuild invocation selector", () => {
    expect(
      readInference({
        inference: { route_probe: { rebuild_preflight: "inference-invocation" } },
      }),
    ).toMatchObject({
      route_probe: { rebuild_preflight: "inference-invocation" },
    });
  });

  it("rejects an unsupported receipt-backed rebuild probe mode", () => {
    expect(() =>
      readInference({
        inference: { route_probe: { rebuild_preflight: "package-callback" } },
      }),
    ).toThrow(/route_probe.*supported core-owned probe modes/);
  });

  it("projects the finite hosted-inference provider-key compatibility declaration", () => {
    expect(
      readInference({
        inference: { provider_key_credential_alias: "hosted-inference" },
      }),
    ).toMatchObject({ provider_key_credential_alias: "hosted-inference" });
  });

  it("rejects an unsupported provider-key credential alias", () => {
    expect(() =>
      readInference({
        inference: { provider_key_credential_alias: "arbitrary-env" },
      }),
    ).toThrow(/provider_key_credential_alias.*hosted-inference/);
  });

  it.each([
    "/sandbox/.future/../secret",
    "/sandbox/.future\\config.json",
    "/sandbox/.future/config\u001b.json",
  ])("rejects a non-canonical inference smoke config path %j", (configPath) => {
    expect(() =>
      readInference({
        inference: {
          sandbox_smoke: { kind: "compatible-endpoint", config_path: configPath },
        },
      }),
    ).toThrow(/config path below \/sandbox/);
  });
});

describe("policy manifest metadata", () => {
  it("projects an immutable package policy capability", () => {
    const manifestPath = writeAgentRoot(fixtureRoot);
    fs.appendFileSync(
      manifestPath,
      [
        "policy:",
        "  context_target: /sandbox/.future-terminal/context/POLICY.md",
        "  owned_presets: [future-tools]",
        "  automatic_presets:",
        "    - name: future-tools",
        "      activation: { kind: always }",
        "      apply_during_create: false",
        "      suppress_in_tiers: [restricted]",
        "  baseline_exclusion_impacts:",
        "    future_api: Future API access may stop working.",
        "",
      ].join("\n"),
    );

    const definition = buildFromRoot(fixtureRoot, manifestPath);

    expect(definition.policyCapability).toEqual({
      context_target: "/sandbox/.future-terminal/context/POLICY.md",
      owned_presets: ["future-tools"],
      automatic_presets: [
        {
          name: "future-tools",
          activation: { kind: "always" },
          apply_during_create: false,
          suppress_in_tiers: ["restricted"],
        },
      ],
      baseline_exclusion_impacts: { future_api: "Future API access may stop working." },
    });
    expect(Object.isFrozen(definition.policyCapability)).toBe(true);
    expect(Object.isFrozen(definition.policyCapability.owned_presets)).toBe(true);
    expect(Object.isFrozen(definition.policyCapability.automatic_presets)).toBe(true);
    expect(Object.isFrozen(definition.policyCapability.baseline_exclusion_impacts)).toBe(true);
  });

  it("uses an empty policy capability when the package omits policy metadata", () => {
    expect(buildFromRoot(fixtureRoot).policyCapability).toEqual({
      owned_presets: [],
      automatic_presets: [],
      baseline_exclusion_impacts: {},
    });
  });
});

describe("agent roster manifest metadata", () => {
  it("projects the fixed managed capability without interpreting native behavior", () => {
    const manifestPath = writeAgentRoot(fixtureRoot);
    fs.appendFileSync(
      manifestPath,
      [
        "agent_roster:",
        "  support: managed",
        "  adapter: agent-roster",
        "  onboarding_environment: NEMOCLAW_EXTRA_AGENTS_JSON",
        "",
      ].join("\n"),
    );

    expect(buildFromRoot(fixtureRoot, manifestPath).agentRosterCapability).toEqual({
      support: "managed",
      adapter: "agent-roster",
      onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
    });
  });

  it("projects null when a package omits the optional capability", () => {
    expect(buildFromRoot(fixtureRoot).agentRosterCapability).toBeNull();
  });
});

describe("managed tool gateway manifest metadata", () => {
  it("projects the finite package declaration without interpreting harness IDs", () => {
    const manifestPath = writeAgentRoot(fixtureRoot);
    fs.appendFileSync(
      manifestPath,
      [
        "tool_gateways:",
        "  support: managed",
        "  selection_label: Future managed tools",
        "  selection_prompt: Managed tools",
        "  request_environment: [NEMOCLAW_FUTURE_TOOLS]",
        "  incompatible_auth_message: Future tools require browser login.",
        "  gateways:",
        "    - id: future-search",
        "      aliases: [search]",
        "      label: Future search",
        "      description: Search with the future provider",
        "      default_selected: true",
        "      authentication_methods: [browser-login]",
        "      policy_presets: [future-egress]",
        "",
      ].join("\n"),
    );

    const capability = buildFromRoot(fixtureRoot, manifestPath).toolGatewayCapability;
    expect(capability).toMatchObject({
      support: "managed",
      gateways: [{ id: "future-search", aliases: ["search"] }],
    });
    expect(Object.isFrozen(capability)).toBe(true);
  });

  it("projects null when the optional declaration is absent", () => {
    expect(buildFromRoot(fixtureRoot).toolGatewayCapability).toBeNull();
  });
});

describe("dashboard manifest metadata", () => {
  it("projects a typed same-sandbox forward reuse declaration", () => {
    expect(
      readDashboard(
        parseManifestRecord("dashboard:\n  forward_reuse: same-sandbox\n", "test manifest"),
      ).reuseOwnedForward,
    ).toBe(true);
    expect(
      readDashboard(parseManifestRecord("dashboard: {}\n", "test manifest")).reuseOwnedForward,
    ).toBe(false);
  });

  it("rejects an unknown dashboard forward reuse mode", () => {
    expect(() =>
      readDashboard(
        parseManifestRecord("dashboard:\n  forward_reuse: trust-port\n", "test manifest"),
      ),
    ).toThrow(/dashboard\.forward_reuse.*same-sandbox/u);
  });

  it("parses a bounded config token path for URL-token dashboards", () => {
    expect(
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  auth: url_token\n  token_path: custom.browser.secret\n",
          "test manifest",
        ),
      ).tokenPath,
    ).toEqual(["custom", "browser", "secret"]);
  });

  it("rejects unsafe config token paths", () => {
    expect(() =>
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  auth: url_token\n  token_path: gateway.auth.$token\n",
          "test manifest",
        ),
      ),
    ).toThrow(/safe dotted config path/);
  });

  it("parses a package-declared tunnel origins path without harness identity", () => {
    expect(
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  tunnel_allowed_origins_path: ui.security.browserOrigins\n",
          "test manifest",
        ),
      ).tunnelAllowedOriginsPath,
    ).toEqual(["ui", "security", "browserOrigins"]);
  });

  it("rejects an unsafe tunnel origins path", () => {
    expect(() =>
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  tunnel_allowed_origins_path: ui.$prototype.origins\n",
          "test manifest",
        ),
      ),
    ).toThrow(/safe dotted config path/);
  });
});

describe("buildAgentDefinition", () => {
  it("defaults missing lifecycle behavior only for a repository-owned legacy manifest", () => {
    const manifestPath = writeFile(
      fixtureRoot,
      "agents/legacy-test/manifest.yaml",
      "name: legacy-test\ndisplay_name: Legacy Test\n",
    );
    const manifest = loadLegacyRepositoryManifest(manifestPath);
    const input = { manifest, manifestPath, packageRoot: fixtureRoot };

    expect(() => buildAgentDefinition(input)).toThrow(
      "Agent manifest field 'state_lifecycle' must be an object",
    );

    const definition = buildAgentDefinition({
      ...input,
      manifestSource: "legacy-repository",
    });

    expect(definition.stateLifecycle).toEqual({
      backup_quiescence: { kind: "not-required" },
      snapshot_restore: [],
      rebuild: {
        managed_extensions: {
          support: "disabled",
          reason: "The legacy repository manifest does not declare managed extensions.",
        },
        scheduled_work: {
          support: "disabled",
          reason: "The legacy repository manifest does not declare scheduled work.",
        },
        post_restore: { kind: "not-required" },
      },
    });
    expect(Object.isFrozen(definition.stateLifecycle)).toBe(true);
  });

  it("preserves repository definition behavior through the explicit-root builder", () => {
    const packageRoot = path.join(ROOT, "packages/nemoclaw-openclaw");
    const manifestPath = path.join(packageRoot, "manifest.yaml");
    const definition = buildAgentDefinition({
      manifest: loadValidatedHarnessManifest(manifestPath, "openclaw"),
      manifestPath,
      packageRoot,
    });

    expect(definition).toMatchObject({
      name: "openclaw",
      displayName: "OpenClaw",
      packageRoot,
      manifestPath,
      agentDir: path.dirname(manifestPath),
      managedImage: {
        repository: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
        architectures: ["linux/amd64", "linux/arm64"],
        runtime_identity: { uid: 998, gid: 998, workdir: "/sandbox" },
      },
      sandbox_create: { generated_image_build: "local-buildkit-required" },
      runtime: {
        device_pairing_settlement: {
          command: ["/usr/local/bin/nemoclaw-device-pairing-settle"],
          timeout_seconds: 130,
        },
      },
      web_search: {
        support: "providers",
        providers: [{ provider: "brave" }, { provider: "tavily" }],
      },
      inference: {
        refresh_route_for_messaging_providers: ["compatible-endpoint"],
      },
    });
    expect(definition.inference?.providerApiOverrides).toEqual([]);
    expect(definition.inference?.contextWindowRequirements).toBeUndefined();
    expect(definition).toMatchObject({
      dockerfileBasePath: path.join(packageRoot, "Dockerfile.base"),
      dockerfilePath: path.join(packageRoot, "Dockerfile"),
      startScriptPath: path.join(packageRoot, "start.sh"),
      policyAdditionsPath: path.join(packageRoot, "policy-additions.yaml"),
      pluginDir: path.join(packageRoot, "plugin"),
      legacyPaths: null,
    });
  });

  it("projects package inference requirements without using the harness ID", () => {
    const packageRoot = path.join(ROOT, "packages/nemoclaw-hermes");
    const manifestPath = path.join(packageRoot, "manifest.yaml");
    const definition = buildAgentDefinition({
      manifest: loadValidatedHarnessManifest(manifestPath, "hermes"),
      manifestPath,
      packageRoot,
    });

    expect(definition.inference).toMatchObject({
      providerApiOverrides: [
        { provider: "compatible-anthropic-endpoint", api: "openai-completions" },
      ],
      contextWindowRequirements: [{ provider: "ollama-local", minimumTokens: 64_000 }],
    });
    expect(Object.isFrozen(definition.inference?.providerApiOverrides)).toBe(true);
    expect(Object.isFrozen(definition.inference?.contextWindowRequirements)).toBe(true);
  });

  it("resolves ordinary and legacy assets only from the selected package root", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, {
      legacyPath: "runtime/legacy.Dockerfile",
    });
    const dockerfile = writeFile(
      fixtureRoot,
      "packages/nemoclaw-openclaw/Dockerfile",
      "FROM scratch\n",
    );
    const legacyDockerfile = writeFile(fixtureRoot, "runtime/legacy.Dockerfile", "FROM scratch\n");

    const definition = buildAgentDefinition({
      manifest: loadLegacyRepositoryManifest(manifestPath),
      manifestPath,
      packageRoot: fixtureRoot,
    });

    expect(definition.packageRoot).toBe(fixtureRoot);
    expect(definition.dockerfilePath).toBe(dockerfile);
    expect(definition.legacyPaths?.dockerfile).toBe(legacyDockerfile);
    expect(path.relative(fixtureRoot, definition.legacyPaths?.dockerfile ?? "")).toBe(
      "runtime/legacy.Dockerfile",
    );
    expect(Object.getOwnPropertyDescriptors(definition)).toMatchObject({
      agentDir: { configurable: false, value: path.dirname(manifestPath), writable: false },
      manifestPath: { configurable: false, value: manifestPath, writable: false },
      packageRoot: { configurable: false, value: fixtureRoot, writable: false },
    });
    expect(Object.isFrozen(definition)).toBe(false);
  });

  it("keeps same-id definitions from different package roots isolated", () => {
    const firstRoot = path.join(fixtureRoot, "first");
    const secondRoot = path.join(fixtureRoot, "second");
    const firstManifest = writeAgentRoot(firstRoot, { displayName: "First OpenClaw" });
    const secondManifest = writeAgentRoot(secondRoot, { displayName: "Second OpenClaw" });
    writeFile(firstRoot, "packages/nemoclaw-openclaw/Dockerfile", "FROM first\n");
    writeFile(secondRoot, "packages/nemoclaw-openclaw/Dockerfile", "FROM second\n");

    const first = buildFromRoot(firstRoot, firstManifest);
    const second = buildFromRoot(secondRoot, secondManifest);

    expect(first.name).toBe(second.name);
    expect(first.displayName).toBe("First OpenClaw");
    expect(second.displayName).toBe("Second OpenClaw");
    expect(first.packageRoot).toBe(firstRoot);
    expect(second.packageRoot).toBe(secondRoot);
    expect(first.dockerfilePath).not.toBe(second.dockerfilePath);
  });

  it("uses the selected package's legacy baseline policy when no ordinary policy exists", () => {
    const manifestPath = writeFile(
      fixtureRoot,
      "packages/nemoclaw-openclaw/manifest.yaml",
      [
        "name: openclaw",
        "_legacy_paths:",
        "  policy: runtime/openclaw-policy.yaml",
        ...VALID_STATE_LIFECYCLE,
        "",
      ].join("\n"),
    );
    const legacyPolicy = writeFile(fixtureRoot, "runtime/openclaw-policy.yaml", "version: 1\n");

    const definition = buildFromRoot(fixtureRoot, manifestPath);

    expect(definition.policyAdditionsPath).toBe(legacyPolicy);
  });

  it("rejects manifest paths outside or aliased beneath the trusted root", () => {
    const manifestPath = writeAgentRoot(fixtureRoot);
    const outsideRoot = fs.mkdtempSync(path.join(TEST_PARENT, "outside-"));
    const outsideManifest = writeAgentRoot(outsideRoot);
    try {
      expect(() =>
        buildAgentDefinition({
          manifest: loadLegacyRepositoryManifest(outsideManifest),
          manifestPath: outsideManifest,
          packageRoot: fixtureRoot,
        }),
      ).toThrow(/inside the agent package root/u);

      const aliasedManifest = `${path.dirname(manifestPath)}/../openclaw/manifest.yaml`;
      expect(() =>
        buildAgentDefinition({
          manifest: loadLegacyRepositoryManifest(manifestPath),
          manifestPath: aliasedManifest,
          packageRoot: fixtureRoot,
        }),
      ).toThrow(/canonical absolute path/u);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each(["/etc/passwd", "../outside", "runtime\\outside"])(
    "rejects hostile legacy asset path %s",
    (legacyPath) => {
      const manifestPath = writeAgentRoot(fixtureRoot);
      const manifest = parseManifestRecord(
        [
          "name: openclaw",
          "_legacy_paths:",
          `  dockerfile: ${JSON.stringify(legacyPath)}`,
          ...VALID_STATE_LIFECYCLE,
          "",
        ].join("\n"),
        manifestPath,
      );

      expect(() =>
        buildAgentDefinition({ manifest, manifestPath, packageRoot: fixtureRoot }),
      ).toThrow(/canonical relative path/u);
    },
  );

  it("rejects symbolic links used by ordinary or legacy package assets", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, { legacyPath: "runtime/legacy.Dockerfile" });
    const outside = writeFile(fixtureRoot, "outside/Dockerfile", "FROM scratch\n");
    fs.mkdirSync(path.join(fixtureRoot, "runtime"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(fixtureRoot, "packages/nemoclaw-openclaw/Dockerfile"));
    fs.symlinkSync(outside, path.join(fixtureRoot, "runtime/legacy.Dockerfile"));

    expect(() =>
      buildAgentDefinition({
        manifest: loadLegacyRepositoryManifest(manifestPath),
        manifestPath,
        packageRoot: fixtureRoot,
      }),
    ).toThrow(/symbolic links/u);
  });

  it("revalidates legacy assets after the definition is built", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, {
      legacyPath: "runtime/legacy.Dockerfile",
    });
    const legacyDockerfile = writeFile(fixtureRoot, "runtime/legacy.Dockerfile", "FROM scratch\n");
    const replacement = writeFile(fixtureRoot, "replacement/Dockerfile", "FROM scratch\n");
    const definition = buildAgentDefinition({
      manifest: loadLegacyRepositoryManifest(manifestPath),
      manifestPath,
      packageRoot: fixtureRoot,
    });

    expect(definition.legacyPaths?.dockerfile).toBe(legacyDockerfile);
    fs.rmSync(legacyDockerfile);
    fs.symlinkSync(replacement, legacyDockerfile);

    expect(() => definition.legacyPaths).toThrow(/symbolic links/u);
  });
});
