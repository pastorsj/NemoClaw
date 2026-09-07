#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { packReviewedNpmArchive } from "../../../../../scripts/lib/reviewed-npm-archive.mts";
import LEGACY_CHANNEL_MANIFESTS from "../../channels/legacy-manifests.ts";
import type {
  ChannelAgentPackageManager,
  ChannelAgentPackageRuntimeLockSpec,
  HarnessMessagingBuildProfile,
  ChannelManifest,
} from "../../manifest/types.ts";
import type { HarnessMessagingChannelProfile } from "@nvidia/nemoclaw-harness-contract";
import {
  migrationOnlyEnvTargets,
  readEnvLineKey,
  staleCredentialEnvKeys,
} from "../credential-env-cleanup.ts";
import { allowRenderedPlugins } from "../rendered-plugin-allow.ts";
import {
  selectActiveMessagingChannelIds,
  selectEnabledMessagingAgentRender,
  selectEnabledPostAgentInstallBuildFiles,
} from "../../post-agent-install-selection.ts";

declare global {
  var NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD: boolean | undefined;
}

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;
type MessagingAgentId = string;
type MessagingHookPhase = "agent-install" | "post-agent-install";
type MessagingBuildCliPhase = MessagingBuildPhase | "managed-image-capability-union";
type MessagingRuntimeSetupKey = "nodePreloads" | "envAliases" | "secretScans";
type MessagingSerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly MessagingSerializableValue[]
  | { readonly [key: string]: MessagingSerializableValue };

type MessagingPlanChannel = {
  readonly channelId: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly hooks?: readonly MessagingPlanHook[];
};

type MessagingCredentialBinding = {
  readonly channelId: string;
  readonly credentialId?: string;
  readonly providerEnvKey?: unknown;
  readonly placeholder?: unknown;
};

type MessagingPlanHook = {
  readonly id: string;
  readonly phase: string;
  readonly handler: string;
  readonly outputs?: readonly MessagingPlanHookOutput[];
  readonly onFailure?: "abort" | "skip-channel";
};

type MessagingPlanHookOutput = {
  readonly id: string;
  readonly kind: string;
  readonly required?: boolean;
  readonly value?: MessagingSerializableValue;
};

type MessagingRenderEntry = {
  readonly channelId: string;
  readonly agent: MessagingAgentId;
  readonly target: string;
  readonly kind: "json-fragment" | "env-lines";
  readonly renderId?: string;
  readonly hookId?: string;
  readonly handler?: string;
  readonly path?: string;
  readonly value?: MessagingSerializableValue;
  readonly lines?: readonly string[];
  readonly templateRefs?: readonly string[];
};

type MessagingBuildStep = {
  readonly channelId: string;
  readonly kind: "build-arg" | "build-file" | "package-install";
  readonly hookId?: string;
  readonly handler?: string;
  readonly outputId: string;
  readonly required?: boolean;
  readonly value?: MessagingSerializableValue;
};

export type MessagingBuildPlan = {
  readonly schemaVersion: 1;
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly workflow?: string;
  readonly channels: readonly MessagingPlanChannel[];
  readonly disabledChannels?: readonly string[];
  readonly credentialBindings: readonly MessagingCredentialBinding[];
  readonly agentRender: readonly MessagingRenderEntry[];
  readonly buildSteps: readonly MessagingBuildStep[];
  readonly runtimeSetup?: Partial<Record<MessagingRuntimeSetupKey, readonly JsonObject[]>>;
  readonly packageBuild?: HarnessMessagingBuildProfile;
};

export type BuildFileOutput = {
  readonly path: string;
  readonly mode?: string;
  readonly content?: MessagingSerializableValue;
  readonly merge?: MessagingSerializableValue;
};

export type BuildCommandResult = {
  readonly channels: readonly string[];
  readonly runtimePlanPath: string;
  readonly doctorEnv: Record<string, string>;
  readonly installSpecs: readonly string[];
  readonly pythonPackages: readonly string[];
  readonly packageVersion: string;
  readonly hermesUvPackages?: readonly string[];
  readonly openclawVersion?: string;
};

type VerifiedNodePackageInstall = {
  readonly spec: string;
  readonly npmPackageSpec?: string;
  readonly integrity?: string;
  readonly tarballUrl?: string;
  readonly runtimeLock?: ChannelAgentPackageRuntimeLockSpec;
  readonly pin: boolean;
};
type OpenClawPluginInstall = VerifiedNodePackageInstall;

// Every trusted messaging plugin binds exact package identity, registry SRI,
// registry tarball URL, and packed-byte SRI before local archive installation.
// Keep these checks together when #5896 consolidates the archive installers.
export const NODE_PACKAGE_ARCHIVE_PROVENANCE_POLICY = Object.freeze({
  schemaVersion: 1,
  packageIdentity: "exact-npm-package-spec",
  registryIntegrityField: "dist.integrity",
  packedArchiveIntegrity: "must-match-committed-sri",
  registryTarballField: "dist.tarball",
  registryTarballUrl: "must-match-committed-url",
} as const);
export const OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY =
  NODE_PACKAGE_ARCHIVE_PROVENANCE_POLICY;

type PinnedPythonPackageInstall = {
  readonly spec: string;
};
type HermesUvPackageInstall = PinnedPythonPackageInstall;

function isPinnedPythonPackageSpec(spec: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*\])?==[A-Za-z0-9][A-Za-z0-9_.!+~-]*$/.test(
    spec,
  );
}
const isPinnedHermesUvPackageSpec = isPinnedPythonPackageSpec;

type MessagingRuntimeProfile = {
  readonly packageId: string;
  readonly build: HarnessMessagingBuildProfile;
  readonly channels: readonly HarnessMessagingChannelProfile[];
};

export class MessagingBuildApplierError extends Error {}

export const DEFAULT_MESSAGING_RUNTIME_PLAN_PATH =
  "/usr/local/share/nemoclaw/messaging-runtime-plan.json";

export function readMessagingBuildPlanFromEnv(
  env: Env,
  agent: MessagingAgentId,
): MessagingBuildPlan | null {
  const encoded = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!encoded || encoded.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must be base64-encoded JSON: ${formatError(error)}`,
    );
  }

  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.agent !== agent ||
    typeof parsed.sandboxName !== "string" ||
    !Array.isArray(parsed.channels) ||
    !Array.isArray(parsed.credentialBindings) ||
    !Array.isArray(parsed.agentRender) ||
    !Array.isArray(parsed.buildSteps)
  ) {
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must contain a ${agent} messaging plan`,
    );
  }
  return parsed as MessagingBuildPlan;
}

function readMessagingRuntimeProfile(profilePath: string, packageId: string): MessagingRuntimeProfile {
  if (!isAbsolute(profilePath)) {
    throw new MessagingBuildApplierError("--profile must be an absolute path");
  }
  let parsed: unknown;
  try {
    const metadata = lstatSync(profilePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) {
      throw new Error("profile is not a bounded regular file");
    }
    parsed = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (error) {
    throw new MessagingBuildApplierError(`Messaging runtime profile is invalid: ${formatError(error)}`);
  }
  if (
    !isObject(parsed) ||
    Object.keys(parsed).some((key) => !["packageId", "build", "channelsPath"].includes(key)) ||
    parsed.packageId !== packageId ||
    !isObject(parsed.build) ||
    typeof parsed.channelsPath !== "string" ||
    !/^[a-z][a-z0-9-]*\.json$/u.test(parsed.channelsPath)
  ) {
    throw new MessagingBuildApplierError("Messaging runtime profile does not match the selected package");
  }
  const channelsPath = resolve(dirname(profilePath), parsed.channelsPath);
  if (!channelsPath.startsWith(`${dirname(profilePath)}${sep}`)) {
    throw new MessagingBuildApplierError("Messaging runtime channel profile escapes its directory");
  }
  let channels: unknown;
  try {
    const metadata = lstatSync(channelsPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) {
      throw new Error("channel profile is not a bounded regular file");
    }
    channels = JSON.parse(readFileSync(channelsPath, "utf8"));
  } catch (error) {
    throw new MessagingBuildApplierError(`Messaging channel profile is invalid: ${formatError(error)}`);
  }
  if (!Array.isArray(channels)) {
    throw new MessagingBuildApplierError("Messaging channel profile must be an array");
  }
  const profile = {
    packageId: parsed.packageId,
    build: parsed.build,
    channels,
  } as unknown as MessagingRuntimeProfile;
  validateBuildProfile(profile.build, true);
  const channelIds = new Set<string>();
  for (const channel of profile.channels) {
    if (!isObject(channel) || typeof channel.channelId !== "string" || channelIds.has(channel.channelId)) {
      throw new MessagingBuildApplierError("Messaging runtime profile has invalid channels");
    }
    channelIds.add(channel.channelId);
    if (!isObject(channel.lifecycle) || !Array.isArray(channel.lifecycle.packageInstalls ?? [])) {
      throw new MessagingBuildApplierError("Messaging runtime profile has invalid package installs");
    }
  }
  return profile;
}

export function reviewedOpenClawPluginIntegrityByPackageSpec(
  env: Env = process.env,
  manifests: readonly ChannelManifest[] = LEGACY_CHANNEL_MANIFESTS,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const integrity = packageSpec.integrity ?? packageSpec.integrityByVersion?.[npmPackage.version];
      if (integrity) entries.push([npmPackage.packageSpec, integrity]);
    }
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

export function reviewedOpenClawPluginTarballUrlByPackageSpec(
  env: Env = process.env,
  manifests: readonly ChannelManifest[] = LEGACY_CHANNEL_MANIFESTS,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const tarballUrl = packageSpec.tarballUrl ?? packageSpec.tarballUrlByVersion?.[npmPackage.version];
      if (tarballUrl) entries.push([npmPackage.packageSpec, tarballUrl]);
    }
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

function reviewedOpenClawPluginRuntimeLocksByPackageSpec(
  env: Env,
  manifests: readonly ChannelManifest[],
): Readonly<Record<string, ChannelAgentPackageRuntimeLockSpec>> {
  const entries: [string, ChannelAgentPackageRuntimeLockSpec][] = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package" || !packageSpec.runtimeLock) continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      entries.push([npmPackage.packageSpec, packageSpec.runtimeLock]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function runtimePackageDeclarations(
  profile: MessagingRuntimeProfile,
  activeChannelIds?: ReadonlySet<string>,
) {
  return profile.channels.flatMap((channel) =>
    activeChannelIds && !activeChannelIds.has(channel.channelId)
      ? []
      : (channel.lifecycle.packageInstalls ?? []).map((install) => ({
          channelId: channel.channelId,
          ...install,
        })),
  );
}

function resolveRuntimePackageSpec(
  spec: string,
  profile: MessagingRuntimeProfile,
  env: Env,
): string {
  const versionEnvironment =
    profile.build.packageInstallers?.["node-package"]?.packageVersionEnvironment;
  const version = versionEnvironment ? sanitizeOptionalString(env[versionEnvironment]) : "";
  const resolved = spec.replaceAll("{{package.version}}", () => {
    if (!version) {
      throw new MessagingBuildApplierError(
        `${versionEnvironment ?? "Package version environment"} is required for the package version template`,
      );
    }
    return version;
  });
  if (/\{\{\s*[^}]+\s*\}\}/u.test(resolved)) {
    throw new MessagingBuildApplierError(`Unresolved package-install template in ${spec}`);
  }
  return resolved;
}

function selectedRuntimePackageDeclarations(
  plan: MessagingBuildPlan,
  profile: MessagingRuntimeProfile,
) {
  const declarations = runtimePackageDeclarations(profile, new Set(activeChannels(plan)));
  return enabledBuildStepsForPhase(plan, "agent-install")
    .filter((step) => step.kind === "package-install" && step.value !== undefined)
    .map((step) => {
      const value = step.value as JsonObject;
      const manager = readMessagingPackageManager(value, step.outputId);
      const declared = declarations.find(
        (candidate) =>
          candidate.channelId === step.channelId &&
          candidate.id === step.outputId &&
          candidate.manager === manager &&
          candidate.spec === value.spec,
      );
      if (!declared) {
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is not declared by the package runtime profile`,
        );
      }
      return declared;
    });
}

function collectRuntimeNodePackages(
  plan: MessagingBuildPlan | null,
  profile: MessagingRuntimeProfile,
  env: Env,
  allChannels = false,
): VerifiedNodePackageInstall[] {
  const declarations = (allChannels
    ? runtimePackageDeclarations(profile)
    : selectedRuntimePackageDeclarations(plan!, profile)
  ).filter((install) => install.manager === "node-package");
  const seen = new Set<string>();
  const installs: VerifiedNodePackageInstall[] = [];
  for (const declaration of declarations) {
    const spec = resolveRuntimePackageSpec(declaration.spec, profile, env);
    const npmPackage = requireExactNpmPackageSpec(spec, declaration.channelId);
    const integrity = declaration.integrity ?? declaration.integrityByVersion?.[npmPackage.version];
    const tarballUrl = declaration.tarballUrl ?? declaration.tarballUrlByVersion?.[npmPackage.version];
    if (declaration.pin !== true || !integrity || !tarballUrl) {
      throw new MessagingBuildApplierError(
        `Managed messaging package ${npmPackage.packageSpec} must have a committed integrity pin and tarball URL`,
      );
    }
    if (seen.has(npmPackage.packageSpec)) continue;
    seen.add(npmPackage.packageSpec);
    installs.push({
      spec,
      npmPackageSpec: npmPackage.packageSpec,
      integrity,
      tarballUrl,
      ...(declaration.runtimeLock ? { runtimeLock: declaration.runtimeLock } : {}),
      pin: true,
    });
  }
  return installs;
}

function collectRuntimePythonPackages(
  plan: MessagingBuildPlan | null,
  profile: MessagingRuntimeProfile,
  allChannels = false,
): PinnedPythonPackageInstall[] {
  const declarations = (allChannels
    ? runtimePackageDeclarations(profile)
    : selectedRuntimePackageDeclarations(plan!, profile)
  ).filter((install) => install.manager === "python-package");
  const specs = new Set<string>();
  for (const declaration of declarations) {
    if (!isPinnedPythonPackageSpec(declaration.spec)) {
      throw new MessagingBuildApplierError(
        `Messaging Python package must use a safe exact-pinned package spec: ${declaration.spec}`,
      );
    }
    specs.add(declaration.spec);
  }
  return [...specs].map((spec) => ({ spec }));
}

export function applyMessagingAgentRenderToObject(
  config: JsonObject,
  plan: MessagingBuildPlan | null,
  target: string,
): void {
  if (!plan) return;
  const rules = credentialPlaceholderRules(plan);
  const renderEntries = enabledAgentRender(plan).filter((render) => render.target === target);
  for (const render of renderEntries) {
    if (render.kind !== "json-fragment" || typeof render.path !== "string") {
      continue;
    }
    const value = preserveCredentialPlaceholders(
      requiredSerializableValue(render.value, "render value"),
      getJsonPath(config, render.path),
      rules,
    );
    setJsonPath(config, render.path, value);
  }
  applyDeclaredRenderFinalizers(config, renderEntries, plan);
}

export function applyMessagingAgentRenderToEnvLines(
  envLines: string[],
  plan: MessagingBuildPlan | null,
  target: string,
): void {
  if (!plan) return;
  for (const render of enabledAgentRender(plan)) {
    if (render.kind !== "env-lines" || render.target !== target) continue;
    if (!Array.isArray(render.lines)) {
      throw new MessagingBuildApplierError(
        `Messaging env render '${render.renderId ?? render.channelId}' is missing lines.`,
      );
    }
    mergeEnvLines(envLines, readEnvRenderLines(render));
  }
}

export function applyMessagingAgentRenderToLocalFiles(
  plan: MessagingBuildPlan | null,
  options: {
    readonly homeDir?: string;
  } = {},
): readonly string[] {
  if (!plan) return [];
  const appliedTargets: string[] = [];
  const grouped = new Map<string, MessagingRenderEntry[]>();
  for (const render of enabledAgentRender(plan)) {
    const entries = grouped.get(render.target) ?? [];
    entries.push(render);
    grouped.set(render.target, entries);
  }

  for (const target of migrationOnlyEnvTargets(plan, new Set(grouped.keys()))) {
    grouped.set(target, []);
  }

  for (const [target, renderEntries] of grouped) {
    const kinds = uniqueStrings(renderEntries.map((entry) => entry.kind));
    if (kinds.length > 1) {
      throw new MessagingBuildApplierError(
        `Cannot apply mixed messaging render kinds to ${target}.`,
      );
    }
    if (kinds[0] === "json-fragment") {
      appliedTargets.push(applyJsonRenderEntriesToLocalFile(plan, target, renderEntries, options));
    } else {
      appliedTargets.push(applyEnvRenderEntriesToLocalFile(plan, target, renderEntries, options));
    }
  }

  return uniqueStrings(appliedTargets);
}

export function activeChannels(plan: MessagingBuildPlan | null): string[] {
  if (!plan) return [];
  return selectActiveMessagingChannelIds(plan);
}

export function messagingRuntimePlanPath(env: Env = process.env): string {
  const configured = env.NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH?.trim();
  return configured || DEFAULT_MESSAGING_RUNTIME_PLAN_PATH;
}

export function buildMessagingRuntimePlanArtifact(
  plan: MessagingBuildPlan | null,
): JsonObject | null {
  if (!plan) return null;
  return {
    schemaVersion: 1,
    sandboxName: plan.sandboxName,
    agent: plan.agent,
    ...(typeof plan.workflow === "string" && plan.workflow ? { workflow: plan.workflow } : {}),
    channels: sanitizeRuntimeArtifactChannels(plan.channels),
    disabledChannels: sanitizeStringArray(plan.disabledChannels ?? []),
    credentialBindings: sanitizeRuntimeArtifactCredentialBindings(plan.credentialBindings),
    runtimeSetup: sanitizeRuntimeSetup(plan.runtimeSetup),
  };
}

export function writeMessagingRuntimePlanArtifact(
  plan: MessagingBuildPlan | null,
  targetPath: string,
): string | null {
  const artifact = buildMessagingRuntimePlanArtifact(plan);
  if (!artifact) return null;
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(artifact, null, 2)}\n`);
  chmodSync(targetPath, 0o644);
  return targetPath;
}

function sanitizeRuntimeArtifactChannels(
  channels: readonly MessagingPlanChannel[],
): readonly JsonObject[] {
  return channels.flatMap((channel): JsonObject[] => {
    const channelId = sanitizeOptionalString(channel.channelId);
    if (!channelId) return [];
    return [
      {
        channelId,
        active: channel.active === true,
        disabled: channel.disabled === true,
      },
    ];
  });
}

function sanitizeRuntimeArtifactCredentialBindings(
  bindings: readonly MessagingCredentialBinding[],
): readonly JsonObject[] {
  return bindings.flatMap((binding): JsonObject[] => {
    const channelId = sanitizeOptionalString(binding.channelId);
    const providerEnvKey = sanitizeOptionalString(binding.providerEnvKey);
    if (!channelId || !providerEnvKey) return [];
    return [{ channelId, providerEnvKey }];
  });
}

function sanitizeRuntimeSetup(
  setup: MessagingBuildPlan["runtimeSetup"] | undefined,
): Record<MessagingRuntimeSetupKey, readonly JsonObject[]> {
  return {
    nodePreloads: sanitizeRuntimeSetupEntries(setup?.nodePreloads, [
      "channelId",
      "source",
      "target",
      "injectInto",
      "optional",
      "installMessage",
      "installedMessage",
    ]),
    envAliases: sanitizeRuntimeSetupEntries(setup?.envAliases, [
      "channelId",
      "envKey",
      "targetEnvKey",
      "match",
      "value",
      "message",
    ]),
    secretScans: sanitizeRuntimeSetupEntries(setup?.secretScans, [
      "channelId",
      "path",
      "pattern",
      "message",
      "exitCode",
    ]),
  };
}

function sanitizeRuntimeSetupEntries(
  entries: readonly JsonObject[] | undefined,
  allowedKeys: readonly string[],
): readonly JsonObject[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    if (!isObject(entry)) {
      throw new MessagingBuildApplierError(
        `Messaging runtime setup entry ${index} must be an object`,
      );
    }
    const channelId = sanitizeOptionalString(entry.channelId);
    if (!channelId) {
      throw new MessagingBuildApplierError(
        `Messaging runtime setup entry ${index} must include channelId`,
      );
    }
    const sanitized: JsonObject = { channelId };
    for (const key of allowedKeys) {
      if (key === "channelId" || entry[key] === undefined) continue;
      sanitized[key] = cloneRuntimeArtifactValue(entry[key], `runtime setup entry ${index}.${key}`);
    }
    return sanitized;
  });
}

function cloneRuntimeArtifactValue(value: unknown, label: string): MessagingSerializableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      cloneRuntimeArtifactValue(entry, `${label}[${String(index)}]`),
    );
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        assertSafeObjectKey(key, label);
        return [key, cloneRuntimeArtifactValue(entry, `${label}.${key}`)];
      }),
    );
  }
  throw new MessagingBuildApplierError(`${label} must be JSON-serializable`);
}

function sanitizeStringArray(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = sanitizeOptionalString(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function sanitizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function collectOpenClawMessagingPluginInstallSpecs(
  plan: MessagingBuildPlan | null,
  env: Env,
): string[] {
  return collectOpenClawMessagingPluginInstalls(plan, env).map((install) => install.spec);
}

export function collectHermesMessagingUvPackages(plan: MessagingBuildPlan | null): string[] {
  return collectHermesMessagingUvPackageInstalls(plan).map((install) => install.spec);
}

/**
 * Return the complete reviewed OpenClaw package set baked into a managed image.
 *
 * This deliberately reads committed built-in manifests directly. A serialized
 * messaging plan is deployment input, not authority to choose packages that
 * execute during the trusted image build.
 */
export function collectManagedImageOpenClawPluginInstallSpecs(env: Env): string[] {
  return collectManagedImageOpenClawPluginInstalls(env).map((install) => install.spec);
}

/** Return every pinned Hermes package required by a supported managed-image channel. */
export function collectManagedImageHermesUvPackages(): string[] {
  return collectTrustedHermesUvPackageInstalls(LEGACY_CHANNEL_MANIFESTS).map(
    (install) => install.spec,
  );
}

function collectOpenClawMessagingPluginInstalls(
  plan: MessagingBuildPlan | null,
  env: Env,
): OpenClawPluginInstall[] {
  const installs: OpenClawPluginInstall[] = [];
  const seen = new Set<string>();
  const trustedManifests = trustedChannelManifestsForActivePlan(plan);
  let trustedSpecs: Set<string> | undefined;
  let reviewedIntegrity: Readonly<Record<string, string>> | undefined;
  let reviewedTarballUrls: Readonly<Record<string, string>> | undefined;
  let runtimeLocks:
    | Readonly<Record<string, ChannelAgentPackageRuntimeLockSpec>>
    | undefined;
  for (const step of enabledBuildStepsForPhase(plan, "agent-install")) {
    if (step.kind !== "package-install") continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    if (readMessagingPackageManager(step.value, step.outputId) !== "node-package") continue;
    assertPackageManagerDeclared(plan, "node-package");
    trustedSpecs ??= trustedOpenClawPluginSpecsForManifests(trustedManifests, env);
    reviewedIntegrity ??= reviewedOpenClawPluginIntegrityByPackageSpec(env, trustedManifests);
    reviewedTarballUrls ??= reviewedOpenClawPluginTarballUrlByPackageSpec(env, trustedManifests);
    runtimeLocks ??= reviewedOpenClawPluginRuntimeLocksByPackageSpec(env, trustedManifests);
    const install = readNodePackageInstall(step.value as JsonObject, step.outputId);
    const resolvedSpec = resolveOpenClawPackageSpec(install.spec, env);
    const npmPackage = parseNpmPackageSpec(resolvedSpec);
    if (npmPackage && !trustedSpecs.has(resolvedSpec)) {
      throw new MessagingBuildApplierError(
        `Messaging package-install output ${step.outputId} is not declared by a trusted built-in manifest for active OpenClaw channels: ${resolvedSpec}`,
      );
    }
    const integrity = npmPackage ? reviewedIntegrity[npmPackage.packageSpec] : undefined;
    const tarballUrl = npmPackage ? reviewedTarballUrls[npmPackage.packageSpec] : undefined;
    const resolvedInstall: OpenClawPluginInstall = {
      spec: resolvedSpec,
      ...(npmPackage ? { npmPackageSpec: npmPackage.packageSpec } : {}),
      ...(integrity ? { integrity } : {}),
      ...(tarballUrl ? { tarballUrl } : {}),
      ...(npmPackage && runtimeLocks[npmPackage.packageSpec]
        ? { runtimeLock: runtimeLocks[npmPackage.packageSpec] }
        : {}),
      pin: integrity !== undefined,
    };
    const key = JSON.stringify(resolvedInstall);
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push(resolvedInstall);
  }
  return installs;
}

function collectManagedImageOpenClawPluginInstalls(env: Env): OpenClawPluginInstall[] {
  const reviewedIntegrity = reviewedOpenClawPluginIntegrityByPackageSpec(
    env,
    LEGACY_CHANNEL_MANIFESTS,
  );
  const reviewedTarballUrls = reviewedOpenClawPluginTarballUrlByPackageSpec(
    env,
    LEGACY_CHANNEL_MANIFESTS,
  );
  const runtimeLocks = reviewedOpenClawPluginRuntimeLocksByPackageSpec(
    env,
    LEGACY_CHANNEL_MANIFESTS,
  );
  const installs: OpenClawPluginInstall[] = [];
  const seen = new Set<string>();

  for (const manifest of LEGACY_CHANNEL_MANIFESTS as readonly ChannelManifest[]) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const spec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(spec, manifest.id);
      const integrity = reviewedIntegrity[npmPackage.packageSpec];
      const tarballUrl = reviewedTarballUrls[npmPackage.packageSpec];
      if (packageSpec.pin !== true || !integrity || !tarballUrl) {
        throw new MessagingBuildApplierError(
          `Managed-image OpenClaw package ${npmPackage.packageSpec} must have a committed integrity pin and tarball URL`,
        );
      }
      if (seen.has(npmPackage.packageSpec)) continue;
      seen.add(npmPackage.packageSpec);
      installs.push({
        spec,
        npmPackageSpec: npmPackage.packageSpec,
        integrity,
        tarballUrl,
        ...(runtimeLocks[npmPackage.packageSpec]
          ? { runtimeLock: runtimeLocks[npmPackage.packageSpec] }
          : {}),
        pin: true,
      });
    }
  }
  return installs;
}

/**
 * Security boundary: NEMOCLAW_MESSAGING_PLAN_B64 is a derived build artifact,
 * not authority to choose root-time OpenClaw plugins. Invalid state: a serialized
 * OpenClaw plan names a reviewed npm plugin for a channel that is not active.
 * Source fix: update the selected channel's trusted manifest, not the serialized
 * plan/env. Remove this recheck only once package installs are no longer
 * serialized or plans are signed and attested at the Docker build boundary.
 */
function trustedChannelManifestsForActivePlan(plan: MessagingBuildPlan | null): ChannelManifest[] {
  const active = new Set(activeChannels(plan));
  return LEGACY_CHANNEL_MANIFESTS.filter((manifest) => active.has(manifest.id));
}

function trustedOpenClawPluginSpecsForManifests(
  manifests: readonly ChannelManifest[],
  env: Env,
): Set<string> {
  const specs = new Set<string>();
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      specs.add(resolvedSpec);
    }
  }
  return specs;
}

function collectHermesMessagingUvPackageInstalls(
  plan: MessagingBuildPlan | null,
): HermesUvPackageInstall[] {
  const installs: HermesUvPackageInstall[] = [];
  const seen = new Set<string>();
  const trustedSpecs = trustedHermesUvPackageSpecsForPlan(plan);
  for (const step of enabledBuildStepsForPhase(plan, "agent-install")) {
    if (step.kind !== "package-install") continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    if (readMessagingPackageManager(step.value, step.outputId) !== "python-package") continue;
    assertPackageManagerDeclared(plan, "python-package");
    const install = readPythonPackageInstall(step.value as JsonObject, step.outputId);
    if (!trustedSpecs.has(install.spec)) {
      throw new MessagingBuildApplierError(
        `Messaging package-install output ${step.outputId} is not declared by a trusted built-in manifest for active Hermes channels: ${install.spec}`,
      );
    }
    if (seen.has(install.spec)) continue;
    seen.add(install.spec);
    installs.push(install);
  }
  return installs;
}

/**
 * Security boundary: NEMOCLAW_MESSAGING_PLAN_B64 is a derived build artifact,
 * not authority to choose root-time Hermes packages. Invalid state: a serialized
 * plan contains a python-package spec absent from the trusted built-in
 * manifest for a selected active channel. Source fix: update the channel
 * manifest's agentPackages, not the serialized plan/env. Remove this recheck
 * only once package installs are no longer serialized or plans are signed and
 * attested at the Docker build boundary.
 */
function trustedHermesUvPackageSpecsForPlan(plan: MessagingBuildPlan | null): Set<string> {
  const active = new Set(activeChannels(plan));
  return new Set(
    collectTrustedHermesUvPackageInstalls(
      LEGACY_CHANNEL_MANIFESTS.filter((manifest) => active.has(manifest.id)),
    ).map((install) => install.spec),
  );
}

function collectTrustedHermesUvPackageInstalls(
  manifests: readonly ChannelManifest[],
): HermesUvPackageInstall[] {
  const specs = new Set<string>();
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "python-package") continue;
      if (!isPinnedHermesUvPackageSpec(packageSpec.spec)) {
        throw new MessagingBuildApplierError(
          `Trusted manifest ${manifest.id} declares an unsafe Hermes Python package spec: ${packageSpec.spec}`,
        );
      }
      specs.add(packageSpec.spec);
    }
  }
  return [...specs].map((spec) => ({ spec }));
}

export function messagingRepairEnvOverrides(
  plan: MessagingBuildPlan | null,
  env: Env = process.env,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (plan) {
    const active = new Set(activeChannels(plan));
    for (const binding of plan.credentialBindings) {
      if (!active.has(binding.channelId)) continue;
      if (typeof binding.providerEnvKey === "string" && typeof binding.placeholder === "string") {
        overrides[binding.providerEnvKey] = binding.placeholder;
      }
    }
  }
  if (isTruthyEnv(env.NEMOCLAW_WEB_SEARCH_ENABLED)) {
    const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "brave").trim();
    if (provider === "brave") {
      overrides.BRAVE_API_KEY = "openshell:resolve:env:BRAVE_API_KEY";
    } else if (provider === "tavily") {
      overrides.TAVILY_API_KEY = "openshell:resolve:env:TAVILY_API_KEY";
    } else {
      throw new MessagingBuildApplierError(
        `Unsupported NEMOCLAW_WEB_SEARCH_PROVIDER: ${provider || "<empty>"}`,
      );
    }
  }
  return overrides;
}

export function installOpenClawMessagingPlugins(plan: MessagingBuildPlan | null, env: Env): void {
  installOpenClawPluginPackages(
    collectOpenClawMessagingPluginInstalls(plan, env),
    env,
    plan ? effectiveBuildProfile(plan).nodeArchiveRemediation === "package-helper" : false,
  );
}

function installOpenClawPluginPackages(
  installs: readonly OpenClawPluginInstall[],
  env: Env,
  enableRemediation: boolean,
): void {
  for (const install of installs) {
    const installCache = install.runtimeLock
      ? requireWritableRuntimeInstallCache(install.runtimeLock, env)
      : undefined;
    const installEnv = {
      ...env,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
      ...(install.runtimeLock
        ? {
            NPM_CONFIG_CACHE: installCache,
            NPM_CONFIG_OFFLINE: String(install.runtimeLock.offline),
            NPM_CONFIG_LEGACY_PEER_DEPS: String(install.runtimeLock.legacyPeerDeps),
          }
        : {}),
    };
    // Resolve registry metadata and pack the reviewed archive through the same
    // disposable cache used by OpenClaw. Selecting it after packing can leave
    // fetched bytes in HOME/.npm in an earlier image layer.
    const packed = packVerifiedOpenClawPluginArchive(install, installEnv, enableRemediation);
    try {
      // Install through the `npm-pack:` spec so OpenClaw records npm
      // provenance (source, resolved name/version, integrity) for the
      // verified tarball. A bare archive path records archive provenance,
      // which fails the trusted-official-install check gating openKeyedStore
      // on OpenClaw >= 2026.6.10 and crash-loops channel plugins that use
      // keyed state (e.g. WhatsApp). npm-pack installs always record the
      // exact resolved version, so `--pin` is not needed.
      runCommand(["openclaw", "plugins", "install", `npm-pack:${packed.archivePath}`], installEnv);
      if (install.runtimeLock) {
        const openClawVersion = sanitizeOptionalString(env.OPENCLAW_VERSION);
        if (!openClawVersion) {
          throw new MessagingBuildApplierError(
            "OPENCLAW_VERSION is required to verify the WeChat plugin peer dependency",
          );
        }
        runCommand(
          [
            "node",
            "--experimental-strip-types",
            install.runtimeLock.verifierPath,
            install.runtimeLock.lockFile,
            install.runtimeLock.projectsRoot,
            openClawVersion,
          ],
          installEnv,
        );
      }
    } finally {
      rmSync(packed.rootDir, { recursive: true, force: true });
    }
  }
}

export function requireWritableRuntimeInstallCache(
  runtimeLock: ChannelAgentPackageRuntimeLockSpec,
  env: Env,
): string {
  const configured = sanitizeOptionalString(env[runtimeLock.installCacheEnvKey]);
  if (!configured) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must name the sandbox-writable temporary npm cache prepared from ${runtimeLock.cachePath}`,
    );
  }
  if (!isAbsolute(configured)) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must be an absolute path`,
    );
  }

  let installCache: string;
  try {
    if (lstatSync(configured).isSymbolicLink()) {
      throw new Error("symbolic links are not allowed");
    }
    installCache = realpathSync(configured);
    if (!statSync(installCache).isDirectory()) {
      throw new Error("path is not a directory");
    }
    accessSync(installCache, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must be a writable, searchable directory: ${formatError(error)}`,
    );
  }

  // Canonicalize an existing trusted root too: on macOS, for example, /var
  // resolves through /private/var and must still compare equal to installCache.
  const trustedCache = existsSync(runtimeLock.cachePath)
    ? realpathSync(runtimeLock.cachePath)
    : resolve(runtimeLock.cachePath);
  if (installCache === trustedCache || installCache.startsWith(`${trustedCache}${sep}`)) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must not make the trusted npm cache writable`,
    );
  }
  return installCache;
}

export function runMessagingPostRenderRepair(plan: MessagingBuildPlan | null, env: Env): void {
  if (!plan) return;
  const repair = effectiveBuildProfile(plan).postRenderRepair;
  if (!repair) return;
  runCommand(repair.command, {
    ...env,
    ...messagingRepairEnvOverrides(plan, env),
  });
}

export function applyPostAgentInstallBuildFilesToLocalFiles(
  plan: MessagingBuildPlan | null,
  options: {
    readonly homeDir?: string;
  } = {},
): readonly string[] {
  const appliedTargets: string[] = [];
  for (const step of enabledBuildStepsForPhase(plan, "post-agent-install")) {
    if (step.kind !== "build-file") continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging build-file output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    appliedTargets.push(
      applyBuildFileOutputToLocalAgentRoot(
        plan!,
        readBuildFileOutput(step.value),
        options,
      ),
    );
  }
  return uniqueStrings(appliedTargets);
}

function applyJsonRenderEntriesToLocalFile(
  plan: MessagingBuildPlan,
  target: string,
  renderEntries: readonly MessagingRenderEntry[],
  options: { readonly homeDir?: string },
): string {
  const targetPath = resolveAgentRenderTarget(plan, target, options);
  const config = targetPath.endsWith(".yaml")
    ? parseGeneratedYamlObject(readTextIfExists(targetPath), targetPath)
    : parseJsonObject(readTextIfExists(targetPath), targetPath);
  applyMessagingRenderEntriesToObject(config, renderEntries, target, plan);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    targetPath.endsWith(".yaml")
      ? serializeGeneratedYamlObject(config)
      : `${JSON.stringify(config, null, 2)}\n`,
  );
  chmodSync(targetPath, 0o600);
  return targetPath;
}

function applyEnvRenderEntriesToLocalFile(
  plan: MessagingBuildPlan,
  target: string,
  renderEntries: readonly MessagingRenderEntry[],
  options: { readonly homeDir?: string },
): string {
  const targetPath = resolveAgentRenderTarget(plan, target, options);
  const envLines =
    readTextIfExists(targetPath)
      ?.split(/\r?\n/)
      .filter((line) => line.length > 0) ?? [];
  const rendered = new Set<string>();
  for (const render of renderEntries) {
    if (!Array.isArray(render.lines)) {
      throw new MessagingBuildApplierError(
        `Messaging env render '${render.renderId ?? render.channelId}' is missing lines.`,
      );
    }
    const lines = readEnvRenderLines(render);
    for (const line of lines) {
      const key = readEnvLineKey(line);
      if (key) rendered.add(key);
    }
    mergeEnvLines(envLines, lines);
  }
  // Hermes loads this file with override=True, so a credential line the plan
  // owns but no longer renders would shadow the injected value.
  const stale = staleCredentialEnvKeys(plan, rendered);
  const keptLines = envLines.filter((line) => {
    const key = readEnvLineKey(line);
    return key === null || !stale.has(key);
  });
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "");
  chmodSync(targetPath, 0o600);
  return targetPath;
}

function applyMessagingRenderEntriesToObject(
  config: JsonObject,
  renderEntries: readonly MessagingRenderEntry[],
  target: string,
  plan: MessagingBuildPlan,
): void {
  const rules = credentialPlaceholderRules(plan);
  for (const render of renderEntries) {
    if (render.kind !== "json-fragment" || typeof render.path !== "string") {
      throw new MessagingBuildApplierError(
        `Messaging render for ${target} must be a JSON fragment with a path.`,
      );
    }
    const value = preserveCredentialPlaceholders(
      requiredSerializableValue(render.value, "render value"),
      getJsonPath(config, render.path),
      rules,
    );
    setJsonPath(config, render.path, value);
  }
  applyDeclaredRenderFinalizers(config, renderEntries, plan);
}

function applyDeclaredRenderFinalizers(
  config: JsonObject,
  renderEntries: readonly MessagingRenderEntry[],
  plan: MessagingBuildPlan,
): void {
  const finalizers = effectiveBuildProfile(plan).renderFinalizers ?? [];
  if (finalizers.includes("allow-rendered-plugins")) {
    allowRenderedPlugins(config, renderEntries);
  }
  if (finalizers.includes("inherit-api-server-toolsets")) {
    inheritApiServerToolsets(config);
  }
}

function readEnvRenderLines(render: MessagingRenderEntry): readonly string[] {
  if (!Array.isArray(render.lines)) {
    throw new MessagingBuildApplierError(
      "Messaging env render '" + (render.renderId ?? render.channelId) + "' is missing lines.",
    );
  }
  for (const line of render.lines) {
    if (/[\r\n]/.test(line)) {
      throw new MessagingBuildApplierError(
        "Messaging env render '" +
          (render.renderId ?? render.channelId) +
          "' must not contain line breaks.",
      );
    }
  }
  return render.lines;
}

function inheritApiServerToolsets(config: JsonObject): void {
  const platforms = config.platforms;
  const platformToolsets = config.platform_toolsets;
  if (!isObject(platforms) || !isObject(platformToolsets)) return;
  const apiServerToolsets = platformToolsets.api_server;
  if (!Array.isArray(apiServerToolsets)) return;
  for (const [platform, platformConfig] of Object.entries(platforms)) {
    if (platform === "api_server" || !isObject(platformConfig) || platformConfig.enabled !== true) {
      continue;
    }
    if (!Array.isArray(platformToolsets[platform])) {
      platformToolsets[platform] = [...apiServerToolsets];
    }
  }
}

function resolveAgentRenderTarget(
  plan: MessagingBuildPlan,
  target: string,
  options: { readonly homeDir?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const configRoot = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home);
  const normalizedRoot = resolve(configRoot);
  if (target.startsWith("~/")) {
    const resolvedTarget = resolve(home, target.slice(2));
    if (
      resolvedTarget === normalizedRoot ||
      !resolvedTarget.startsWith(`${normalizedRoot}${sep}`)
    ) {
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
      );
    }
    return resolvedTarget;
  }
  const relativeTarget = normalizeBuildFilePath(target);
  const resolvedTarget = resolve(configRoot, relativeTarget);
  if (!resolvedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new MessagingBuildApplierError(
      `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
    );
  }
  return resolvedTarget;
}

function effectiveBuildProfile(plan: MessagingBuildPlan): HarnessMessagingBuildProfile {
  if (plan.packageBuild) return validateBuildProfile(plan.packageBuild);
  if (globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD === true) {
    throw new MessagingBuildApplierError(
      "Receipt-backed messaging plan is missing its package build profile",
    );
  }
  return legacyBuildProfile!(plan);
}

/** Decode only pre-contract serialized plans. Receipt-backed plans always carry packageBuild. */
const legacyBuildProfile =
  globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD === true
    ? undefined
    : function legacyBuildProfile(plan: MessagingBuildPlan): HarnessMessagingBuildProfile {
  const targets = plan.agentRender.map((entry) => entry.target);
  const homeTarget = targets.find((target) => target.startsWith("~/"));
  const packageManagers = uniqueStrings(
    plan.buildSteps.flatMap((step) => {
      if (
        step.kind !== "package-install" ||
        !isObject(step.value) ||
        Array.isArray(step.value)
      ) {
        return [];
      }
      const manager = (step.value as JsonObject).manager;
      return manager === "node-package" || manager === "python-package" ? [manager] : [];
    }),
  ) as ChannelAgentPackageManager[];
  const configRoot = homeTarget
    ? `~/${homeTarget.slice(2).split("/")[0]}`
    : targets.includes("openclaw.json")
      ? "~/.openclaw"
      : packageManagers.includes("node-package")
        ? "~/.openclaw"
        : packageManagers.includes("python-package")
          ? "~/.hermes"
      : null;
  if (!configRoot) {
    throw new MessagingBuildApplierError(
      `Messaging plan for ${plan.agent} is missing its build profile and has no legacy config root`,
    );
  }
  const openClawLegacy = targets.includes("openclaw.json");
  const hermesLegacy = configRoot === "~/.hermes";
        return validateBuildProfile({
    configRoot,
    packageManagers,
    ...(openClawLegacy
      ? {
          renderFinalizers: ["allow-rendered-plugins"] as const,
          postRenderRepair: {
            command: ["openclaw", "doctor", "--fix", "--non-interactive"],
          },
          nodeArchiveRemediation: "package-helper" as const,
        }
      : {}),
    ...(hermesLegacy ? { renderFinalizers: ["inherit-api-server-toolsets"] as const } : {}),
        });
      };

function validateBuildProfile(
  profile: HarnessMessagingBuildProfile,
  requireInstallers = false,
): HarnessMessagingBuildProfile {
  if (!/^~\/[A-Za-z0-9._-]+$/u.test(profile.configRoot)) {
    throw new MessagingBuildApplierError("Messaging build profile has an unsafe config root");
  }
  if (
    profile.packageManagers.some(
      (manager) => manager !== "node-package" && manager !== "python-package",
    )
  ) {
    throw new MessagingBuildApplierError("Messaging build profile has an unsupported package manager");
  }
  for (const manager of requireInstallers ? profile.packageManagers : []) {
    const installer = profile.packageInstallers?.[manager];
    if (!installer) {
      throw new MessagingBuildApplierError(
        `Messaging build profile is missing its ${manager} installer`,
      );
    }
    const placeholder =
      manager === "node-package" ? "{{archive}}" : "{{packages}}";
    if (
      !Array.isArray(installer.command) ||
      installer.command.length < 2 ||
      installer.command.length > 16 ||
      installer.command.filter((argument) => argument === placeholder).length !== 1 ||
      installer.command.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.length > 8192 ||
          (/\{\{/u.test(argument) && argument !== placeholder),
      )
    ) {
      throw new MessagingBuildApplierError(
        `Messaging ${manager} installer has an invalid command`,
      );
    }
  }
  for (const manager of ["node-package", "python-package"] as const) {
    if (profile.packageInstallers?.[manager] && !profile.packageManagers.includes(manager)) {
      throw new MessagingBuildApplierError(
        `Messaging build profile has an undeclared ${manager} installer`,
      );
    }
  }
  const nodeVersionEnvironment =
    profile.packageInstallers?.["node-package"]?.packageVersionEnvironment;
  if (
    nodeVersionEnvironment !== undefined &&
    !/^[A-Z_][A-Z0-9_]*$/u.test(nodeVersionEnvironment)
  ) {
    throw new MessagingBuildApplierError(
      "Messaging node package installer has an invalid version environment key",
    );
  }
  const pythonEnvironment = profile.packageInstallers?.["python-package"]?.environment ?? {};
  for (const [key, value] of Object.entries(pythonEnvironment)) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\r\n\0]/u.test(value) ||
      /(?:openshell:resolve|\{\{|\}\}|token|secret|password|api[_-]?key)/iu.test(value)
    ) {
      throw new MessagingBuildApplierError(
        "Messaging Python package installer has an invalid fixed environment",
      );
    }
  }
  const repair = profile.postRenderRepair;
  if (
    repair !== undefined &&
    (!isObject(repair) ||
      Object.keys(repair).some((key) => key !== "command") ||
      !Array.isArray(repair.command) ||
      repair.command.length === 0 ||
      repair.command.length > 16 ||
      repair.command.some(
        (argument) =>
          typeof argument !== "string" || argument.length === 0 || argument.length > 8192,
      ))
  ) {
    throw new MessagingBuildApplierError(
      "Messaging build profile has an invalid post-render repair command",
    );
  }
  return profile;
}

function assertPackageManagerDeclared(
  plan: MessagingBuildPlan | null,
  manager: ChannelAgentPackageManager,
): void {
  if (!plan || !effectiveBuildProfile(plan).packageManagers.includes(manager)) {
    throw new MessagingBuildApplierError(
      `Messaging build profile does not declare package manager '${manager}'`,
    );
  }
}

function resolveHomeTarget(target: string, home: string): string {
  if (!target.startsWith("~/")) {
    throw new MessagingBuildApplierError(`Messaging config root ${target} must be home-relative`);
  }
  const normalizedHome = resolve(home);
  const resolvedTarget = resolve(home, target.slice(2));
  if (resolvedTarget === normalizedHome || !resolvedTarget.startsWith(`${normalizedHome}${sep}`)) {
    throw new MessagingBuildApplierError(`Messaging config root ${target} must stay inside ${home}`);
  }
  return resolvedTarget;
}

function enabledAgentRender(plan: MessagingBuildPlan): MessagingRenderEntry[] {
  return selectEnabledMessagingAgentRender(plan);
}

function enabledBuildStepsForPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingHookPhase,
): MessagingBuildStep[] {
  if (!plan) return [];
  if (phase === "post-agent-install") {
    return selectEnabledPostAgentInstallBuildFiles(plan);
  }
  return enabledBuildSteps(plan).filter((step) => buildStepMatchesPhase(plan, step, phase));
}

function enabledBuildSteps(plan: MessagingBuildPlan): MessagingBuildStep[] {
  const active = new Set(activeChannels(plan));
  return plan.buildSteps.filter((step) => active.has(step.channelId));
}

function buildStepMatchesPhase(
  plan: MessagingBuildPlan,
  step: MessagingBuildStep,
  phase: MessagingHookPhase,
): boolean {
  const hookPhase = step.hookId ? findHookPhase(plan, step.channelId, step.hookId) : undefined;
  if (hookPhase) return hookPhase === phase;

  // Older compiled plans did not carry hook phase on build steps. Fall back by
  // output kind so package installs remain agent-install and files remain
  // post-agent-install without re-running channel-specific handlers.
  if (phase === "agent-install") return step.kind === "package-install";
  if (phase === "post-agent-install") return step.kind === "build-file";
  return false;
}

function findHookPhase(
  plan: MessagingBuildPlan,
  channelId: string,
  hookId: string,
): string | undefined {
  const channel = plan.channels.find((candidate) => candidate.channelId === channelId);
  return channel?.hooks?.find((hook) => hook.id === hookId)?.phase;
}

function applyBuildFileOutputToLocalAgentRoot(
  plan: MessagingBuildPlan,
  file: BuildFileOutput,
  options: { readonly homeDir?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const root = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home);
  const relativePath = normalizeBuildFilePath(file.path);
  const target = resolve(root, relativePath);
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${file.path} must stay inside ${root}`,
    );
  }

  const contents =
    file.merge !== undefined
      ? mergeBuildFileContent(readTextIfExists(target), file.merge, target)
      : serializeBuildFileContent(file.content);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  if (file.mode) chmodSync(target, parseBuildFileMode(file.path, file.mode));
  return target;
}

function mergeBuildFileContent(
  existing: string | undefined,
  patch: MessagingSerializableValue,
  target: string,
): string {
  if (!isObject(patch)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file merge for ${target} must be an object.`,
    );
  }
  const root = parseJsonObject(existing, target);
  mergeJsonObjects(root, patch as JsonObject);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function parseJsonObject(existing: string | undefined, target: string): JsonObject {
  if (!existing || existing.trim().length === 0) return {};
  const parsed = JSON.parse(existing) as unknown;
  if (!isObject(parsed)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file target ${target} must contain an object.`,
    );
  }
  return parsed as JsonObject;
}

function readTextIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function readBuildFileOutput(value: MessagingSerializableValue): BuildFileOutput {
  if (!isObject(value)) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  const file = value as JsonObject;
  if (typeof file.path !== "string" || file.path.trim().length === 0) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  if (file.content === undefined && file.merge === undefined) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${file.path} must include content or merge`,
    );
  }
  if (file.mode !== undefined && typeof file.mode !== "string") {
    throw new MessagingBuildApplierError(`Messaging build-file ${file.path} mode must be a string`);
  }
  return file as BuildFileOutput;
}

function normalizeBuildFilePath(pathValue: string): string {
  if (pathValue.startsWith("/") || pathValue.includes("\\") || /[\0-\x1F\x7F]/.test(pathValue)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must be a safe relative path`,
    );
  }
  const segments = pathValue.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must not traverse directories`,
    );
  }
  return pathValue;
}

function serializeBuildFileContent(value: MessagingSerializableValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseBuildFileMode(pathValue: string, mode: string): number {
  if (!/^[0-7]{3,4}$/.test(mode) || (mode.length === 4 && mode[0] !== "0")) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must be an octal file mode`,
    );
  }
  const parsed = Number.parseInt(mode, 8);
  if ((parsed & 0o022) !== 0) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must not be group/world writable`,
    );
  }
  return parsed;
}

function readMessagingPackageManager(
  value: MessagingSerializableValue,
  outputId: string,
): ChannelAgentPackageManager {
  if (!isObject(value)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  }
  const install = value as JsonObject;
  if (install.manager === "node-package" || install.manager === "python-package") {
    return install.manager;
  }
  throw new MessagingBuildApplierError(
    `Messaging package-install output ${outputId} has an unsupported package manager`,
  );
}

function readNodePackageInstall(
  install: JsonObject,
  outputId: string,
): {
  readonly manager: "node-package";
  readonly spec: string;
  readonly integrity?: string;
  readonly integrityByVersion?: Readonly<Record<string, string>>;
  readonly pin?: boolean;
} {
  if (typeof install.spec !== "string" || install.spec.trim().length === 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must include a package spec`,
    );
  }
  if (install.pin !== undefined && typeof install.pin !== "boolean") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} pin must be boolean`,
    );
  }
  if (install.integrity !== undefined && typeof install.integrity !== "string") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrity must be a string`,
    );
  }
  if (install.integrityByVersion !== undefined && !isStringRecord(install.integrityByVersion)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrityByVersion must map versions to strings`,
    );
  }
  return install as {
    readonly manager: "node-package";
    readonly spec: string;
    readonly integrity?: string;
    readonly integrityByVersion?: Readonly<Record<string, string>>;
    readonly pin?: boolean;
  };
}

function readPythonPackageInstall(
  install: JsonObject,
  outputId: string,
): HermesUvPackageInstall {
  if (typeof install.spec !== "string" || install.spec.trim().length === 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must include a Hermes Python package spec`,
    );
  }
  const spec = install.spec.trim();
  if (!isPinnedHermesUvPackageSpec(spec)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must use a safe exact-pinned Hermes Python package spec`,
    );
  }
  return { spec };
}

function resolveOpenClawPackageSpec(spec: string, env: Env): string {
  const version = (env.OPENCLAW_VERSION || "").trim();
  const resolved = spec.replaceAll("{{openclaw.version}}", () => {
    if (!version) {
      throw new MessagingBuildApplierError(
        "OPENCLAW_VERSION is required when OpenClaw package install hooks are active",
      );
    }
    return version;
  });
  if (/\{\{\s*[^}]+\s*\}\}/.test(resolved)) {
    throw new MessagingBuildApplierError(`Unresolved package-install template in ${spec}`);
  }
  return resolved;
}

function parseNpmPackageSpec(
  spec: string,
): { readonly packageSpec: string; readonly version?: string } | null {
  if (!spec.startsWith("npm:")) return null;
  const packageSpec = spec.slice("npm:".length);
  const versionAt = packageSpec.startsWith("@")
    ? packageSpec.indexOf("@", 1)
    : packageSpec.lastIndexOf("@");
  if (versionAt <= 0 || versionAt === packageSpec.length - 1) return { packageSpec };
  return { packageSpec, version: packageSpec.slice(versionAt + 1) };
}

const EXACT_NPM_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function requireExactNpmPackageSpec(
  spec: string,
  manifestId: string,
): { readonly packageSpec: string; readonly version: string } {
  const parsed = parseNpmPackageSpec(spec);
  if (!parsed) {
    throw new MessagingBuildApplierError(
      `Trusted profile entry ${manifestId} declares a non-npm node package: ${spec}`,
    );
  }
  if (!parsed.version || !EXACT_NPM_VERSION_PATTERN.test(parsed.version)) {
    throw new MessagingBuildApplierError(
      `Trusted profile entry ${manifestId} must use an exact-version node package: ${spec}`,
    );
  }
  return { packageSpec: parsed.packageSpec, version: parsed.version };
}

function runCommand(args: readonly string[], env: Env): void {
  console.log(`+ ${args.join(" ")}`);
  const result = spawnSync(args[0] as string, args.slice(1), {
    env: env as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new MessagingBuildApplierError(
      `${args[0]} exited with status ${String(result.status ?? "unknown")}`,
    );
  }
}

function packVerifiedNodePackageArchive(
  install: OpenClawPluginInstall,
  env: Env,
  enableRemediation: boolean,
  label = "Node package",
): { readonly archivePath: string; readonly rootDir: string } {
  if (!install.npmPackageSpec) {
    throw new MessagingBuildApplierError(
      `${label} spec ${install.spec} must use an npm: package with committed integrity pin`,
    );
  }
  if (!install.integrity) {
    throw new MessagingBuildApplierError(
      `${label} ${install.npmPackageSpec} has no committed npm integrity pin`,
    );
  }
  if (!install.tarballUrl) {
    throw new MessagingBuildApplierError(
      `${label} ${install.npmPackageSpec} has no committed npm tarball URL`,
    );
  }
  const archive = packReviewedNpmArchive({
    env: env as NodeJS.ProcessEnv,
    expectedIntegrity: install.integrity,
    label: `${label} ${install.npmPackageSpec}`,
    packageSpec: install.npmPackageSpec,
    tarballUrl: install.tarballUrl,
  });
  const exactPackage = requireExactNpmPackageSpec(install.spec, install.npmPackageSpec);
  const remediated = enableRemediation
    ? runPackageOwnedNodeArchiveRemediation({
        archivePath: archive.archivePath,
        env: env as NodeJS.ProcessEnv,
        packageSpec: exactPackage.packageSpec,
        workingDirectory: archive.rootDirectory,
      })
    : { archivePath: archive.archivePath };
  return { archivePath: remediated.archivePath, rootDir: archive.rootDirectory };
}

function packVerifiedOpenClawPluginArchive(
  install: OpenClawPluginInstall,
  env: Env,
  enableRemediation: boolean,
) {
  return packVerifiedNodePackageArchive(install, env, enableRemediation, "OpenClaw plugin");
}

type PackageArchiveRemediationRequest = Readonly<{
  archivePath: string;
  env: NodeJS.ProcessEnv;
  packageSpec: string;
  workingDirectory: string;
}>;

/**
 * Run an optional package-owned archive transformer without importing harness code.
 * The package image fixes this path; serialized messaging plans cannot select it.
 */
function runPackageOwnedNodeArchiveRemediation(
  request: PackageArchiveRemediationRequest,
): { readonly archivePath: string } {
  const helper = sanitizeOptionalString(request.env.NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER);
  if (!helper) return { archivePath: request.archivePath };
  if (!isAbsolute(helper)) {
    throw new MessagingBuildApplierError(
      "NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER must be an absolute path",
    );
  }
  const result = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      helper,
      "--archive",
      request.archivePath,
      "--package-spec",
      request.packageSpec,
      "--working-directory",
      request.workingDirectory,
    ],
    {
      encoding: "utf-8",
      env: request.env,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper exited with status ${String(result.status ?? "unknown")}: ${String(result.stderr ?? "").trim()}`,
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned invalid JSON: ${formatError(error)}`,
    );
  }
  if (!isObject(output) || typeof output.archivePath !== "string") {
    throw new MessagingBuildApplierError(
      "Node package remediation helper did not return an archivePath",
    );
  }
  const archivePath = resolve(output.archivePath);
  const workingDirectory = realpathSync(request.workingDirectory);
  if (archivePath !== workingDirectory && !archivePath.startsWith(`${workingDirectory}${sep}`)) {
    throw new MessagingBuildApplierError(
      "Node package remediation helper returned an archive outside its working directory",
    );
  }
  try {
    if (lstatSync(archivePath).isSymbolicLink() || !statSync(archivePath).isFile()) {
      throw new Error("archive is not a regular file");
    }
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned an unreadable archive: ${formatError(error)}`,
    );
  }
  return { archivePath };
}

type CredentialPlaceholderRule = {
  readonly envKey: string;
  readonly placeholder: string;
};

function credentialPlaceholderRules(
  plan: MessagingBuildPlan | null | undefined,
): CredentialPlaceholderRule[] {
  if (!plan) return [];
  const active = new Set(activeChannels(plan));
  return plan.credentialBindings.flatMap((binding) => {
    if (!active.has(binding.channelId)) return [];
    if (typeof binding.providerEnvKey !== "string" || typeof binding.placeholder !== "string") {
      return [];
    }
    return [{ envKey: binding.providerEnvKey, placeholder: binding.placeholder }];
  });
}

function preserveCredentialPlaceholders(
  desired: MessagingSerializableValue,
  existing: unknown,
  rules: readonly CredentialPlaceholderRule[],
): MessagingSerializableValue {
  if (typeof desired === "string") {
    const rule = rules.find((candidate) => candidate.placeholder === desired);
    if (
      rule &&
      typeof existing === "string" &&
      isProviderPlaceholderForEnvKey(existing, rule.envKey)
    ) {
      return existing;
    }
    return desired;
  }
  if (Array.isArray(desired)) {
    return desired.map((entry, index) =>
      preserveCredentialPlaceholders(
        entry,
        Array.isArray(existing) ? existing[index] : undefined,
        rules,
      ),
    );
  }
  if (isObject(desired)) {
    const existingObject = isObject(existing) ? existing : {};
    return Object.fromEntries(
      Object.entries(desired).map(([key, value]) => [
        key,
        preserveCredentialPlaceholders(value, existingObject[key], rules),
      ]),
    );
  }
  return desired;
}

function getJsonPath(root: JsonObject, pathValue: string): unknown {
  let cursor: unknown = root;
  for (const segment of pathValue.split(".").filter(Boolean)) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isProviderPlaceholderForEnvKey(value: string, envKey: string): boolean {
  const openShellPrefix = "openshell:resolve:env:";
  if (value.startsWith(openShellPrefix)) {
    return placeholderSuffixMatchesEnvKey(value.slice(openShellPrefix.length), envKey);
  }
  const aliasMatch = value.match(/^[A-Za-z0-9]+-OPENSHELL-RESOLVE-ENV-(.+)$/);
  return aliasMatch ? placeholderSuffixMatchesEnvKey(aliasMatch[1] as string, envKey) : false;
}

function placeholderSuffixMatchesEnvKey(suffix: string, envKey: string): boolean {
  if (suffix === envKey) return true;
  const revisionMatch = suffix.match(/^v[0-9]+_(.+)$/);
  return revisionMatch?.[1] === envKey;
}

function setJsonPath(root: JsonObject, pathValue: string, value: MessagingSerializableValue): void {
  const segments = pathValue.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new MessagingBuildApplierError("Messaging render path must not be empty");
  }
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeObjectKey(segment, "Messaging render path");
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment] as JsonObject;
  }
  const finalSegment = segments[segments.length - 1] as string;
  assertSafeObjectKey(finalSegment, "Messaging render path");
  if (isObject(cursor[finalSegment]) && isObject(value)) {
    mergeJsonObjects(cursor[finalSegment] as JsonObject, value as JsonObject);
    return;
  }
  cursor[finalSegment] = value;
}

function mergeJsonObjects(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new MessagingBuildApplierError(
        "Messaging object merge rejected unsafe object key " + key,
      );
    }
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeJsonObjects(existing as JsonObject, value as JsonObject);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      setMergedObjectValue(target, key, [...new Set([...existing, ...value])]);
    } else {
      setMergedObjectValue(target, key, value);
    }
  }
}

function setMergedObjectValue(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mergeEnvLines(existingLines: string[], desiredLines: readonly string[]): void {
  const desired = new Map<string, string>();
  const rawDesiredLines: string[] = [];
  for (const line of desiredLines) {
    const key = readEnvLineKey(line);
    if (key) {
      desired.set(key, line);
    } else {
      rawDesiredLines.push(line);
    }
  }

  const written = new Set<string>();
  for (const [index, line] of existingLines.entries()) {
    const key = readEnvLineKey(line);
    if (!key || !desired.has(key)) continue;
    existingLines[index] = desired.get(key) as string;
    written.add(key);
  }

  for (const [key, line] of desired) {
    if (!written.has(key)) existingLines.push(line);
  }
  existingLines.push(...rawDesiredLines);
}

type GeneratedYamlLine = {
  readonly indent: number;
  readonly text: string;
  readonly lineNumber: number;
};

function parseGeneratedYamlObject(existing: string | undefined, target: string): JsonObject {
  if (!existing || existing.trim().length === 0) return {};
  const lines = existing
    .split(/\r?\n/)
    .map((line, index): GeneratedYamlLine | null => {
      if (isIgnorableGeneratedYamlLine(line)) return null;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      return { indent, text: line.slice(indent), lineNumber: index + 1 };
    })
    .filter((line): line is GeneratedYamlLine => line !== null);
  if (lines.length === 0) return {};
  const [parsed, nextIndex] = parseGeneratedYamlBlock(lines, 0, lines[0]?.indent ?? 0, target);
  if (nextIndex !== lines.length || !isObject(parsed)) {
    throw new MessagingBuildApplierError(`Messaging YAML target ${target} must contain an object.`);
  }
  return parsed as JsonObject;
}

function isIgnorableGeneratedYamlLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...";
}

function parseGeneratedYamlBlock(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [MessagingSerializableValue, number] {
  const first = lines[startIndex];
  if (!first || first.indent < indent) return [{}, startIndex];
  if (first.indent !== indent) {
    throw new MessagingBuildApplierError(
      `Messaging YAML target ${target} has unsupported indentation at line ${first.lineNumber}.`,
    );
  }
  if (first.text.startsWith("-")) {
    return parseGeneratedYamlArray(lines, startIndex, indent, target);
  }
  return parseGeneratedYamlMap(lines, startIndex, indent, target);
}

function parseGeneratedYamlMap(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [JsonObject, number] {
  const parsed: JsonObject = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] as GeneratedYamlLine;
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported indentation at line ${line.lineNumber}.`,
      );
    }
    if (line.text.startsWith("-")) break;
    const colonIndex = line.text.indexOf(":");
    if (colonIndex <= 0) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported mapping syntax at line ${line.lineNumber}.`,
      );
    }
    const key = line.text.slice(0, colonIndex).trim();
    assertSafeObjectKey(key, "Messaging YAML render path");
    const rest = line.text.slice(colonIndex + 1).trim();
    if (rest.length > 0) {
      parsed[key] = parseGeneratedYamlScalar(rest, target, line.lineNumber);
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith("-"))) {
      parsed[key] = {};
      index += 1;
      continue;
    }
    const childIndent = next.text.startsWith("-") && next.indent === indent ? indent : indent + 2;
    const [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, childIndent, target);
    parsed[key] = value;
    index = nextIndex;
  }
  return [parsed, index];
}

function parseGeneratedYamlArray(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [MessagingSerializableValue[], number] {
  const parsed: MessagingSerializableValue[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] as GeneratedYamlLine;
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith("-")) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported array syntax at line ${line.lineNumber}.`,
      );
    }
    const rest = line.text.slice(1).trim();
    if (rest.length > 0) {
      parsed.push(parseGeneratedYamlScalar(rest, target, line.lineNumber));
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      parsed.push({});
      index += 1;
      continue;
    }
    const [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, indent + 2, target);
    parsed.push(value);
    index = nextIndex;
  }
  return [parsed, index];
}

function parseGeneratedYamlScalar(
  value: string,
  target: string,
  lineNumber: number,
): MessagingSerializableValue {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as MessagingSerializableValue;
    } catch (error) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has invalid quoted scalar at line ${lineNumber}: ${formatError(error)}`,
      );
    }
  }
  return value;
}

function serializeGeneratedYamlObject(value: JsonObject): string {
  return serializeGeneratedYamlValue(value);
}

function serializeGeneratedYamlValue(
  value: MessagingSerializableValue,
  indent: number = 0,
): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = "";
    for (const item of value) {
      if (isObject(item)) {
        out += `${pad}-\n`;
        out += serializeGeneratedYamlValue(item as MessagingSerializableValue, indent + 1);
      } else if (Array.isArray(item)) {
        out += `${pad}-\n`;
        out += serializeGeneratedYamlValue(item, indent + 1);
      } else {
        out += `${pad}- ${formatGeneratedYamlScalar(item)}\n`;
      }
    }
    return out;
  }
  if (isObject(value)) {
    let out = "";
    for (const [key, item] of Object.entries(value)) {
      assertSafeObjectKey(key, "Messaging YAML object");
      if (Array.isArray(item)) {
        out +=
          item.length === 0
            ? `${pad}${key}: []\n`
            : `${pad}${key}:\n${serializeGeneratedYamlValue(item, indent + 1)}`;
      } else if (isObject(item)) {
        const entries = Object.entries(item);
        out +=
          entries.length === 0
            ? `${pad}${key}: {}\n`
            : `${pad}${key}:\n${serializeGeneratedYamlValue(item as MessagingSerializableValue, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${formatGeneratedYamlScalar(item as MessagingSerializableValue)}\n`;
      }
    }
    return out;
  }
  return `${pad}${formatGeneratedYamlScalar(value)}\n`;
}

function formatGeneratedYamlScalar(value: MessagingSerializableValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return JSON.stringify(value);
  if (value === "") return JSON.stringify(value);
  if (/[:{}\[\],&*?|>!%@`#'\"]/.test(value) || value.includes("\n") || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value || value.trim() === "") return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function requiredSerializableValue(value: unknown, label: string): MessagingSerializableValue {
  if (value === undefined) {
    throw new MessagingBuildApplierError(`Messaging ${label} is missing`);
  }
  return value as MessagingSerializableValue;
}

function assertSafeObjectKey(key: string, context: string): void {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new MessagingBuildApplierError(`${context} rejected unsafe object key ${key}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function uniqueStrings<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MessagingBuildPhase = "runtime-setup" | "agent-install" | "post-agent-install";
export type MessagingBuildApplyMode = "apply" | "clear";

export interface MessagingBuildPhaseOptions {
  /**
   * A managed image already contains the reviewed capability union. Apply only
   * the explicit render and build-file plan to its durable home directory.
   */
  readonly managedStartupRuntime?: boolean;
  /** Explicit provider-owned intent for managed startup profile application. */
  readonly mode?: MessagingBuildApplyMode;
  /** Integrity-bound package data authorizing package-manager execution. */
  readonly runtimeProfile?: MessagingRuntimeProfile;
}

export function applyMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env = process.env,
  options: MessagingBuildPhaseOptions = {},
): readonly string[] {
  const mode = options.mode ?? "apply";
  if (mode !== "apply" && mode !== "clear") {
    throw new MessagingBuildApplierError("Messaging apply mode must be 'apply' or 'clear'");
  }
  if (options.managedStartupRuntime && phase !== "post-agent-install") {
    throw new MessagingBuildApplierError(
      "Managed startup runtime mode is only valid for post-agent-install",
    );
  }
  if (mode === "clear") {
    if (plan !== null) {
      throw new MessagingBuildApplierError("Messaging clear mode requires an absent plan");
    }
    return [];
  }
  if (options.managedStartupRuntime && plan === null) {
    throw new MessagingBuildApplierError("Managed startup apply mode requires a messaging plan");
  }
  if (phase === "runtime-setup") {
    const target = writeMessagingRuntimePlanArtifact(plan, messagingRuntimePlanPath(env));
    return target ? [target] : [];
  }
  if (phase === "agent-install") {
    if (globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD === true) {
      if (!options.runtimeProfile) {
        throw new MessagingBuildApplierError("Messaging package installation requires --profile");
      }
      installMessagingPackagesFromProfile(plan, options.runtimeProfile, env);
    } else if (options.runtimeProfile) {
      installMessagingPackagesFromProfile(plan, options.runtimeProfile, env);
    } else {
      installMessagingPackages(plan, env);
    }
    return [];
  }
  const applyPostAgentInstallOutputs = (): readonly string[] => [
    ...applyMessagingAgentRenderToLocalFiles(plan),
    ...applyPostAgentInstallBuildFilesToLocalFiles(plan),
  ];
  const appliedTargets = applyPostAgentInstallOutputs();
  if (
    plan &&
    effectiveBuildProfile(plan).postRenderRepair !== undefined &&
    !options.managedStartupRuntime
  ) {
    runMessagingPostRenderRepair(plan, env);
    return uniqueStrings([...appliedTargets, ...applyPostAgentInstallOutputs()]);
  }
  return uniqueStrings(appliedTargets);
}

function applyPackageMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env,
  options: MessagingBuildPhaseOptions,
): readonly string[] {
  const mode = options.mode ?? "apply";
  if (mode === "clear") {
    if (plan !== null) throw new MessagingBuildApplierError("Messaging clear mode requires an absent plan");
    return [];
  }
  if (options.managedStartupRuntime && plan === null) {
    throw new MessagingBuildApplierError("Managed startup apply mode requires a messaging plan");
  }
  if (phase === "runtime-setup") {
    const target = writeMessagingRuntimePlanArtifact(plan, messagingRuntimePlanPath(env));
    return target ? [target] : [];
  }
  if (phase === "agent-install") {
    if (!options.runtimeProfile) {
      throw new MessagingBuildApplierError("Messaging package installation requires --profile");
    }
    installMessagingPackagesFromProfile(plan, options.runtimeProfile, env);
    return [];
  }
  const applyOutputs = (): readonly string[] => [
    ...applyMessagingAgentRenderToLocalFiles(plan),
    ...applyPostAgentInstallBuildFilesToLocalFiles(plan),
  ];
  const applied = applyOutputs();
  if (plan && effectiveBuildProfile(plan).postRenderRepair && !options.managedStartupRuntime) {
    runMessagingPostRenderRepair(plan, env);
    return uniqueStrings([...applied, ...applyOutputs()]);
  }
  return uniqueStrings(applied);
}

function renderInstallerCommand(
  command: readonly string[],
  placeholder: "{{archive}}" | "{{packages}}",
  values: readonly string[],
): string[] {
  const positions = command.flatMap((value, index) => (value === placeholder ? [index] : []));
  if (positions.length !== 1) {
    throw new MessagingBuildApplierError(
      `Messaging package installer command must contain exactly one ${placeholder} argument`,
    );
  }
  return command.flatMap((value) => (value === placeholder ? values : [value]));
}

function installRuntimeNodePackages(
  installs: readonly VerifiedNodePackageInstall[],
  profile: MessagingRuntimeProfile,
  env: Env,
): void {
  const installer = profile.build.packageInstallers?.["node-package"];
  if (!installer || installer.kind !== "verified-archive-command") {
    throw new MessagingBuildApplierError("Messaging build profile is missing its node package installer");
  }
  for (const install of installs) {
    const installCache = install.runtimeLock
      ? requireWritableRuntimeInstallCache(install.runtimeLock, env)
      : undefined;
    const installEnv = {
      ...env,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
      ...(install.runtimeLock
        ? {
            NPM_CONFIG_CACHE: installCache,
            NPM_CONFIG_OFFLINE: String(install.runtimeLock.offline),
            NPM_CONFIG_LEGACY_PEER_DEPS: String(install.runtimeLock.legacyPeerDeps),
          }
        : {}),
    };
    const packed = packVerifiedNodePackageArchive(
      install,
      installEnv,
      profile.build.nodeArchiveRemediation === "package-helper",
    );
    try {
      const archiveArgument = `${installer.archiveArgumentPrefix ?? ""}${packed.archivePath}`;
      runCommand(renderInstallerCommand(installer.command, "{{archive}}", [archiveArgument]), installEnv);
      if (install.runtimeLock) {
        const versionEnvironment = installer.packageVersionEnvironment;
        const packageVersion = versionEnvironment ? sanitizeOptionalString(env[versionEnvironment]) : "";
        if (!packageVersion) {
          throw new MessagingBuildApplierError(
            `${versionEnvironment ?? "Package version environment"} is required to verify the runtime lock`,
          );
        }
        runCommand(
          [
            "node",
            "--experimental-strip-types",
            install.runtimeLock.verifierPath,
            install.runtimeLock.lockFile,
            install.runtimeLock.projectsRoot,
            packageVersion,
          ],
          installEnv,
        );
      }
    } finally {
      rmSync(packed.rootDir, { recursive: true, force: true });
    }
  }
}

function installRuntimePythonPackages(
  installs: readonly PinnedPythonPackageInstall[],
  profile: MessagingRuntimeProfile,
  env: Env,
): void {
  if (installs.length === 0) return;
  const installer = profile.build.packageInstallers?.["python-package"];
  if (!installer || installer.kind !== "batched-command") {
    throw new MessagingBuildApplierError("Messaging build profile is missing its Python package installer");
  }
  runCommand(
    renderInstallerCommand(installer.command, "{{packages}}", installs.map(({ spec }) => spec)),
    { ...env, ...(installer.environment ?? {}) },
  );
}

function installMessagingPackagesFromProfile(
  plan: MessagingBuildPlan | null,
  profile: MessagingRuntimeProfile,
  env: Env,
  allChannels = false,
): void {
  if (!plan && !allChannels) return;
  const managers = profile.build.packageManagers;
  if (managers.includes("node-package")) {
    installRuntimeNodePackages(collectRuntimeNodePackages(plan, profile, env, allChannels), profile, env);
  }
  if (managers.includes("python-package")) {
    installRuntimePythonPackages(collectRuntimePythonPackages(plan, profile, allChannels), profile, env);
  }
}

export function installMessagingPackages(plan: MessagingBuildPlan | null, env: Env): void {
  if (!plan) return;
  const managers = effectiveBuildProfile(plan).packageManagers;
  if (managers.includes("node-package")) installOpenClawMessagingPlugins(plan, env);
  if (managers.includes("python-package")) installHermesMessagingUvPackages(plan, env);
}

function installHermesMessagingUvPackages(plan: MessagingBuildPlan | null, env: Env): void {
  const selectedPackages = collectHermesMessagingUvPackageInstalls(plan).map(
    (install) => install.spec,
  );
  installHermesUvPackages(selectedPackages, env);
}

function installHermesUvPackages(selectedPackages: readonly string[], env: Env): void {
  if (selectedPackages.length === 0) return;
  runCommand(
    [
      "uv",
      "pip",
      "install",
      "--python",
      "/opt/hermes/.venv/bin/python",
      "--no-cache",
      "--",
      ...selectedPackages,
    ],
    // uv (rustls) ignores the corporate-only SSL_CERT_FILE, so a PyPI fetch
    // behind a MITM proxy fails with `UnknownIssuer`. Point it at the merged
    // system bundle instead; harmless off-proxy, and UV_SYSTEM_CERTS is the
    // current name for UV_NATIVE_TLS.
    {
      ...env,
      UV_SYSTEM_CERTS: "1",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    },
  );
}

export function installManagedImageCapabilityUnion(
  agent: MessagingAgentId,
  env: Env = process.env,
): void {
  // This is the pre-contract, plan-absent stock-image build lane. Receipt-backed
  // messaging always enters installMessagingPackages with a packageBuild profile.
  if (env.NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION !== "1") {
    throw new MessagingBuildApplierError(
      "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
    );
  }
  if (agent === "openclaw") {
    installOpenClawPluginPackages(collectManagedImageOpenClawPluginInstalls(env), env, true);
    return;
  }
  if (agent === "hermes") {
    installHermesUvPackages(collectManagedImageHermesUvPackages(), env);
    return;
  }
  throw new MessagingBuildApplierError(
    `Managed-image capability union is not defined for ${agent}`,
  );
}

export function describeMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env,
  runtimeProfile?: MessagingRuntimeProfile,
): BuildCommandResult & {
  readonly agent: MessagingAgentId | "unknown";
  readonly phase: MessagingBuildPhase;
} {
  const managers = plan ? effectiveBuildProfile(plan).packageManagers : [];
  const installSpecs =
    plan && managers.includes("node-package")
      ? runtimeProfile
        ? collectRuntimeNodePackages(plan, runtimeProfile, env).map(({ spec }) => spec)
        : collectOpenClawMessagingPluginInstallSpecs(plan, env)
      : [];
  const pythonPackages =
    plan && managers.includes("python-package")
      ? runtimeProfile
        ? collectRuntimePythonPackages(plan, runtimeProfile).map(({ spec }) => spec)
        : collectHermesMessagingUvPackages(plan)
      : [];
  const packageVersion = runtimeProfile?.build.packageInstallers?.["node-package"]
    ?.packageVersionEnvironment
    ? env[runtimeProfile.build.packageInstallers["node-package"].packageVersionEnvironment!] ?? ""
    : env.OPENCLAW_VERSION ?? "";
  return {
    agent: plan?.agent ?? "unknown",
    phase,
    channels: activeChannels(plan),
    runtimePlanPath: phase === "runtime-setup" ? messagingRuntimePlanPath(env) : "",
    doctorEnv:
      plan && effectiveBuildProfile(plan).postRenderRepair !== undefined
        ? messagingRepairEnvOverrides(plan, env)
        : {},
    installSpecs,
    pythonPackages,
    packageVersion,
    hermesUvPackages: pythonPackages,
    openclawVersion: packageVersion,
  };
}

function describePackageMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env,
  runtimeProfile?: MessagingRuntimeProfile,
): BuildCommandResult & {
  readonly agent: MessagingAgentId | "unknown";
  readonly phase: MessagingBuildPhase;
} {
  return {
    agent: plan?.agent ?? "unknown",
    phase,
    channels: activeChannels(plan),
    runtimePlanPath: phase === "runtime-setup" ? messagingRuntimePlanPath(env) : "",
    doctorEnv:
      plan && effectiveBuildProfile(plan).postRenderRepair !== undefined
        ? messagingRepairEnvOverrides(plan, env)
        : {},
    installSpecs:
      plan && runtimeProfile && effectiveBuildProfile(plan).packageManagers.includes("node-package")
        ? collectRuntimeNodePackages(plan, runtimeProfile, env).map(({ spec }) => spec)
        : [],
    pythonPackages:
      plan && runtimeProfile && effectiveBuildProfile(plan).packageManagers.includes("python-package")
        ? collectRuntimePythonPackages(plan, runtimeProfile).map(({ spec }) => spec)
        : [],
    packageVersion: runtimeProfile?.build.packageInstallers?.["node-package"]
      ?.packageVersionEnvironment
      ? env[runtimeProfile.build.packageInstallers["node-package"].packageVersionEnvironment!] ?? ""
      : "",
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  runMessagingBuildCommand(
    parseMessagingBuildArgs(argv),
    applyMessagingBuildPhase,
    describeMessagingBuildPhase,
  );
}

/** Standalone package entry: every operation is bound to explicit package-owned data. */
export function packageRuntimeMain(argv: readonly string[] = process.argv.slice(2)): void {
  const parsed = parseMessagingBuildArgs(argv);
  if (!parsed.profilePath) {
    throw new MessagingBuildApplierError("Package messaging runtime requires --profile");
  }
  runMessagingBuildCommand(
    parsed,
    applyPackageMessagingBuildPhase,
    describePackageMessagingBuildPhase,
  );
}

function runMessagingBuildCommand({
  agent,
  phase,
  dryRun,
  managedStartupRuntime,
  mode,
  profilePath,
}: ReturnType<typeof parseMessagingBuildArgs>, applyPhase: (
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env,
  options: MessagingBuildPhaseOptions,
) => readonly string[], describePhase: typeof describePackageMessagingBuildPhase): void {
  const plan = readMessagingBuildPlanFromEnv(process.env, agent);
  const runtimeProfile = profilePath ? readMessagingRuntimeProfile(profilePath, agent) : undefined;
  if (phase === "managed-image-capability-union") {
    // Stock publication intentionally has no receipt-backed messaging plan.
    if (plan) {
      throw new MessagingBuildApplierError(
        "Managed-image capability union must be built without a serialized messaging plan",
      );
    }
    if (!runtimeProfile) {
      throw new MessagingBuildApplierError("Managed-image capability union requires --profile");
    }
    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            agent,
            phase,
            channels: [],
            runtimePlanPath: "",
            doctorEnv: {},
            installSpecs: collectRuntimeNodePackages(null, runtimeProfile, process.env, true).map(
              ({ spec }) => spec,
            ),
            pythonPackages: collectRuntimePythonPackages(null, runtimeProfile, true).map(
              ({ spec }) => spec,
            ),
            packageVersion:
              process.env[
                runtimeProfile.build.packageInstallers?.["node-package"]
                  ?.packageVersionEnvironment ?? ""
              ] ?? "",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (process.env.NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION !== "1") {
      throw new MessagingBuildApplierError(
        "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      );
    }
    installMessagingPackagesFromProfile(null, runtimeProfile, process.env, true);
    return;
  }
  if (dryRun) {
    console.log(
      JSON.stringify(
        describePhase(plan, phase, process.env, runtimeProfile),
        null,
        2,
      ),
    );
    return;
  }
  applyPhase(plan, phase, process.env, {
    managedStartupRuntime,
    mode,
    ...(runtimeProfile ? { runtimeProfile } : {}),
  });
}

function parseMessagingBuildArgs(argv: readonly string[]): {
  readonly agent: MessagingAgentId;
  readonly phase: MessagingBuildCliPhase;
  readonly dryRun: boolean;
  readonly managedStartupRuntime: boolean;
  readonly mode: MessagingBuildApplyMode;
  readonly profilePath?: string;
} {
  let agent: MessagingAgentId | undefined;
  let phase: MessagingBuildCliPhase | undefined;
  let dryRun = false;
  let managedStartupRuntime = false;
  let mode: MessagingBuildApplyMode = "apply";
  let profilePath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--managed-startup-runtime") {
      managedStartupRuntime = true;
      continue;
    }
    if (arg === "--profile") {
      profilePath = readProfilePathArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profilePath = readProfilePathArg(arg.slice("--profile=".length));
      continue;
    }
    if (arg === "--mode") {
      mode = readApplyModeArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = readApplyModeArg(arg.slice("--mode=".length));
      continue;
    }
    if (arg === "--agent") {
      agent = readAgentArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      agent = readAgentArg(arg.slice("--agent=".length));
      continue;
    }
    if (arg === "--phase") {
      phase = readPhaseArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--phase=")) {
      phase = readPhaseArg(arg.slice("--phase=".length));
      continue;
    }
    if (!arg.startsWith("-") && !phase) {
      phase = readPhaseArg(arg);
      continue;
    }
    throw new MessagingBuildApplierError(`Unknown messaging build applier argument: ${arg}`);
  }

  const resolvedPhase = phase ?? "post-agent-install";
  if (managedStartupRuntime && resolvedPhase !== "post-agent-install") {
    throw new MessagingBuildApplierError(
      "--managed-startup-runtime requires --phase post-agent-install",
    );
  }
  return {
    agent:
      agent ??
      (() => {
        if (globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD === true) {
          throw new MessagingBuildApplierError("Package messaging runtime requires --agent");
        }
        return "openclaw";
      })(),
    phase: resolvedPhase,
    dryRun,
    managedStartupRuntime,
    mode,
    ...(profilePath ? { profilePath } : {}),
  };
}

function readProfilePathArg(value: string | undefined): string {
  const profilePath = sanitizeOptionalString(value);
  if (profilePath && isAbsolute(profilePath)) return profilePath;
  throw new MessagingBuildApplierError("--profile must be an absolute path");
}

function readApplyModeArg(value: string | undefined): MessagingBuildApplyMode {
  if (value === "apply" || value === "clear") {
    return value;
  }
  throw new MessagingBuildApplierError("--mode must be 'apply' or 'clear'");
}

function readAgentArg(value: string | undefined): MessagingAgentId {
  const agent = sanitizeOptionalString(value);
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(agent)) return agent;
  throw new MessagingBuildApplierError("--agent must be a canonical package id");
}

function readPhaseArg(value: string | undefined): MessagingBuildCliPhase {
  if (
    value === "runtime-setup" ||
    value === "agent-install" ||
    value === "post-agent-install" ||
    value === "managed-image-capability-union"
  ) {
    return value;
  }
  throw new MessagingBuildApplierError(
    "--phase must be 'runtime-setup', 'agent-install', 'post-agent-install', or 'managed-image-capability-union'",
  );
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (
  globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD !== true &&
  isMainModule()
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
