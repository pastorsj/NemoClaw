// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { buildHarnessAdapterArtifacts } from "./build-adapters.mts";
import { HarnessPackageConformanceError, validateHarnessPackage } from "./validate-package.mts";
type ManifestValidatorModule = typeof import("./src/manifest-validator.ts");

const CONTRACT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.dirname(CONTRACT_ROOT);
const require = createRequire(import.meta.url);
const { HarnessManifestValidationError, validateHarnessManifest } =
  require("./dist/src/manifest-validator.js") as ManifestValidatorModule;
const REQUIRED_RUNTIME_FILES = [
  "Dockerfile.base",
  "Dockerfile",
  "manifest.yaml",
  "policy-additions.yaml",
  "start.sh",
] as const;
const REAL_HARNESS_IDS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
  "pi",
  "deepseek-harness",
  "haystack-agent",
] as const;
const UNSAFE_PRIVILEGED_COMMAND_PATHS = [
  "/sandbox/package-control",
  "/usr/local/bin/../sandbox/package-control",
  "/usr/local/bin/future\\package-control",
  "/usr/local/bin/future\u001b-package-control",
] as const;

function validPackageManifest(
  options: {
    readonly additional?: readonly string[];
    readonly mcp?: readonly string[];
    readonly messaging?: readonly string[];
    readonly policy?: readonly string[];
  } = {},
): string {
  return [
    "name: future-terminal",
    'display_name: "Future Terminal"',
    "runtime:",
    "  kind: terminal",
    "  interactive_command: future-terminal",
    "  prompt_transport: stdin",
    "  headless_command: future-terminal --prompt",
    "config:",
    "  dir: /sandbox/.future-terminal",
    "  config_file: config.json",
    "  format: json",
    "inference:",
    "  config_update:",
    "    support: unsupported",
    "    reason: This synthetic package has fixed inference configuration.",
    ...(options.additional ?? []),
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
    "      reason: This package does not run scheduled work.",
    "    post_restore:",
    "      kind: not-required",
    ...(options.mcp ?? ["mcp:", "  support: disabled"]),
    ...(options.messaging ?? ["messaging:", "  support: disabled"]),
    ...(options.policy ?? [
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
    ]),
    "",
  ].join("\n");
}

function futureToolGatewayManifest(): Record<string, unknown> {
  return parseYaml(
    validPackageManifest({
      additional: [
        "provider_broker:",
        "  support: managed",
        "  adapter: provider-broker",
        "  operations: [describe-provider, register-refresh-provider, ensure-broker, inspect-broker, teardown-broker]",
        "provider_auth:",
        "  support: managed",
        "  adapter: provider-auth",
        "  operation: resolve-auth-method",
        "  request_environment: [NEMOCLAW_FUTURE_AUTH_METHOD]",
        "  default_method: browser-login",
        "  selection:",
        "    key: futureProvider",
        "    aliases: [future]",
        "    label: Future Provider",
        "    provider_name: future-provider",
        "    provider_type: openai",
        "    endpoint_url: https://inference.example.com/v1",
        "    help_url: https://example.com/keys",
        "    default_model: future/model",
        "    models: [future/model]",
        "    preferred_inference_api: openai-completions",
        "  methods:",
        "    - id: browser-login",
        "      label: Browser login",
        "      kind: oauth-device-code",
        "      credential_env: FUTURE_API_KEY",
        "      device_code:",
        "        portal_base_url: https://login.example.com",
        "        client_id: future-cli",
        "        scope: future:tools",
        "        minimum_credential_ttl_seconds: 1800",
        "tool_gateways:",
        "  support: managed",
        "  selection_label: Future managed tools",
        "  selection_prompt: Managed tools",
        "  request_environment: [NEMOCLAW_FUTURE_TOOL_GATEWAYS]",
        "  incompatible_auth_message: Managed tools require browser login.",
        "  gateways:",
        "    - id: future-search",
        "      aliases: [search]",
        "      label: Future search",
        "      description: Search through the future provider",
        "      default_selected: true",
        "      authentication_methods: [browser-login]",
        "      policy_presets: [future-search]",
      ],
      policy: [
        "policy:",
        "  owned_presets: [future-search]",
        "  automatic_presets: []",
        "  baseline_exclusion_impacts: {}",
      ],
    }),
  ) as Record<string, unknown>;
}

interface FixtureOptions {
  readonly buildProjects?: readonly string[];
  readonly files?: readonly string[];
  readonly manifest?: string;
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly version?: string;
  readonly minimumNemoClawVersion?: string;
  readonly maximumNemoClawVersionExclusive?: string;
}

function writeFile(root: string, relativePath: string, contents: string, mode = 0o644): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, { mode });
}

function createPackageFixture(options: FixtureOptions = {}): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-conformance-"));
  const packageRoot = path.join(fixtureRoot, "nemoclaw-future-terminal");
  fs.mkdirSync(packageRoot);
  const packageJson = {
    name: options.name ?? "@example/nemoclaw-future-terminal",
    version: options.version ?? "3.2.1-beta.2+build.7",
    scripts: options.scripts ?? {},
    files: options.files ?? [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts"],
    nemoclaw: {
      harnessManifest: "manifest.yaml",
      minimumNemoClawVersion: options.minimumNemoClawVersion ?? "0.0.113",
      maximumNemoClawVersionExclusive: options.maximumNemoClawVersionExclusive ?? "0.0.121",
      ...(options.buildProjects ? { buildProjects: options.buildProjects } : {}),
    },
  };
  writeFile(packageRoot, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
  writeFile(packageRoot, "Dockerfile", "FROM scratch\n");
  writeFile(packageRoot, "manifest.yaml", options.manifest ?? validPackageManifest());
  writeFile(packageRoot, "policy-additions.yaml", "network_policies: []\n");
  writeFile(packageRoot, "start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
  writeFile(
    packageRoot,
    "host/config-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  writeFile(
    packageRoot,
    "host/messaging-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  writeFile(
    packageRoot,
    "host/startup-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  return packageRoot;
}

function removeFixture(packageRoot: string): void {
  fs.rmSync(path.dirname(packageRoot), { recursive: true, force: true });
}

function expectDiagnostic(
  packageRoot: string,
  code: string,
  relativePath: string,
): HarnessPackageConformanceError {
  let caught: unknown;
  try {
    validateHarnessPackage(packageRoot);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessPackageConformanceError);
  assert.equal(caught.diagnostics[0]?.code, code);
  assert.equal(caught.diagnostics[0]?.path, relativePath);
  assert.doesNotMatch(caught.message, new RegExp(packageRoot.replaceAll("/", "\\/"), "u"));
  return caught;
}

function updatePackageJson(
  packageRoot: string,
  update: (value: Record<string, unknown>) => void,
): void {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  update(value);
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(value, null, 2)}\n`);
}

function addTypedAdapterSource(packageRoot: string): void {
  const typescriptTarget = path.join(REPOSITORY_ROOT, "node_modules", "typescript");
  const typescriptLink = path.join(packageRoot, "node_modules", "typescript");
  fs.mkdirSync(path.dirname(typescriptLink), { recursive: true });
  fs.symlinkSync(typescriptTarget, typescriptLink, "dir");
  writeFile(
    packageRoot,
    "host/source/config-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      "const adapter = Object.freeze({});",
      "export = adapter;",
      "",
    ].join("\n"),
  );
  buildHarnessAdapterArtifacts(packageRoot);
}

function validManifestValue(): Record<string, unknown> {
  return parseYaml(validPackageManifest()) as Record<string, unknown>;
}

function addGatewayRuntimeSurfaces(manifest: Record<string, unknown>): void {
  manifest.gateway_command = "future-terminal gateway run";
  manifest.forward_ports = [19_090];
  manifest.health_probe = {
    url: "http://127.0.0.1:19090/health",
    port: 19_090,
    timeout_seconds: 30,
  };
  const runtime = manifestRecordAt(manifest, "runtime");
  runtime.kind = "gateway";
  runtime.process_lifecycle ??= {
    support: "unsupported",
    reason: "This fixture does not provide managed gateway recovery.",
  };
}

function tavilyWebSearchBinding(): Record<string, unknown> {
  return {
    provider: "tavily",
    credential_env: "TAVILY_API_KEY",
    profile_type: "tavily-future",
    config_verification: {
      path: "/sandbox/.future/config.yaml",
      format: "yaml",
      assertions: [{ path: ["web", "provider"], equals: "tavily" }],
      credential_paths: [["web", "api_key"]],
    },
    egress_verification: {
      method: "POST",
      url: "https://search.example.test/query",
      parameters: [{ name: "query", value: "NVIDIA" }],
      credential: { kind: "header", name: "Authorization", prefix: "bearer" },
      result_array_path: ["results"],
    },
  };
}

function futureWebSearchManifest(): string {
  return validPackageManifest({
    additional: [
      "web_search:",
      "  support: providers",
      "  providers:",
      "    - provider: tavily",
      "      credential_env: TAVILY_API_KEY",
      "      profile_type: tavily-future",
      "      config_verification:",
      "        path: /sandbox/.future/config.yaml",
      "        format: yaml",
      "        assertions:",
      "          - path: [web, provider]",
      "            equals: tavily",
      "        credential_paths: [[web, api_key]]",
      "      egress_verification:",
      "        method: POST",
      "        url: https://search.example.test/query",
      "        parameters:",
      "          - name: query",
      "            value: NVIDIA",
      "        credential:",
      "          kind: header",
      "          name: Authorization",
      "          prefix: bearer",
      "        result_array_path: [results]",
    ],
  });
}

function futureWebSearchProfile(host = "search.example.test", curlPath = "/usr/bin/curl"): string {
  return [
    "id: tavily-future",
    "credentials:",
    "  - name: api_key",
    "    env_vars: [TAVILY_API_KEY]",
    "    required: true",
    "    auth_style: bearer",
    "    header_name: authorization",
    "endpoints:",
    `  - host: ${host}`,
    "    port: 443",
    "    protocol: rest",
    "    enforcement: enforce",
    `binaries: [${curlPath}]`,
    "inference_capable: false",
    "",
  ].join("\n");
}

function manifestRecordAt(
  manifest: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  return manifest[field] as Record<string, unknown>;
}

function expectManifestValidationError(manifest: Record<string, unknown>, field: string): void {
  assert.throws(
    () => validateHarnessManifest(manifest, "future-terminal"),
    (error: unknown) => {
      assert.ok(error instanceof HarnessManifestValidationError);
      assert.ok(error.message.includes(`'${field}'`), error.message);
      return true;
    },
  );
}

test("accepts a synthetic harness package and reports its published runtime files", () => {
  const packageRoot = createPackageFixture({
    scripts: { prepack: "node prepack.mjs" },
  });
  try {
    writeFile(
      packageRoot,
      "prepack.mjs",
      'import fs from "node:fs"; fs.writeFileSync("ran", "yes");\n',
    );
    const report = validateHarnessPackage(packageRoot);
    assert.equal(report.harnessId, "future-terminal");
    assert.equal(report.packageName, "@example/nemoclaw-future-terminal");
    assert.equal(report.packageVersion, "3.2.1-beta.2+build.7");
    assert.equal(report.minimumNemoClawVersion, "0.0.113");
    assert.equal(report.maximumNemoClawVersionExclusive, "0.0.121");
    assert.deepEqual(report.adapterArtifacts, [
      "host/config-adapter.cts",
      "host/messaging-adapter.cts",
      "host/startup-adapter.cts",
    ]);
    assert.ok(report.packedFiles.includes("manifest.yaml"));
    assert.ok(report.packedFiles.includes("host/config-adapter.cts"));
    assert.ok(report.packedFiles.includes("host/messaging-adapter.cts"));
    assert.ok(report.packedFiles.includes("host/startup-adapter.cts"));
    assert.equal(fs.existsSync(path.join(packageRoot, "ran")), false);
  } finally {
    removeFixture(packageRoot);
  }
});

test("requires every declared package policy preset as a matching published asset", async (t) => {
  const manifest = validPackageManifest({
    policy: [
      "policy:",
      "  context_target: /sandbox/.future-terminal/context/POLICY.md",
      "  owned_presets: [future-tools]",
      "  automatic_presets:",
      "    - name: future-tools",
      "      activation: { kind: observability-enabled }",
      "      apply_during_create: true",
      "      suppress_in_tiers: [restricted]",
      "  baseline_exclusion_impacts: {}",
    ],
  });

  await t.test("accepts the convention-based package asset", () => {
    const packageRoot = createPackageFixture({
      manifest,
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "policies/presets/*.yaml"],
    });
    try {
      writeFile(
        packageRoot,
        "policies/presets/future-tools.yaml",
        [
          "preset:",
          "  name: future-tools",
          '  description: "Future service access"',
          "network_policies:",
          "  future_tools: {}",
          "",
        ].join("\n"),
      );

      const report = validateHarnessPackage(packageRoot);
      assert.ok(report.packedFiles.includes("policies/presets/future-tools.yaml"));
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a missing declared asset", () => {
    const packageRoot = createPackageFixture({ manifest });
    try {
      expectDiagnostic(packageRoot, "file-type", "policies/presets/future-tools.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects mismatched asset metadata", () => {
    const packageRoot = createPackageFixture({ manifest });
    try {
      writeFile(
        packageRoot,
        "policies/presets/future-tools.yaml",
        [
          "preset:",
          "  name: wrong-tools",
          '  description: "Wrong service"',
          "network_policies: {}",
          "",
        ].join("\n"),
      );
      expectDiagnostic(packageRoot, "manifest", "policies/presets/future-tools.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects an optional package route embedded in the baseline", () => {
    const packageRoot = createPackageFixture({ manifest });
    try {
      writeFile(packageRoot, "policy-additions.yaml", "network_policies:\n  future_tools: {}\n");
      writeFile(
        packageRoot,
        "policies/presets/future-tools.yaml",
        [
          "preset:",
          "  name: future-tools",
          '  description: "Future service"',
          "network_policies:",
          "  future_tools: {}",
          "",
        ].join("\n"),
      );

      expectDiagnostic(packageRoot, "manifest", "policies/presets/future-tools.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("validates finite managed tool-gateway declarations and their package references", () => {
  const valid = futureToolGatewayManifest();
  assert.doesNotThrow(() => validateHarnessManifest(valid, "future-terminal"));

  const duplicateAlias = structuredClone(valid);
  const capability = manifestRecordAt(duplicateAlias, "tool_gateways");
  const gateways = capability.gateways as Record<string, unknown>[];
  gateways.push({
    ...(gateways[0] ?? {}),
    id: "future-image",
    aliases: ["search"],
    label: "Future image",
  });
  expectManifestValidationError(duplicateAlias, "tool_gateways.gateways[1].aliases");

  const unknownAuth = structuredClone(valid);
  const unknownAuthGateway = (
    manifestRecordAt(unknownAuth, "tool_gateways").gateways as Record<string, unknown>[]
  )[0];
  assert.ok(unknownAuthGateway);
  unknownAuthGateway.authentication_methods = ["not-declared"];
  expectManifestValidationError(unknownAuth, "tool_gateways.gateways[0].authentication_methods");

  const foreignPolicy = structuredClone(valid);
  const foreignPolicyGateway = (
    manifestRecordAt(foreignPolicy, "tool_gateways").gateways as Record<string, unknown>[]
  )[0];
  assert.ok(foreignPolicyGateway);
  foreignPolicyGateway.policy_presets = ["not-owned"];
  expectManifestValidationError(foreignPolicy, "tool_gateways.gateways[0].policy_presets");

  const tooManyGateways = structuredClone(valid);
  const bounded = manifestRecordAt(tooManyGateways, "tool_gateways");
  const first = (bounded.gateways as Record<string, unknown>[])[0];
  assert.ok(first);
  bounded.gateways = Array.from({ length: 33 }, (_, index) => ({
    ...first,
    id: `future-${String(index)}`,
    aliases: [],
  }));
  expectManifestValidationError(tooManyGateways, "tool_gateways.gateways");
});

test("requires web-search recipes to match a published provider profile", async (t) => {
  const files = [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "provider-profiles/*.yaml"];

  await t.test("accepts and publishes the matching profile", () => {
    const packageRoot = createPackageFixture({ manifest: futureWebSearchManifest(), files });
    try {
      writeFile(packageRoot, "provider-profiles/tavily-future.yaml", futureWebSearchProfile());
      const report = validateHarnessPackage(packageRoot);
      assert.ok(report.packedFiles.includes("provider-profiles/tavily-future.yaml"));
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a missing profile", () => {
    const packageRoot = createPackageFixture({ manifest: futureWebSearchManifest(), files });
    try {
      expectDiagnostic(
        packageRoot,
        "provider-profile-artifact",
        "provider-profiles/tavily-future.yaml",
      );
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a linked profile", () => {
    const packageRoot = createPackageFixture({ manifest: futureWebSearchManifest(), files });
    try {
      writeFile(packageRoot, "provider-profiles/real.yaml", futureWebSearchProfile());
      fs.symlinkSync("real.yaml", path.join(packageRoot, "provider-profiles/tavily-future.yaml"));
      expectDiagnostic(
        packageRoot,
        "provider-profile-artifact",
        "provider-profiles/tavily-future.yaml",
      );
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a profile that does not authorize the fixed probe command", () => {
    const packageRoot = createPackageFixture({ manifest: futureWebSearchManifest(), files });
    try {
      writeFile(
        packageRoot,
        "provider-profiles/tavily-future.yaml",
        futureWebSearchProfile("search.example.test", "/usr/local/bin/curl"),
      );
      const error = expectDiagnostic(
        packageRoot,
        "provider-profile-artifact",
        "provider-profiles/tavily-future.yaml",
      );
      assert.match(error.message, /does not authorize the core verification command/u);
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a verification host outside the profile boundary", () => {
    const packageRoot = createPackageFixture({ manifest: futureWebSearchManifest(), files });
    try {
      writeFile(
        packageRoot,
        "provider-profiles/tavily-future.yaml",
        futureWebSearchProfile("different.example.test"),
      );
      const error = expectDiagnostic(
        packageRoot,
        "provider-profile-artifact",
        "provider-profiles/tavily-future.yaml",
      );
      assert.match(error.message, /verification host is not declared/u);
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("publishes only Dockerfile-required production configs from a declared build project", () => {
  const buildConfigs = [
    "plugin/tsconfig.json",
    "plugin/tsconfig.runtime.json",
    "plugin/tsconfig.shared.json",
  ] as const;
  const packageRoot = createPackageFixture({
    buildProjects: ["plugin"],
    files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", ...buildConfigs],
  });
  try {
    writeFile(packageRoot, "plugin/tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
    writeFile(
      packageRoot,
      "plugin/tsconfig.shared.json",
      '{"extends":"./tsconfig.json","include":["src/shared/**/*.ts"]}\n',
    );
    writeFile(
      packageRoot,
      "plugin/tsconfig.runtime.json",
      '{"extends":["./tsconfig.json","./tsconfig.shared.json"],"include":["src/runtime/**/*.ts"]}\n',
    );
    writeFile(
      packageRoot,
      "Dockerfile",
      [
        "FROM scratch",
        'COPY ["./packages/nemoclaw-future-terminal/plugin/tsconfig.json", "/opt/plugin/"]',
        'COPY "packages/nemoclaw-future-terminal/plugin/tsconfig.shared.json" "/opt/plugin/"',
        "COPY ./packages/nemoclaw-future-terminal/plugin/tsconfig.runtime.json /opt/plugin/",
        "",
      ].join("\n"),
    );

    const report = validateHarnessPackage(packageRoot);
    assert.deepEqual(
      report.packedFiles.filter((relativePath) => relativePath.startsWith("plugin/tsconfig")),
      buildConfigs,
    );
  } finally {
    removeFixture(packageRoot);
  }
});

test("limits direct Dockerfile sources to the package, core build kit, and pinned downloads", async (t) => {
  await t.test("accepts package-owned, shared Fabric, and pinned remote sources", () => {
    const packageRoot = createPackageFixture();
    try {
      writeFile(
        packageRoot,
        "Dockerfile",
        [
          "FROM scratch",
          "COPY packages/nemoclaw-future-terminal/start.sh /usr/local/bin/start",
          "COPY packages/nemoclaw-fabric/src/ /opt/nemoclaw-fabric/src/",
          "COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/",
          `ADD --checksum=sha256:${"a".repeat(64)} https://packages.example/runtime.tgz /opt/runtime.tgz`,
          "",
        ].join("\n"),
      );
      assert.doesNotThrow(() => validateHarnessPackage(packageRoot));
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects an arbitrary core file", () => {
    const packageRoot = createPackageFixture();
    try {
      writeFile(packageRoot, "Dockerfile", "FROM scratch\nCOPY README.md /opt/nemoclaw/\n");
      const error = expectDiagnostic(packageRoot, "build-context-source", "Dockerfile");
      assert.match(error.message, /outside this package and the NemoClaw core build kit/u);
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects a local ADD outside the package and core build kit", () => {
    const packageRoot = createPackageFixture();
    try {
      writeFile(packageRoot, "Dockerfile", "FROM scratch\nADD README.md /opt/nemoclaw/\n");
      const error = expectDiagnostic(packageRoot, "build-context-source", "Dockerfile");
      assert.match(error.message, /outside this package and the NemoClaw core build kit/u);
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects an unpinned remote ADD", () => {
    const packageRoot = createPackageFixture();
    try {
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nADD https://packages.example/runtime.tgz /opt/runtime.tgz\n",
      );
      const error = expectDiagnostic(packageRoot, "build-context-source", "Dockerfile");
      assert.match(error.message, /one exact SHA-256 checksum/u);
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("rejects another harness package", () => {
    const packageRoot = createPackageFixture();
    try {
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-openclaw/start.sh /usr/local/bin/start\n",
      );
      expectDiagnostic(packageRoot, "build-context-source", "Dockerfile");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects build-project metadata and TypeScript config publication outside the build closure", async (t) => {
  await t.test("the superseded authoringProjects metadata name", () => {
    const packageRoot = createPackageFixture();
    try {
      updatePackageJson(packageRoot, (value) => {
        (value.nemoclaw as Record<string, unknown>).authoringProjects = ["plugin"];
      });
      expectDiagnostic(packageRoot, "metadata", "package.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a root TypeScript config", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "tsconfig.json", "{}\n");
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a config from an undeclared project", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.json", "{}\n");
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("an unreferenced config from a declared project", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.json", "{}\n");
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a directly copied test config", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.test.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.test.json", "{}\n");
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.test.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.test.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a directly copied end-to-end test config", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.e2e.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.e2e.json", "{}\n");
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.e2e.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.e2e.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a production-named config that includes tests", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.json", '{"include":["src/**/*.test.ts"]}\n');
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a production-named config with a brace-glob test input", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.json", '{"include":["src/**/*.{test,spec}.ts"]}\n');
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("an unbounded extends array", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(
        packageRoot,
        "plugin/tsconfig.json",
        `${JSON.stringify({ extends: Array.from({ length: 17 }, () => "./tsconfig.base.json") })}\n`,
      );
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/tsconfig.json");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("a Vitest config in a declared build project", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/vitest.config.ts"],
    });
    try {
      writeFile(packageRoot, "plugin/vitest.config.ts", "export default {};\n");
      expectDiagnostic(packageRoot, "archive-authoring-path", "plugin/vitest.config.ts");
    } finally {
      removeFixture(packageRoot);
    }
  });

  await t.test("an extends dependency omitted from the archive", () => {
    const packageRoot = createPackageFixture({
      buildProjects: ["plugin"],
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "plugin/tsconfig.json"],
    });
    try {
      writeFile(packageRoot, "plugin/tsconfig.base.json", "{}\n");
      writeFile(packageRoot, "plugin/tsconfig.json", '{"extends":"./tsconfig.base.json"}\n');
      writeFile(
        packageRoot,
        "Dockerfile",
        "FROM scratch\nCOPY packages/nemoclaw-future-terminal/plugin/tsconfig.json /opt/build/\n",
      );
      expectDiagnostic(packageRoot, "archive-membership", "plugin/tsconfig.base.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("accepts every real harness manifest through the public runtime validator", async (t) => {
  for (const harnessId of REAL_HARNESS_IDS) {
    await t.test(harnessId, () => {
      const manifestPath = path.join(
        REPOSITORY_ROOT,
        "packages",
        `nemoclaw-${harnessId}`,
        "manifest.yaml",
      );
      const manifest = parseYaml(fs.readFileSync(manifestPath, "utf8")) as unknown;
      assert.doesNotThrow(() => validateHarnessManifest(manifest, harnessId));
    });
  }
});

test("validates the optional package-owned gateway log path", async (t) => {
  const baseManifest = validManifestValue();
  addGatewayRuntimeSurfaces(baseManifest);
  const runtime = manifestRecordAt(baseManifest, "runtime");
  runtime.gateway_log_path = "/var/log/future-agent/gateway.log";

  await t.test("accepts a canonical absolute path for a gateway runtime", () => {
    assert.doesNotThrow(() => validateHarnessManifest(baseManifest, "future-terminal"));
  });

  await t.test("rejects a non-canonical path", () => {
    const manifest = structuredClone(baseManifest);
    manifestRecordAt(manifest, "runtime").gateway_log_path = "/var/log/../secret";
    expectManifestValidationError(manifest, "runtime.gateway_log_path");
  });

  await t.test("rejects the field for a terminal runtime", () => {
    const manifest = structuredClone(baseManifest);
    manifestRecordAt(manifest, "runtime").kind = "terminal";
    expectManifestValidationError(manifest, "runtime.gateway_log_path");
  });
});

test("validates the finite semantic-turn command declaration", async (t) => {
  const managedManifest = validManifestValue();
  managedManifest.managed_image = {
    repository: "registry.example.test/future/harness",
    architectures: ["linux/amd64"],
    runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
  };
  manifestRecordAt(managedManifest, "runtime").semantic_turn = {
    support: "managed",
    command: ["/usr/local/bin/future-semantic-turn"],
    timeout_seconds: 120,
    protocol: "semantic-turn-ndjson",
  };

  await t.test("accepts a managed immutable command", () => {
    assert.doesNotThrow(() => validateHarnessManifest(managedManifest, "future-terminal"));
  });

  await t.test("accepts explicit unsupported behavior without an image", () => {
    const manifest = validManifestValue();
    manifestRecordAt(manifest, "runtime").semantic_turn = {
      support: "unsupported",
      reason: "This runtime does not accept semantic turns.",
    };
    assert.doesNotThrow(() => validateHarnessManifest(manifest, "future-terminal"));
  });

  await t.test("rejects a managed command without image authority", () => {
    const manifest = structuredClone(managedManifest);
    delete manifest.managed_image;
    expectManifestValidationError(manifest, "runtime.semantic_turn");
  });

  for (const fixture of [
    {
      name: "a mutable command path",
      field: "runtime.semantic_turn.command[0]",
      value: { command: ["/sandbox/future-semantic-turn"] },
    },
    {
      name: "an unknown stream protocol",
      field: "runtime.semantic_turn.protocol",
      value: { protocol: "native-events" },
    },
    {
      name: "an unbounded timeout",
      field: "runtime.semantic_turn.timeout_seconds",
      value: { timeout_seconds: 301 },
    },
    {
      name: "an arbitrary callback field",
      field: "runtime.semantic_turn",
      value: { callback: "load-native-code" },
    },
  ] as const) {
    await t.test(`rejects ${fixture.name}`, () => {
      const manifest = structuredClone(managedManifest);
      Object.assign(
        manifestRecordAt(manifestRecordAt(manifest, "runtime"), "semantic_turn"),
        fixture.value,
      );
      expectManifestValidationError(manifest, fixture.field);
    });
  }
});

test("requires complete operational surfaces for every gateway runtime", async (t) => {
  const baseManifest = validManifestValue();
  addGatewayRuntimeSurfaces(baseManifest);

  await t.test("gateway command", () => {
    const manifest = structuredClone(baseManifest);
    delete manifest.gateway_command;
    expectManifestValidationError(manifest, "gateway_command");
  });

  await t.test("health probe", () => {
    const manifest = structuredClone(baseManifest);
    delete manifest.health_probe;
    expectManifestValidationError(manifest, "health_probe");
  });

  await t.test("explicit lifecycle support", () => {
    const manifest = structuredClone(baseManifest);
    delete manifestRecordAt(manifest, "runtime").process_lifecycle;
    expectManifestValidationError(manifest, "runtime.process_lifecycle");
  });

  await t.test("an interactive or headless entry point", () => {
    const manifest = structuredClone(baseManifest);
    const runtime = manifestRecordAt(manifest, "runtime");
    delete runtime.interactive_command;
    delete runtime.headless_command;
    expectManifestValidationError(manifest, "runtime");
  });
});

test("rejects privileged commands outside immutable image-owned roots", async (t) => {
  const hermesManifestPath = path.join(
    REPOSITORY_ROOT,
    "packages",
    "nemoclaw-hermes",
    "manifest.yaml",
  );
  const baseManifest = parseYaml(fs.readFileSync(hermesManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  const surfaces = [
    {
      name: "backup quiescence",
      field: "state_lifecycle.backup_quiescence.command[0]",
      update: (manifest: Record<string, unknown>, commandPath: string) => {
        manifestRecordAt(manifest, "state_lifecycle").backup_quiescence = {
          kind: "command",
          command: [commandPath],
          timeout_seconds: 15,
        };
      },
    },
    {
      name: "process lifecycle",
      field: "runtime.process_lifecycle.command[0]",
      update: (manifest: Record<string, unknown>, commandPath: string) => {
        const runtime = manifestRecordAt(manifest, "runtime");
        manifestRecordAt(runtime, "process_lifecycle").command = [commandPath];
      },
    },
    {
      name: "scheduled work",
      field: "state_lifecycle.rebuild.scheduled_work.controller.command",
      update: (manifest: Record<string, unknown>, commandPath: string) => {
        const state = manifestRecordAt(manifest, "state_lifecycle");
        const rebuild = manifestRecordAt(state, "rebuild");
        const scheduledWork = manifestRecordAt(rebuild, "scheduled_work");
        manifestRecordAt(scheduledWork, "controller").command = [commandPath];
      },
    },
  ] as const;

  for (const surface of surfaces) {
    for (const commandPath of UNSAFE_PRIVILEGED_COMMAND_PATHS) {
      await t.test(`${surface.name}: ${JSON.stringify(commandPath)}`, () => {
        const manifest = structuredClone(baseManifest);
        surface.update(manifest, commandPath);
        assert.throws(
          () => validateHarnessManifest(manifest, "hermes"),
          (error: unknown) => {
            assert.ok(error instanceof HarnessManifestValidationError);
            assert.ok(error.message.includes(surface.field), error.message);
            return true;
          },
        );
      });
    }
  }
});

test("rejects mutable managed-extension controller commands", async (t) => {
  const manifestPath = path.join(REPOSITORY_ROOT, "packages", "nemoclaw-openclaw", "manifest.yaml");
  const baseManifest = parseYaml(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

  for (const commandPath of UNSAFE_PRIVILEGED_COMMAND_PATHS) {
    await t.test(JSON.stringify(commandPath), () => {
      const manifest = structuredClone(baseManifest);
      const state = manifestRecordAt(manifest, "state_lifecycle");
      const rebuild = manifestRecordAt(state, "rebuild");
      const extensions = manifestRecordAt(rebuild, "managed_extensions");
      manifestRecordAt(extensions, "controller").command = [commandPath];
      assert.throws(
        () => validateHarnessManifest(manifest, "openclaw"),
        (error: unknown) => {
          assert.ok(error instanceof HarnessManifestValidationError);
          assert.ok(
            error.message.includes("state_lifecycle.rebuild.managed_extensions.controller.command"),
            error.message,
          );
          return true;
        },
      );
    });
  }
});

test("uses canonical sandbox-path rules for web-search config verification", async (t) => {
  for (const configPath of [
    "/sandbox/.future/../secret",
    "/sandbox/.future\\config.yaml",
    "/sandbox/.future/config\u001b.yaml",
  ]) {
    await t.test(JSON.stringify(configPath), () => {
      const manifest = validManifestValue();
      const binding = tavilyWebSearchBinding();
      (binding.config_verification as Record<string, unknown>).path = configPath;
      manifest.web_search = { support: "providers", providers: [binding] };
      expectManifestValidationError(manifest, "web_search.providers[0].config_verification.path");
    });
  }
});

test("rejects unknown and missing fields in every public nested manifest shape", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly field: string;
    readonly update: (manifest: Record<string, unknown>) => void;
  }[] = [
    {
      name: "a missing policy declaration",
      field: "<root>.policy",
      update: (manifest) => {
        delete manifest.policy;
      },
    },
    {
      name: "an unknown runtime field",
      field: "runtime",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").native_hook = "run-anything";
      },
    },
    {
      name: "a missing runtime kind",
      field: "runtime.kind",
      update: (manifest) => {
        delete manifestRecordAt(manifest, "runtime").kind;
      },
    },
    {
      name: "a session qualification command without device pairing",
      field: "runtime",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").session_qualification = {
          command: ["/usr/local/bin/future-session-qualify"],
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a relative session qualification command",
      field: "runtime.session_qualification.command[0]",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").session_qualification = {
          command: ["future-session-qualify"],
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a relative selection qualification command",
      field: "runtime.selection_qualification.command[0]",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").selection_qualification = {
          command: ["future-selection-qualify"],
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a selection qualification command without managed image authority",
      field: "runtime.selection_qualification",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").selection_qualification = {
          command: ["/usr/local/bin/future-selection-qualify"],
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "an unknown smoke boundary field",
      field: "runtime.smoke_boundary",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").smoke_boundary = {
          kind: "login-shell",
          launcher: "/bin/sh",
        };
      },
    },
    {
      name: "a managed smoke boundary without its home",
      field: "runtime.smoke_boundary.home",
      update: (manifest) => {
        manifestRecordAt(manifest, "runtime").smoke_boundary = {
          kind: "managed-launcher",
          launcher: "/usr/local/bin/launcher",
        };
      },
    },
    {
      name: "an unknown health probe field",
      field: "health_probe",
      update: (manifest) => {
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          timeout_seconds: 30,
          callback: "native",
        };
      },
    },
    {
      name: "a health probe without its URL",
      field: "health_probe.url",
      update: (manifest) => {
        manifest.health_probe = { port: 8080, timeout_seconds: 30 };
      },
    },
    {
      name: "a health probe with duplicate success statuses",
      field: "health_probe.success_statuses",
      update: (manifest) => {
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          timeout_seconds: 30,
          success_statuses: [200, 200],
        };
      },
    },
    {
      name: "a secondary health probe without allocation data",
      field: "health_probe.secondary_forward",
      update: (manifest) => {
        manifest.forward_ports = [9000, 8080];
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          port_resolution: "sandbox-secondary-forward",
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a secondary health probe whose port is not a secondary forward",
      field: "health_probe.port_resolution",
      update: (manifest) => {
        manifest.forward_ports = [8080];
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          port_resolution: "sandbox-secondary-forward",
          secondary_forward: {
            environment_variable: "FUTURE_RUNTIME_API_PORT",
            preferred_port: 8080,
            range_start: 8080,
            range_end: 8090,
            label: "future runtime API",
            remedy: "Stop an existing listener and retry onboarding.",
          },
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a secondary forward that replaces a core-owned environment value",
      field: "health_probe.secondary_forward.environment_variable",
      update: (manifest) => {
        manifest.forward_ports = [9000, 8080];
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          port_resolution: "sandbox-secondary-forward",
          secondary_forward: {
            environment_variable: "NEMOCLAW_GATEWAY_PORT",
            preferred_port: 8080,
            range_start: 8080,
            range_end: 8090,
            label: "future runtime API",
            remedy: "Stop an existing listener and retry onboarding.",
          },
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "an unbounded secondary-forward allocation range",
      field: "health_probe.secondary_forward",
      update: (manifest) => {
        manifest.forward_ports = [9000, 8080];
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          port_resolution: "sandbox-secondary-forward",
          secondary_forward: {
            environment_variable: "FUTURE_RUNTIME_API_PORT",
            preferred_port: 8080,
            range_start: 8080,
            range_end: 8336,
            label: "future runtime API",
            remedy: "Stop an existing listener and retry onboarding.",
          },
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "a secondary-forward preference that differs from the health port",
      field: "health_probe.secondary_forward.preferred_port",
      update: (manifest) => {
        manifest.forward_ports = [9000, 8080];
        manifest.health_probe = {
          url: "http://127.0.0.1:8080/health",
          port: 8080,
          port_resolution: "sandbox-secondary-forward",
          secondary_forward: {
            environment_variable: "FUTURE_RUNTIME_API_PORT",
            preferred_port: 8081,
            range_start: 8080,
            range_end: 8090,
            label: "future runtime API",
            remedy: "Stop an existing listener and retry onboarding.",
          },
          timeout_seconds: 30,
        };
      },
    },
    {
      name: "an unknown dashboard field",
      field: "dashboard",
      update: (manifest) => {
        manifest.dashboard = { kind: "ui", native_hook: "open" };
      },
    },
    {
      name: "an unknown dashboard forward reuse mode",
      field: "dashboard.forward_reuse",
      update: (manifest) => {
        manifest.dashboard = { kind: "ui", forward_reuse: "trust-port" };
      },
    },
    {
      name: "an unknown dashboard UI field",
      field: "dashboard_ui",
      update: (manifest) => {
        manifest.dashboard_ui = {
          port: 8080,
          enable_env: "DASHBOARD_ENABLED",
          port_env: "DASHBOARD_PORT",
          internal_port: 18080,
          internal_port_env: "DASHBOARD_INTERNAL_PORT",
          native_hook: "open",
        };
      },
    },
    {
      name: "a dashboard UI without its port environment",
      field: "dashboard_ui.port_env",
      update: (manifest) => {
        manifest.dashboard_ui = {
          port: 8080,
          enable_env: "DASHBOARD_ENABLED",
          internal_port: 18080,
          internal_port_env: "DASHBOARD_INTERNAL_PORT",
        };
      },
    },
    {
      name: "a dashboard UI that reuses its public port internally",
      field: "dashboard_ui.internal_port",
      update: (manifest) => {
        manifest.dashboard_ui = {
          port: 8080,
          enable_env: "DASHBOARD_ENABLED",
          port_env: "DASHBOARD_PORT",
          internal_port: 8080,
          internal_port_env: "DASHBOARD_INTERNAL_PORT",
        };
      },
    },
    {
      name: "a dashboard UI that aliases two environment settings",
      field: "dashboard_ui",
      update: (manifest) => {
        manifest.dashboard_ui = {
          port: 8080,
          enable_env: "DASHBOARD_ENABLED",
          port_env: "DASHBOARD_PORT",
          internal_port: 18080,
          internal_port_env: "DASHBOARD_PORT",
        };
      },
    },
    {
      name: "a dashboard UI with a credential-shaped environment setting",
      field: "dashboard_ui.enable_env",
      update: (manifest) => {
        manifest.dashboard_ui = {
          port: 8080,
          enable_env: "DASHBOARD_SECRET",
          port_env: "DASHBOARD_PORT",
          internal_port: 18080,
          internal_port_env: "DASHBOARD_INTERNAL_PORT",
        };
      },
    },
    {
      name: "an unknown config field",
      field: "config",
      update: (manifest) => {
        manifestRecordAt(manifest, "config").native_writer = "callback";
      },
    },
    {
      name: "a config target without its format",
      field: "config.format",
      update: (manifest) => {
        delete manifestRecordAt(manifest, "config").format;
      },
    },
    {
      name: "an unknown inference field",
      field: "inference",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").native_router = "callback";
      },
    },
    {
      name: "inference without its config update declaration",
      field: "inference.config_update",
      update: (manifest) => {
        delete manifestRecordAt(manifest, "inference").config_update;
      },
    },
    {
      name: "an executable inference route probe hook",
      field: "inference.route_probe",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").route_probe = { callback: "native" };
      },
    },
    {
      name: "an unsupported rebuild inference route probe",
      field: "inference.route_probe.rebuild_preflight",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").route_probe = {
          rebuild_preflight: "package-callback",
        };
      },
    },
    {
      name: "an unsupported provider-key credential alias",
      field: "inference.provider_key_credential_alias",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").provider_key_credential_alias = "arbitrary-env";
      },
    },
    {
      name: "an inference smoke path with traversal",
      field: "inference.sandbox_smoke.config_path",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").sandbox_smoke = {
          kind: "compatible-endpoint",
          config_path: "/sandbox/.future/../secret",
        };
      },
    },
    {
      name: "an inference smoke path with a backslash",
      field: "inference.sandbox_smoke.config_path",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").sandbox_smoke = {
          kind: "compatible-endpoint",
          config_path: "/sandbox/.future\\config.json",
        };
      },
    },
    {
      name: "an inference smoke path with a control character",
      field: "inference.sandbox_smoke.config_path",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").sandbox_smoke = {
          kind: "compatible-endpoint",
          config_path: "/sandbox/.future/config\u001b.json",
        };
      },
    },
    {
      name: "an unsupported local context-window provider",
      field: "inference.context_window_requirements[0].provider",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").context_window_requirements = [
          { provider: "future-local", minimum_tokens: 64_000 },
        ];
      },
    },
    {
      name: "an unbounded local context-window minimum",
      field: "inference.context_window_requirements[0].minimum_tokens",
      update: (manifest) => {
        manifestRecordAt(manifest, "inference").context_window_requirements = [
          { provider: "ollama-local", minimum_tokens: 4_194_305 },
        ];
      },
    },
    {
      name: "an unknown onboarding field",
      field: "onboarding",
      update: (manifest) => {
        manifest.onboarding = { sandbox_name: "future", native_hook: "callback" };
      },
    },
    {
      name: "an unknown sandbox-create field",
      field: "sandbox_create",
      update: (manifest) => {
        manifest.sandbox_create = { native_hook: "callback" };
      },
    },
    {
      name: "an unknown sandbox startup control",
      field: "sandbox_create.startup_controls",
      update: (manifest) => {
        manifest.sandbox_create = { startup_controls: ["native-hook"] };
      },
    },
    {
      name: "duplicate Docker ulimit names",
      field: "sandbox_create.docker_ulimits",
      update: (manifest) => {
        manifest.sandbox_create = {
          docker_ulimits: [
            { name: "nofile", soft: 1024, hard: 2048 },
            { name: "nofile", soft: 2048, hard: 4096 },
          ],
        };
      },
    },
    {
      name: "a Docker ulimit whose hard value is below its soft value",
      field: "sandbox_create.docker_ulimits[0].hard",
      update: (manifest) => {
        manifest.sandbox_create = {
          docker_ulimits: [{ name: "nofile", soft: 2048, hard: 1024 }],
        };
      },
    },
    {
      name: "an unknown web-search field",
      field: "web_search",
      update: (manifest) => {
        manifest.web_search = {
          support: "providers",
          providers: [tavilyWebSearchBinding()],
          native_hook: "callback",
        };
      },
    },
    {
      name: "a non-canonical web-search config path",
      field: "web_search.providers[0].config_verification.path",
      update: (manifest) => {
        const binding = tavilyWebSearchBinding();
        (binding.config_verification as Record<string, unknown>).path =
          "/sandbox/.future/../secret";
        manifest.web_search = { support: "providers", providers: [binding] };
      },
    },
    {
      name: "an unbounded web-search provider profile type",
      field: "web_search.providers[0].profile_type",
      update: (manifest) => {
        const binding = tavilyWebSearchBinding();
        binding.profile_type = `a${"b".repeat(64)}`;
        manifest.web_search = { support: "providers", providers: [binding] };
      },
    },
    {
      name: "a web-search verification URL carrying credentials",
      field: "web_search.providers[0].egress_verification.url",
      update: (manifest) => {
        const binding = tavilyWebSearchBinding();
        (binding.egress_verification as Record<string, unknown>).url =
          "https://credential@search.example.test/query";
        manifest.web_search = { support: "providers", providers: [binding] };
      },
    },
    {
      name: "an unknown MCP field",
      field: "mcp",
      update: (manifest) => {
        manifest.mcp = { support: "disabled", native_hook: "callback" };
      },
    },
    {
      name: "an unknown agent roster field",
      field: "agent_roster",
      update: (manifest) => {
        manifest.agent_roster = {
          support: "managed",
          adapter: "agent-roster",
          onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
          command: "run-anything",
        };
      },
    },
    {
      name: "a package-selected agent roster adapter",
      field: "agent_roster.adapter",
      update: (manifest) => {
        manifest.agent_roster = {
          support: "managed",
          adapter: "future-adapter",
          onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
        };
      },
    },
    {
      name: "an unknown policy field",
      field: "policy",
      update: (manifest) => {
        manifest.policy = {
          owned_presets: [],
          automatic_presets: [],
          baseline_exclusion_impacts: {},
          native_hook: "callback",
        };
      },
    },
    {
      name: "a policy context target that escapes the sandbox root",
      field: "policy.context_target",
      update: (manifest) => {
        manifest.policy = {
          context_target: "/sandbox/../host/POLICY.md",
          owned_presets: [],
          automatic_presets: [],
          baseline_exclusion_impacts: {},
        };
      },
    },
    {
      name: "a non-canonical owned policy preset",
      field: "policy.owned_presets",
      update: (manifest) => {
        manifest.policy = {
          owned_presets: ["Future Tools"],
          automatic_presets: [],
          baseline_exclusion_impacts: {},
        };
      },
    },
    {
      name: "an automatic policy preset that is not package-owned",
      field: "policy.automatic_presets[0].name",
      update: (manifest) => {
        manifest.policy = {
          owned_presets: [],
          automatic_presets: [
            {
              name: "future-tools",
              activation: { kind: "always" },
              apply_during_create: false,
              suppress_in_tiers: [],
            },
          ],
          baseline_exclusion_impacts: {},
        };
      },
    },
    {
      name: "an automatic policy preset without a create-stage declaration",
      field: "policy.automatic_presets[0]",
      update: (manifest) => {
        manifest.policy = {
          owned_presets: ["future-tools"],
          automatic_presets: [
            {
              name: "future-tools",
              activation: { kind: "always" },
              suppress_in_tiers: [],
            },
          ],
          baseline_exclusion_impacts: {},
        };
      },
    },
    {
      name: "an unbounded policy impact disclosure",
      field: "policy.baseline_exclusion_impacts.future_api",
      update: (manifest) => {
        manifest.policy = {
          owned_presets: [],
          automatic_presets: [],
          baseline_exclusion_impacts: { future_api: "x".repeat(513) },
        };
      },
    },
    {
      name: "an MCP bridge without its adapter",
      field: "mcp.adapter",
      update: (manifest) => {
        manifest.mcp = {
          support: "bridge",
          policy_binaries: ["/usr/local/bin/future-terminal"],
        };
      },
    },
    {
      name: "an unknown package registry field",
      field: "package_registry",
      update: (manifest) => {
        manifest.package_registry = {
          hosts: ["registry.example.test"],
          binary: "/usr/local/bin/future-package",
          native_hook: "callback",
        };
      },
    },
    {
      name: "a package registry without its binary",
      field: "package_registry.binary",
      update: (manifest) => {
        manifest.package_registry = { hosts: ["registry.example.test"] };
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const manifest = validManifestValue();
      fixture.update(manifest);
      expectManifestValidationError(manifest, fixture.field);
    });
  }
});

test("accepts typed sandbox-create, web-search, and messaging-route declarations", () => {
  const manifest = validManifestValue();
  manifest.sandbox_create = {
    generated_image_build: "local-buildkit-required",
    startup_controls: ["approval-mode", "observability"],
    docker_ulimits: [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ],
    driver_mounts: [
      {
        type: "tmpfs",
        drivers: ["docker", "podman"],
        target: "/run/future-harness",
        options: ["noexec"],
        size_bytes: 1_048_576,
        mode: 0o1777,
      },
    ],
  };
  manifest.web_search = {
    support: "providers",
    providers: [tavilyWebSearchBinding()],
    tool_gateway_conflicts: [{ provider: "tavily", tool_gateway: "future-search" }],
  };
  manifestRecordAt(manifest, "inference").refresh_route_for_messaging_providers = [
    "compatible-endpoint",
  ];
  manifestRecordAt(manifest, "inference").route_probe = {
    rebuild_preflight: "inference-invocation",
  };

  assert.doesNotThrow(() => validateHarnessManifest(manifest, "future-terminal"));
});

test("accepts an exact package-published managed image without a stock harness identity", () => {
  const manifest = validManifestValue();
  manifest.managed_image = {
    repository: "registry.example/team/future-terminal",
    architectures: ["linux/amd64", "linux/arm64"],
    runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    publication: {
      source: {
        repository: "ExampleOrg/future-terminal",
        revision: "a".repeat(40),
        release: "v1.2.3",
        cohort: "build-2026.09.05",
      },
      digests: {
        "linux/amd64": `sha256:${"ab".repeat(32)}`,
        "linux/arm64": `sha256:${"cd".repeat(32)}`,
      },
    },
  };

  assert.doesNotThrow(() => validateHarnessManifest(manifest, "future-terminal"));
});

test("accepts finite base-image requirements without executable manifest hooks", () => {
  const manifest = validManifestValue();
  manifest.managed_image = {
    repository: "registry.example/team/future-terminal",
    architectures: ["linux/amd64"],
    runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    base_image: {
      corporate_ca: true,
      security_inventory: true,
      package_probe: true,
      pinned_remote: {
        argument: "BASE_IMAGE",
        ref: `registry.example/team/future-terminal-base@sha256:${"ab".repeat(32)}`,
      },
    },
  };

  assert.doesNotThrow(() => validateHarnessManifest(manifest, "future-terminal"));
  for (const [field, value] of [
    ["command", ["/tmp/probe"]],
    ["probe_path", "./probe.sh"],
  ] as const) {
    const invalidManifest = structuredClone(manifest);
    const baseImage = manifestRecordAt(
      manifestRecordAt(invalidManifest, "managed_image"),
      "base_image",
    );
    baseImage[field] = value;
    expectManifestValidationError(invalidManifest, "managed_image.base_image");
  }
});

test("rejects malformed and unknown package publication fields", async (t) => {
  const validManagedImage = () => ({
    repository: "registry.example/team/future-terminal",
    architectures: ["linux/amd64"],
    runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    publication: {
      source: {
        repository: "ExampleOrg/future-terminal",
        revision: "a".repeat(40),
        release: "v1.2.3",
        cohort: "build-42",
      },
      digests: { "linux/amd64": `sha256:${"ab".repeat(32)}` },
    },
  });
  const cases: readonly {
    readonly name: string;
    readonly field: string;
    readonly update: (image: ReturnType<typeof validManagedImage>) => void;
  }[] = [
    {
      name: "mutable digest",
      field: "managed_image.publication.digests.linux/amd64",
      update: (image) => {
        image.publication.digests["linux/amd64"] = "latest";
      },
    },
    {
      name: "missing platform digest",
      field: "managed_image.publication.digests",
      update: (image) => {
        image.architectures.push("linux/arm64");
      },
    },
    {
      name: "mutable source revision",
      field: "managed_image.publication.source.revision",
      update: (image) => {
        image.publication.source.revision = "main";
      },
    },
    {
      name: "executable selector",
      field: "managed_image.publication",
      update: (image) => {
        (image.publication as Record<string, unknown>).command = "pull-latest";
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const manifest = validManifestValue();
      const image = validManagedImage();
      fixture.update(image);
      manifest.managed_image = image;
      expectManifestValidationError(manifest, fixture.field);
    });
  }
});

test("rejects invalid optional root metadata types", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly field: string;
    readonly update: (manifest: Record<string, unknown>) => void;
  }[] = [
    {
      name: "a non-string alias summary",
      field: "alias_summary",
      update: (manifest) => {
        manifest.alias_summary = false;
      },
    },
    {
      name: "an unknown version scheme",
      field: "version_scheme",
      update: (manifest) => {
        manifest.version_scheme = "rolling";
      },
    },
    {
      name: "non-string phone-home hosts",
      field: "phone_home_hosts",
      update: (manifest) => {
        manifest.phone_home_hosts = ["example.test", 443];
      },
    },
    {
      name: "a non-boolean device pairing flag",
      field: "device_pairing",
      update: (manifest) => {
        manifest.device_pairing = "false";
      },
    },
    {
      name: "an unknown web authentication method",
      field: "web_auth_method",
      update: (manifest) => {
        manifest.web_auth_method = "native-callback";
      },
    },
    {
      name: "an invalid web authentication environment name",
      field: "web_auth_env",
      update: (manifest) => {
        manifest.web_auth_env = "NOT VALID";
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const manifest = validManifestValue();
      fixture.update(manifest);
      expectManifestValidationError(manifest, fixture.field);
    });
  }
});

test("the package validator binary emits one JSON conformance report", () => {
  const packageRoot = createPackageFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(CONTRACT_ROOT, "validate-package.mts"), "--json", packageRoot],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { harnessId?: unknown; packedFiles?: unknown };
    assert.equal(report.harnessId, "future-terminal");
    assert.ok(Array.isArray(report.packedFiles));
  } finally {
    removeFixture(packageRoot);
  }
});

test("accepts a finite managed process lifecycle command for a gateway package", () => {
  const manifest = validManifestValue();
  addGatewayRuntimeSurfaces(manifest);
  manifestRecordAt(manifest, "runtime").process_lifecycle = {
    support: "managed",
    command: ["/opt/future/process-control", "--structured"],
  };
  const packageRoot = createPackageFixture({
    manifest: `${stringifyYaml(manifest)}`,
  });
  try {
    assert.equal(validateHarnessPackage(packageRoot).harnessId, "future-terminal");
  } finally {
    removeFixture(packageRoot);
  }
});

test("requires the conventional image probe selected by managed-image data", () => {
  const packageRoot = createPackageFixture({
    files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "checks/image-probe.py"],
    manifest: validPackageManifest({
      additional: [
        "managed_image:",
        "  repository: registry.example/team/future-terminal",
        "  architectures: [linux/amd64]",
        "  runtime_identity:",
        "    uid: 1000",
        "    gid: 1000",
        "    workdir: /sandbox",
        "  base_image:",
        "    package_probe: true",
      ],
    }),
  });
  try {
    writeFile(
      packageRoot,
      "host/startup-adapter.cts",
      '"use strict";\nmodule.exports = Object.freeze({});\n',
    );

    const error = expectDiagnostic(packageRoot, "file-type", "checks/image-probe.py");
    assert.match(error.message, /conventional package probe/u);
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects malformed data-only contract fields before package consumption", async (t) => {
  const cases = [
    {
      name: "a runtime without an explicit kind",
      manifest: validPackageManifest().replace("  kind: terminal\n", ""),
      field: "runtime.kind",
    },
    {
      name: "a terminal runtime without a command",
      manifest: validPackageManifest()
        .replace("  interactive_command: future-terminal\n", "")
        .replace("  headless_command: future-terminal --prompt\n", ""),
      field: "runtime",
    },
    {
      name: "unsafe description text",
      manifest: validPackageManifest({ additional: ["description: ' leading space'"] }),
      field: "description",
    },
    {
      name: "an invented top-level contract field",
      manifest: validPackageManifest({ additional: ["native_callback: run-anything"] }),
      field: "<root>",
    },
    {
      name: "an absolute configuration file",
      manifest: validPackageManifest().replace(
        "  config_file: config.json",
        "  config_file: /sandbox/config.json",
      ),
      field: "config.config_file",
    },
    {
      name: "a configuration directory at the filesystem root",
      manifest: validPackageManifest().replace("  dir: /sandbox/.future-terminal", "  dir: /"),
      field: "config.dir",
    },
    {
      name: "a configuration directory outside the sandbox root",
      manifest: validPackageManifest().replace(
        "  dir: /sandbox/.future-terminal",
        "  dir: /etc/future",
      ),
      field: "config.dir",
    },
    {
      name: "a noncanonical configuration directory",
      manifest: validPackageManifest().replace(
        "  dir: /sandbox/.future-terminal",
        "  dir: /sandbox/../etc/future",
      ),
      field: "config.dir",
    },
    {
      name: "a parent-relative configuration file",
      manifest: validPackageManifest().replace(
        "  config_file: config.json",
        "  config_file: ../config.json",
      ),
      field: "config.config_file",
    },
    {
      name: "a parent-relative environment file",
      manifest: validPackageManifest().replace(
        "  config_file: config.json",
        "  config_file: config.json\n  env_file: ../secrets.env",
      ),
      field: "config.env_file",
    },
    {
      name: "a noncanonical authentication file",
      manifest: validPackageManifest().replace(
        "  config_file: config.json",
        "  config_file: config.json\n  auth_file: credentials/./auth.json",
      ),
      field: "config.auth_file",
    },
    {
      name: "an escaping shields file",
      manifest: validPackageManifest().replace(
        "  config_file: config.json",
        "  config_file: config.json\n  shields_files:\n    - ../fabric.json",
      ),
      field: "config.shields_files",
    },
    {
      name: "an incomplete mutable inference declaration",
      manifest: validPackageManifest().replace(
        [
          "    support: unsupported",
          "    reason: This synthetic package has fixed inference configuration.",
        ].join("\n"),
        "    support: mutable",
      ),
      field: "inference.config_update",
    },
    {
      name: "an MCP bridge without policy binaries",
      manifest: validPackageManifest({
        mcp: ["mcp:", "  support: bridge", "  adapter: future-terminal"],
      }),
      field: "mcp.policy_binaries",
    },
    {
      name: "an empty messaging channel declaration",
      manifest: validPackageManifest({
        messaging: ["messaging:", "  support: channels", "  channels: []"],
      }),
      field: "messaging.channels",
    },
    {
      name: "an unsupported session operation",
      manifest: validPackageManifest({
        additional: ["sessions:", "  operations:", "    - launch"],
      }),
      field: "sessions.operations",
    },
    {
      name: "a root managed-image identity",
      manifest: validPackageManifest({
        additional: [
          "managed_image:",
          "  repository: ghcr.io/example/future-terminal",
          "  architectures:",
          "    - linux/amd64",
          "  runtime_identity:",
          "    uid: 0",
          "    gid: 1000",
          "    workdir: /sandbox",
        ],
      }),
      field: "managed_image.runtime_identity.uid",
    },
    {
      name: "an enum restore key without values",
      manifest: validPackageManifest({
        additional: [
          "state_files:",
          "  - path: config.json",
          "    restore:",
          "      merge: key-allowlist",
          "      user_keys:",
          "        - key: feature.mode",
          "          type: enum",
        ],
      }),
      field: "state_files[0].restore.user_keys[0].values",
    },
    {
      name: "a missing state lifecycle declaration",
      manifest: validPackageManifest().replace(
        [
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
          "      reason: This package does not run scheduled work.",
          "    post_restore:",
          "      kind: not-required",
          "",
        ].join("\n"),
        "",
      ),
      field: "state_lifecycle",
    },
    {
      name: "a terminal runtime requesting a snapshot restart",
      manifest: validPackageManifest().replace(
        "  snapshot_restore: []",
        "  snapshot_restore: [restart-runtime]",
      ),
      field: "state_lifecycle.snapshot_restore",
    },
    {
      name: "a noncanonical preserved environment render target",
      manifest: validPackageManifest().replace(
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
        ].join("\n"),
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
          "    preserved_environment:",
          "      files:",
          "        - path: routing.env",
          "          patterns: ['FUTURE_*']",
          "          render_target: ~/.future/./routes.env",
        ].join("\n"),
      ),
      field: "state_lifecycle.rebuild.preserved_environment.files[0].render_target",
    },
    {
      name: "a credential-shaped preserved environment pattern",
      manifest: validPackageManifest().replace(
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
        ].join("\n"),
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
          "    preserved_environment:",
          "      files:",
          "        - path: routing.env",
          "          patterns: ['*TOKEN*']",
          "          render_target: ~/.future/routes.env",
        ].join("\n"),
      ),
      field: "state_lifecycle.rebuild.preserved_environment.files[0].patterns",
    },
    {
      name: "a relative state backup readiness command",
      manifest: validPackageManifest().replace(
        ["  backup_quiescence:", "    kind: not-required"].join("\n"),
        [
          "  backup_quiescence:",
          "    kind: command",
          "    command: [state-ready]",
          "    timeout_seconds: 15",
        ].join("\n"),
      ),
      field: "state_lifecycle.backup_quiescence.command[0]",
    },
    {
      name: "an arbitrary rebuild native callback",
      manifest: validPackageManifest().replace(
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
        ].join("\n"),
        [
          "    managed_extensions:",
          "      support: disabled",
          "      reason: Test package has no managed extensions.",
          "    native_callback: run-native-callback",
        ].join("\n"),
      ),
      field: "state_lifecycle.rebuild",
    },
    {
      name: "an agent timeout option outside value options",
      manifest: validPackageManifest().replace(
        "  headless_command: future-terminal --prompt\n",
        [
          "  headless_command: future-terminal --prompt",
          "  agent_command:",
          "    argv: [future-terminal, agent]",
          "    output_mode: bounded-text",
          "    value_options: [--message]",
          "    timeout_option: --timeout",
          "",
        ].join("\n"),
      ),
      field: "runtime.agent_command.timeout_option",
    },
    {
      name: "a relative process lifecycle controller command",
      manifest: (() => {
        const manifest = validManifestValue();
        addGatewayRuntimeSurfaces(manifest);
        manifestRecordAt(manifest, "runtime").process_lifecycle = {
          support: "managed",
          command: ["future-process-control"],
        };
        return stringifyYaml(manifest);
      })(),
      field: "runtime.process_lifecycle.command[0]",
    },
    {
      name: "duplicate agent command arguments",
      manifest: validPackageManifest().replace(
        "  headless_command: future-terminal --prompt\n",
        [
          "  headless_command: future-terminal --prompt",
          "  agent_command:",
          "    argv: [future-terminal, future-terminal]",
          "    output_mode: direct",
          "",
        ].join("\n"),
      ),
      field: "runtime.agent_command.argv",
    },
    {
      name: "a privileged forwarded port",
      manifest: validPackageManifest({ additional: ["forward_ports: [80]"] }),
      field: "forward_ports[0]",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const packageRoot = createPackageFixture({ manifest: fixture.manifest });
      try {
        const error = expectDiagnostic(packageRoot, "manifest", "manifest.yaml");
        assert.ok(error.message.includes(fixture.field));
      } finally {
        removeFixture(packageRoot);
      }
    });
  }
});

test("rejects package identity and manifest identity mismatches before packing", async (t) => {
  const cases = [
    {
      name: "a package name without the nemoclaw prefix",
      options: { name: "@example/future-terminal" },
      code: "metadata",
      relativePath: "package.json",
    },
    {
      name: "a package version with a leading zero",
      options: { version: "03.2.1" },
      code: "metadata",
      relativePath: "package.json",
    },
    {
      name: "a manifest name that differs from the package name",
      options: { manifest: "name: another-harness\n" },
      code: "manifest-identity",
      relativePath: "manifest.yaml",
    },
  ] as const;
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const packageRoot = createPackageFixture(fixture.options);
      try {
        expectDiagnostic(packageRoot, fixture.code, fixture.relativePath);
      } finally {
        removeFixture(packageRoot);
      }
    });
  }
});

test("requires one exact minimum compatible NemoClaw version", async (t) => {
  for (const minimumNemoClawVersion of ["0.0", "v0.0.113", "00.0.113", "0.0.113-beta"]) {
    await t.test(`rejects ${minimumNemoClawVersion}`, () => {
      const packageRoot = createPackageFixture({ minimumNemoClawVersion });
      try {
        expectDiagnostic(packageRoot, "metadata", "package.json");
      } finally {
        removeFixture(packageRoot);
      }
    });
  }

  await t.test("rejects a missing declaration", () => {
    const packageRoot = createPackageFixture();
    try {
      updatePackageJson(packageRoot, (value) => {
        const nemoclaw = value.nemoclaw as Record<string, unknown>;
        delete nemoclaw.minimumNemoClawVersion;
      });
      expectDiagnostic(packageRoot, "metadata", "package.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("requires one ordered exact maximum compatible NemoClaw version", async (t) => {
  for (const maximumNemoClawVersionExclusive of [
    "0.0",
    "v0.0.114",
    "00.0.114",
    "0.0.114-beta",
    "0.0.113",
    "0.0.112",
  ]) {
    await t.test(`rejects ${maximumNemoClawVersionExclusive}`, () => {
      const packageRoot = createPackageFixture({ maximumNemoClawVersionExclusive });
      try {
        expectDiagnostic(packageRoot, "metadata", "package.json");
      } finally {
        removeFixture(packageRoot);
      }
    });
  }

  await t.test("rejects a missing declaration", () => {
    const packageRoot = createPackageFixture();
    try {
      updatePackageJson(packageRoot, (value) => {
        const nemoclaw = value.nemoclaw as Record<string, unknown>;
        delete nemoclaw.maximumNemoClawVersionExclusive;
      });
      expectDiagnostic(packageRoot, "metadata", "package.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects aliases and deeply nested values in the bounded manifest", async (t) => {
  await t.test("a YAML alias", () => {
    const packageRoot = createPackageFixture({
      manifest: "name: future-terminal\nvalue: &shared [one]\ncopy: *shared\n",
    });
    try {
      expectDiagnostic(packageRoot, "manifest", "manifest.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a value beyond the manifest depth limit", () => {
    const nested = Array.from(
      { length: 18 },
      (_value, index) => `${"  ".repeat(index)}level${String(index)}:`,
    );
    const packageRoot = createPackageFixture({
      manifest: ["name: future-terminal", ...nested, `${"  ".repeat(18)}value: true`, ""].join(
        "\n",
      ),
    });
    try {
      expectDiagnostic(packageRoot, "manifest", "manifest.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects missing, linked, and non-executable runtime files", async (t) => {
  await t.test("a missing Dockerfile", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.rmSync(path.join(packageRoot, "Dockerfile"));
      expectDiagnostic(packageRoot, "file-type", "Dockerfile");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a linked Dockerfile", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.rmSync(path.join(packageRoot, "Dockerfile"));
      fs.symlinkSync("Dockerfile.base", path.join(packageRoot, "Dockerfile"));
      expectDiagnostic(packageRoot, "file-type", "Dockerfile");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a start script without an executable bit", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.chmodSync(path.join(packageRoot, "start.sh"), 0o644);
      expectDiagnostic(packageRoot, "start-mode", "start.sh");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("does not execute candidate tooling while inspecting typed adapter sources", () => {
  const packageRoot = createPackageFixture();
  const marker = path.join(packageRoot, "candidate-compiler-ran");
  try {
    writeFile(
      packageRoot,
      "host/source/config-adapter.cts",
      "const adapter = Object.freeze({});\nexport = adapter;\n",
    );
    writeFile(
      packageRoot,
      "node_modules/typescript/bin/tsc",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      0o755,
    );

    assert.doesNotThrow(() => validateHarnessPackage(packageRoot));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects authoring and credential files that npm would publish", async (t) => {
  await t.test("a test fixture in the archive", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "tests/leak.txt"],
    });
    try {
      writeFile(packageRoot, "tests/leak.txt", "authoring only\n");
      expectDiagnostic(packageRoot, "archive-authoring-path", "tests/leak.txt");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a credential-shaped file in the archive", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "credentials.json"],
    });
    try {
      writeFile(packageRoot, "credentials.json", '{"token":"not-a-real-secret"}\n');
      expectDiagnostic(packageRoot, "archive-credential-path", "credentials.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects an adapter artifact omitted from the npm archive", () => {
  const packageRoot = createPackageFixture({ files: REQUIRED_RUNTIME_FILES });
  try {
    expectDiagnostic(packageRoot, "archive-membership", "host/config-adapter.cts");
  } finally {
    removeFixture(packageRoot);
  }
});

test("requires compiled adapters for the capabilities declared by the manifest", async (t) => {
  const cases = [
    {
      name: "the universal configuration boundary",
      manifest: validPackageManifest(),
      artifact: "host/config-adapter.cts",
    },
    {
      name: "the universal messaging boundary",
      manifest: validPackageManifest(),
      artifact: "host/messaging-adapter.cts",
    },
    {
      name: "MCP bridge support",
      manifest: validPackageManifest({
        mcp: [
          "mcp:",
          "  support: bridge",
          "  adapter: future-terminal",
          "  policy_binaries:",
          "    - /usr/local/bin/future-terminal",
        ],
      }),
      artifact: "host/mcp-adapter.cts",
    },
    {
      name: "managed agent roster support",
      manifest: validPackageManifest({
        additional: [
          "agent_roster:",
          "  support: managed",
          "  adapter: agent-roster",
          "  onboarding_environment: NEMOCLAW_EXTRA_AGENTS_JSON",
        ],
      }),
      artifact: "host/agent-roster-adapter.cts",
    },
    {
      name: "the universal startup boundary",
      manifest: validPackageManifest(),
      artifact: "host/startup-adapter.cts",
    },
    {
      name: "package-owned configuration restore",
      manifest: validPackageManifest({
        additional: [
          "state_files:",
          "  - path: config.json",
          "    restore:",
          "      merge: package-config",
        ],
      }),
      artifact: "host/restore-adapter.cts",
    },
    {
      name: "managed provider broker",
      manifest: validPackageManifest({
        additional: [
          "provider_broker:",
          "  support: managed",
          "  adapter: provider-broker",
          "  operations: [describe-provider, register-refresh-provider, ensure-broker, inspect-broker, teardown-broker]",
        ],
      }),
      artifact: "host/provider-broker-adapter.cts",
    },
    {
      name: "managed provider authentication",
      manifest: validPackageManifest({
        additional: [
          "provider_auth:",
          "  support: managed",
          "  adapter: provider-auth",
          "  operation: resolve-auth-method",
          "  request_environment: [NEMOCLAW_FUTURE_AUTH_METHOD]",
          "  default_method: api-key",
          "  selection:",
          "    key: futureProvider",
          "    aliases: [future]",
          "    label: Future Provider",
          "    provider_name: future-provider",
          "    provider_type: openai",
          "    endpoint_url: https://inference.example.com/v1",
          "    help_url: https://example.com/keys",
          "    default_model: future/model",
          "    models: [future/model]",
          "    preferred_inference_api: openai-completions",
          "  methods:",
          "    - id: api-key",
          "      label: API key",
          "      kind: api-key",
          "      credential_env: FUTURE_API_KEY",
          "      source_env: FUTURE_API_KEY",
          "      prompt_label: Future API key",
        ],
      }),
      artifact: "host/provider-auth-adapter.cts",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const packageRoot = createPackageFixture({ manifest: fixture.manifest });
      try {
        if (fixture.artifact !== "host/config-adapter.cts") {
          writeFile(
            packageRoot,
            fixture.artifact,
            '"use strict";\nmodule.exports = Object.freeze({});\n',
          );
        }
        fs.rmSync(path.join(packageRoot, fixture.artifact));
        expectDiagnostic(packageRoot, "adapter-artifact", fixture.artifact);
      } finally {
        removeFixture(packageRoot);
      }
    });
  }
});

test("requires the conventional managed provider-broker controller", async (t) => {
  const packageRoot = createPackageFixture({
    manifest: validPackageManifest({
      additional: [
        "provider_broker:",
        "  support: managed",
        "  adapter: provider-broker",
        "  operations: [describe-provider, register-refresh-provider, ensure-broker, inspect-broker, teardown-broker]",
      ],
    }),
  });
  try {
    writeFile(
      packageRoot,
      "host/provider-broker-adapter.cts",
      '"use strict";\nmodule.exports = Object.freeze({});\n',
    );
    await t.test("when it is missing", () => {
      expectDiagnostic(packageRoot, "provider-broker-artifact", "host/provider-broker-control.cts");
    });
    await t.test("when it is empty", () => {
      writeFile(packageRoot, "host/provider-broker-control.cts", "");
      expectDiagnostic(packageRoot, "provider-broker-artifact", "host/provider-broker-control.cts");
    });
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects typed adapter source that npm would publish", () => {
  const packageRoot = createPackageFixture({
    files: [...REQUIRED_RUNTIME_FILES, "host/**"],
  });
  try {
    addTypedAdapterSource(packageRoot);
    expectDiagnostic(packageRoot, "archive-authoring-path", "host/source/config-adapter.cts");
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects unsupported CLI options without reading a package", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(CONTRACT_ROOT, "validate-package.mts"), "--execute-scripts", "."],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage: nemoclaw-validate-package [--json] <package-root>\n");
});
