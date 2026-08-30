// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type BundledHarnessSourceRole = "harness-owned" | "legacy-layout" | "temporary-shared";

export interface BundledHarnessSourceMapping {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceType: "file" | "tree";
  readonly role: BundledHarnessSourceRole;
}

export interface BundledHarnessSourceDeclaration {
  readonly id: "openclaw" | "hermes" | "langchain-deepagents-code";
  readonly displayName: string;
  readonly packageVersion: string;
  readonly manifestPath: string;
  readonly mappings: readonly BundledHarnessSourceMapping[];
}

/**
 * Phase 3 replaces this named repository-layout adapter with self-contained package roots.
 * In particular, the temporary shared-tree allowances must not survive that extraction.
 */
export const BUNDLED_SOURCE_MAPPING_REMOVAL_PHASE = 3 as const;

const COMMON_NATIVE_SECURITY_FILES = [
  "scripts/security/build-native-security-packages.sh",
  "scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
  "scripts/security/patches/python3.13-htmlparser-cve-2026-15308.patch",
  "scripts/security/build-perl-security-packages.sh",
  "scripts/security/patches/perl-5.44.0-net-ping-capability-tests.patch",
] as const;

const COMMON_NPM_REMEDIATION_FILES = [
  "scripts/lib/reviewed-npm-archive.mts",
  "scripts/lib/bundled-npm-package.mts",
  "scripts/patch-bundled-npm-brace-expansion.mts",
  "scripts/lib/patch-bundled-npm-ip-address.mts",
  "scripts/patch-bundled-npm-tar.mts",
  "scripts/upgrade-bundled-npm.mts",
] as const;

const COMMON_MANAGED_STARTUP_FILES = [
  "scripts/managed-bootstrap-entrypoint.c",
  "scripts/managed-bootstrap-trampoline.sh",
  "scripts/managed-startup-hold.sh",
] as const;

const COMMON_SANDBOX_FILES = [
  "scripts/lib/entrypoint-env-wrapper.sh",
  "scripts/lib/sandbox-rlimits.sh",
] as const;

function sourceFile(
  sourcePath: string,
  role: BundledHarnessSourceRole = "temporary-shared",
): BundledHarnessSourceMapping {
  return Object.freeze({ sourcePath, destinationPath: sourcePath, sourceType: "file", role });
}

function sourceFileAt(
  sourcePath: string,
  destinationPath: string,
  role: BundledHarnessSourceRole,
): BundledHarnessSourceMapping {
  return Object.freeze({ sourcePath, destinationPath, sourceType: "file", role });
}

function sourceTree(
  sourcePath: string,
  role: BundledHarnessSourceRole = "temporary-shared",
): BundledHarnessSourceMapping {
  return Object.freeze({ sourcePath, destinationPath: sourcePath, sourceType: "tree", role });
}

function sourceFiles(
  paths: readonly string[],
  role: BundledHarnessSourceRole = "temporary-shared",
): readonly BundledHarnessSourceMapping[] {
  return paths.map((sourcePath) => sourceFile(sourcePath, role));
}

const OPENCLAW_SCRIPT_FILES = [
  "scripts/checks/verify-openshell-policy-boundary-dependencies.mts",
  "scripts/checks/materialize-locked-npm-cache-seed.mts",
  "scripts/lib/seed-reviewed-npm-cache.mts",
  "scripts/lib/reviewed-npm-audit.mts",
  "scripts/lib/openclaw-npm-remediation.mts",
  "scripts/patch-openclaw-tool-catalog.mts",
  "scripts/patch-openclaw-chat-send.mts",
  "scripts/patch-openclaw-mcp-npx.mts",
  "scripts/patch-openclaw-mcp-reliability.mts",
  "scripts/patch-openclaw-mcp-tools-list-timeout.mts",
  "scripts/patch-openclaw-issue-4434-diagnostics.mts",
  "scripts/patch-openclaw-managed-transport-diagnostics.mts",
  "scripts/patch-openclaw-device-self-approval.mts",
  "scripts/openclaw/patch-gateway-daemon-dialback.mts",
  "scripts/extract-semver.sh",
  "scripts/patch-openclaw-shared-state-permissions.mts",
  "scripts/verify-wechat-runtime-lock.mts",
  "scripts/lib/sandbox-init.sh",
  "scripts/lib/corporate-ca-runtime.sh",
  "scripts/lib/gateway-supervisor.sh",
  "scripts/lib/openclaw_device_approval_policy.py",
  "scripts/lib/clean_runtime_shell_env_shim.py",
  "scripts/lib/normalize_mutable_config_perms.py",
  "scripts/state-dir-guard.py",
  "scripts/openclaw-config-guard.py",
  "scripts/managed-gateway-control.py",
  "scripts/nemoclaw-start.sh",
  "scripts/gateway-control.sh",
  "scripts/codex-acp-wrapper.sh",
  "scripts/generate-openclaw-config.mts",
  "scripts/validate-openclaw-tool-search.mts",
] as const;

const HERMES_SCRIPT_FILES = [
  "scripts/lib/openclaw-npm-remediation.mts",
  "scripts/lib/sandbox-init.sh",
  "scripts/lib/corporate-ca-runtime.sh",
  "scripts/lib/gateway-supervisor.sh",
  "scripts/gateway-control.sh",
  "scripts/managed-gateway-control.py",
  "scripts/state-dir-guard.py",
  "scripts/runtime-state-mutation-control.py",
  "scripts/runtime-state-mutation-startup-gate.py",
  "scripts/runtime_state_mutation_hermes_publisher.py",
  "scripts/checks/download-hermes-source-archive.sh",
] as const;

const STANDARD_SOURCES: readonly BundledHarnessSourceDeclaration[] = Object.freeze(
  (
    [
      {
        id: "openclaw",
        displayName: "OpenClaw",
        packageVersion: "0.1.1",
        manifestPath: "agents/openclaw/manifest.yaml",
        mappings: [
          ...sourceFiles(
            [
              "agents/openclaw/manifest.yaml",
              "agents/openclaw/policy-permissive.yaml",
              "agents/openclaw/state-lock-plan.json",
            ],
            "harness-owned",
          ),
          sourceTree("agents/openclaw/managed-image-messaging-runtime", "harness-owned"),
          sourceTree("agents/openclaw/mcporter-runtime", "harness-owned"),
          sourceTree("agents/openclaw/openclaw-runtime", "harness-owned"),
          sourceTree("agents/openclaw/wechat-runtime", "harness-owned"),
          sourceFileAt("Dockerfile", "agents/openclaw/Dockerfile", "legacy-layout"),
          sourceFile("Dockerfile", "legacy-layout"),
          sourceFile("Dockerfile.base", "legacy-layout"),
          sourceTree("nemoclaw", "legacy-layout"),
          sourceTree("nemoclaw-blueprint", "legacy-layout"),
          sourceTree("src/lib/messaging"),
          sourceTree("tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle"),
          sourceTree("tools/mcp-tool-discovery-runtime/npm-cache-seed"),
          sourceFile("tools/mcp-tool-discovery-runtime/npm-ci-locked.sh"),
          sourceFile("tsconfig.runtime-preloads.json"),
          sourceFile("ci/npm-audit-exceptions.json"),
          sourceFile("src/lib/tool-disclosure.ts"),
          ...sourceFiles(COMMON_NATIVE_SECURITY_FILES),
          ...sourceFiles(COMMON_NPM_REMEDIATION_FILES),
          ...sourceFiles(COMMON_MANAGED_STARTUP_FILES),
          ...sourceFiles(COMMON_SANDBOX_FILES),
          ...sourceFiles(OPENCLAW_SCRIPT_FILES),
        ],
      },
      {
        id: "hermes",
        displayName: "Hermes Agent",
        packageVersion: "0.1.0",
        manifestPath: "agents/hermes/manifest.yaml",
        mappings: [
          sourceTree("agents/hermes", "harness-owned"),
          sourceTree("nemoclaw-blueprint"),
          sourceTree("src/lib/messaging"),
          sourceTree("tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle"),
          sourceFile("tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.21.tgz"),
          sourceFile("src/lib/hermes-managed-route.ts"),
          sourceFile("src/lib/tool-disclosure.ts"),
          sourceFile("src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json"),
          ...sourceFiles(COMMON_NATIVE_SECURITY_FILES),
          ...sourceFiles(COMMON_NPM_REMEDIATION_FILES),
          ...sourceFiles(COMMON_MANAGED_STARTUP_FILES),
          ...sourceFiles(COMMON_SANDBOX_FILES),
          ...sourceFiles(HERMES_SCRIPT_FILES),
        ],
      },
      {
        id: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        packageVersion: "0.1.3",
        manifestPath: "agents/langchain-deepagents-code/manifest.yaml",
        mappings: [
          sourceTree("agents/langchain-deepagents-code", "harness-owned"),
          sourceFile("packages/nemoclaw-fabric/README.md"),
          sourceFile("packages/nemoclaw-fabric/build-requirements.lock"),
          sourceFile("packages/nemoclaw-fabric/pyproject.toml"),
          sourceTree("packages/nemoclaw-fabric/src"),
          sourceTree("nemoclaw-blueprint"),
          sourceTree("tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle"),
          sourceFile("src/lib/inference/managed-dcode/identity.ts"),
          ...sourceFiles(COMMON_NATIVE_SECURITY_FILES),
          ...sourceFiles(COMMON_NPM_REMEDIATION_FILES),
          ...sourceFiles(COMMON_MANAGED_STARTUP_FILES),
          ...sourceFiles(COMMON_SANDBOX_FILES),
        ],
      },
    ] satisfies readonly BundledHarnessSourceDeclaration[]
  ).map((source) => Object.freeze({ ...source, mappings: Object.freeze([...source.mappings]) })),
);

/** Return the closed, reviewed standard harness sources bundled by this NemoClaw build. */
export function listBundledHarnessSources(): readonly BundledHarnessSourceDeclaration[] {
  return STANDARD_SOURCES;
}
