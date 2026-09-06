// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

import type {
  HarnessStartupAction,
  HarnessStartupAdapterRequest,
  HarnessStartupApplicationRuntimePlan,
  HarnessStartupManagedStatePlan,
  HarnessStartupMaterial,
} from "@nvidia/nemoclaw-harness-contract";

import { parseHarnessPackageIdentity } from "../../agent-runtime/package/identity-validation.ts";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types.ts";
import { HARNESS_STARTUP_PLAN_ADAPTER_CONTRACT } from "../../agent-runtime/adapter/startup.ts";
import {
  HarnessAdapterError,
  loadHarnessAdapterFromSource,
} from "../../agent-runtime/adapter/loader.ts";
import {
  isManagedStartupPackageProfile,
  type ManagedStartupDurableProfile,
  validateManagedStartupDurableProfile,
} from "./profile";

export const HARNESS_STARTUP_ADAPTER_FILE = "/usr/local/lib/nemoclaw/startup-adapter.cjs";
const MAX_ADAPTER_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 512 * 1024;
const MAX_ROOT_FILE_BYTES = 64 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIAL_ENVIRONMENT_NAME = /(?:^|_)(?:API_KEY|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|$)/iu;
const ROOT_MATERIAL_PATH = /^\/usr\/local\/share\/nemoclaw\/[a-z0-9][a-z0-9._/-]*$/u;
const PUBLIC_APPLICATION_ENVIRONMENT = Object.freeze([
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
]);

type ApplicationEnvironment = Readonly<Record<string, string | undefined>>;
const EMPTY_APPLICATION_ENVIRONMENT: ApplicationEnvironment = Object.freeze({});

export type ManagedStartupApplicationRuntimePlan = HarnessStartupApplicationRuntimePlan;
export type ManagedStartupManagedStatePlan = HarnessStartupManagedStatePlan;
export type ManagedStartupAgentMaterial = HarnessStartupMaterial;
export type ManagedStartupAgentAction = HarnessStartupAction;

export interface ManagedStartupAgentEnvironment {
  readonly schemaVersion: 1;
  readonly agent: string;
  readonly configurationEnvironment: Readonly<Record<string, string>>;
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
  readonly applicationRuntime: ManagedStartupApplicationRuntimePlan;
  readonly managedState: ManagedStartupManagedStatePlan;
  readonly materials: readonly ManagedStartupAgentMaterial[];
  readonly actions: readonly ManagedStartupAgentAction[];
}

export interface HarnessStartupAdapterSource {
  readonly filename: string;
  readonly source: string;
  /** Receipt-pinned identity for host-loaded package bytes. Required by generic profiles. */
  readonly harnessPackage?: HarnessPackageIdentity;
}

export interface MapManagedStartupEnvironmentOptions {
  /** Tests and package qualification can provide already-reviewed source bytes. */
  readonly adapterSource?: HarnessStartupAdapterSource;
}

export class ManagedStartupAgentEnvironmentError extends Error {
  constructor(message: string) {
    super(`Cannot map managed startup profile: ${message}`);
    this.name = "ManagedStartupAgentEnvironmentError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupAgentEnvironmentError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, names: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has unsupported fields`);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function environmentText(value: unknown, name: string): string {
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES ||
      value.includes("\0") ||
      /[\r\n]/u.test(value)
    ) {
      fail(`environment value for ${name} must be bounded single-line text`);
    }
    return value;
  }
  if (!isRecord(value)) fail(`environment value for ${name} is invalid`);
  exactKeys(value, ["kind", "value"], `environment value for ${name}`);
  if (value.kind !== "canonical-json-base64") {
    fail(`environment value for ${name} uses an unsupported encoding`);
  }
  const json = JSON.stringify(canonicalizeJson(value.value));
  if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    fail(`encoded environment value for ${name} is invalid or oversized`);
  }
  return Buffer.from(json, "utf8").toString("base64");
}

function resolvedEnvironment(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) fail(`${label} has too many entries`);
  const environment: Record<string, string> = {};
  for (const [name, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!ENVIRONMENT_NAME.test(name) || CREDENTIAL_ENVIRONMENT_NAME.test(name)) {
      fail(`${label} contains unsafe name ${JSON.stringify(name)}`);
    }
    environment[name] = environmentText(raw, name);
  }
  return Object.freeze(environment);
}

function applicationRuntime(value: unknown): ManagedStartupApplicationRuntimePlan {
  if (!isRecord(value)) fail("applicationRuntime must be an object");
  exactKeys(value, ["exportEnvironment", "unsetEnvironment"], "applicationRuntime");
  const exportEnvironment = resolvedEnvironment(
    value.exportEnvironment,
    "applicationRuntime.exportEnvironment",
  );
  if (!Array.isArray(value.unsetEnvironment) || value.unsetEnvironment.length > 256) {
    fail("applicationRuntime.unsetEnvironment must be a bounded array");
  }
  const unsets = new Set<string>();
  for (const raw of value.unsetEnvironment) {
    if (
      typeof raw !== "string" ||
      !ENVIRONMENT_NAME.test(raw) ||
      CREDENTIAL_ENVIRONMENT_NAME.test(raw) ||
      unsets.has(raw) ||
      Object.hasOwn(exportEnvironment, raw)
    ) {
      fail("applicationRuntime.unsetEnvironment contains an invalid entry");
    }
    unsets.add(raw);
  }
  return Object.freeze({
    exportEnvironment,
    unsetEnvironment: Object.freeze([...unsets].sort()),
  });
}

function managedStatePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.split("/").some((segment) => segment === "..")
  ) {
    fail(`${label} must be a normalized relative path`);
  }
  return value;
}

function managedStatePaths(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    fail(`${label} must be a bounded array`);
  }
  const paths = value.map((entry, index) => managedStatePath(entry, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) fail(`${label} contains duplicate paths`);
  return Object.freeze([...paths].sort());
}

function managedState(value: unknown): ManagedStartupManagedStatePlan {
  if (!isRecord(value)) fail("managedState must be an object");
  exactKeys(value, ["root", "files", "directories"], "managedState");
  if (
    typeof value.root !== "string" ||
    value.root.length > 512 ||
    !/^\/sandbox\/[^/]+$/u.test(value.root) ||
    path.posix.normalize(value.root) !== value.root ||
    value.root.includes("\0") ||
    value.root === "/sandbox/"
  ) {
    fail("managedState.root must be a normalized path below /sandbox");
  }
  const files = managedStatePaths(value.files, "managedState.files");
  const directories = managedStatePaths(value.directories, "managedState.directories");
  if (files.some((file) => directories.includes(file))) {
    fail("managedState paths cannot be both files and directories");
  }
  return Object.freeze({
    root: value.root as `/sandbox/${string}`,
    files,
    directories,
  });
}

function startupMaterial(value: unknown): ManagedStartupAgentMaterial {
  if (!isRecord(value)) fail("startup material must be an object");
  if (value.kind === "corporate-ca-handoff") {
    exactKeys(value, ["kind", "legacyInput", "expectedSha256"], "corporate CA material");
    if (
      value.legacyInput !== "NEMOCLAW_CORPORATE_CA_B64" ||
      (value.expectedSha256 !== null &&
        (typeof value.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedSha256)))
    ) {
      fail("corporate CA material is invalid");
    }
    return Object.freeze({
      kind: "corporate-ca-handoff",
      legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
      expectedSha256: value.expectedSha256,
    });
  }
  if (value.kind !== "root-owned-file") fail("startup material kind is unsupported");
  exactKeys(
    value,
    ["kind", "legacyInput", "path", "contents", "owner", "group", "mode"],
    "root-owned material",
  );
  if (
    typeof value.legacyInput !== "string" ||
    !ENVIRONMENT_NAME.test(value.legacyInput) ||
    CREDENTIAL_ENVIRONMENT_NAME.test(value.legacyInput) ||
    typeof value.path !== "string" ||
    !ROOT_MATERIAL_PATH.test(value.path) ||
    value.path.includes("..") ||
    typeof value.contents !== "string" ||
    Buffer.byteLength(value.contents, "utf8") > MAX_ROOT_FILE_BYTES ||
    value.contents.includes("\0") ||
    value.owner !== "root" ||
    value.group !== "root" ||
    value.mode !== 0o444
  ) {
    fail("root-owned material is invalid");
  }
  return Object.freeze({
    kind: "root-owned-file",
    legacyInput: value.legacyInput,
    path: value.path as `/usr/local/share/nemoclaw/${string}`,
    contents: value.contents,
    owner: "root",
    group: "root",
    mode: 0o444,
  });
}

function startupAction(value: unknown): ManagedStartupAgentAction {
  if (!isRecord(value)) fail("startup action must be an object");
  if (value.kind === "generate-config") {
    exactKeys(value, ["kind", "runAs"], "generate-config action");
    if (value.runAs !== "sandbox") fail("generate-config must run as sandbox");
    return Object.freeze({ kind: "generate-config", runAs: "sandbox" });
  }
  if (value.kind === "seal-config") {
    exactKeys(value, ["kind", "runAs", "committedReplay"], "seal-config action");
    if (value.runAs !== "root" && value.runAs !== "sandbox") {
      fail("seal-config identity is invalid");
    }
    if (value.committedReplay !== "run" && value.committedReplay !== "skip") {
      fail("seal-config committed replay behavior is invalid");
    }
    return Object.freeze({
      kind: "seal-config",
      runAs: value.runAs,
      committedReplay: value.committedReplay,
    });
  }
  if (value.kind !== "apply-messaging") fail("startup action kind is unsupported");
  exactKeys(value, ["kind", "mode", "phase", "runAs"], "apply-messaging action");
  if (value.mode !== "apply" && value.mode !== "clear") fail("messaging mode is invalid");
  if (value.phase === "runtime-setup" && value.runAs === "root") {
    return Object.freeze({
      kind: "apply-messaging",
      mode: value.mode,
      phase: "runtime-setup",
      runAs: "root",
    });
  }
  if (value.phase === "post-agent-install" && value.runAs === "sandbox") {
    return Object.freeze({
      kind: "apply-messaging",
      mode: value.mode,
      phase: "post-agent-install",
      runAs: "sandbox",
    });
  }
  return fail("messaging phase and identity are inconsistent");
}

function startupActions(value: unknown): readonly ManagedStartupAgentAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    fail("actions must contain one bounded startup workflow");
  }
  const actions = value.map(startupAction);
  const kinds = actions.map((action) =>
    action.kind === "apply-messaging" ? `${action.kind}:${action.phase}` : action.kind,
  );
  const supportedOrders = [
    ["generate-config"],
    ["generate-config", "seal-config"],
    ["apply-messaging:runtime-setup", "generate-config", "apply-messaging:post-agent-install"],
    [
      "apply-messaging:runtime-setup",
      "generate-config",
      "apply-messaging:post-agent-install",
      "seal-config",
    ],
  ];
  if (!supportedOrders.some((order) => JSON.stringify(kinds) === JSON.stringify(order))) {
    fail("actions are not in a supported transaction order");
  }
  if (
    actions.length === 3 &&
    actions[0]?.kind === "apply-messaging" &&
    actions[2]?.kind === "apply-messaging" &&
    actions[0].mode !== actions[2].mode
  ) {
    fail("messaging actions disagree about desired state");
  }
  return Object.freeze(actions);
}

export function validateHarnessStartupPlan(
  value: unknown,
  expectedPackageId: string,
): ManagedStartupAgentEnvironment {
  if (!isRecord(value)) fail("startup adapter result must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "packageId",
      "configurationEnvironment",
      "runtimeEnvironment",
      "applicationRuntime",
      "managedState",
      "materials",
      "actions",
    ],
    "startup adapter result",
  );
  if (value.schemaVersion !== 1 || value.packageId !== expectedPackageId) {
    fail("startup adapter result identity does not match its package");
  }
  if (
    !Array.isArray(value.materials) ||
    value.materials.length < 1 ||
    value.materials.length > 32
  ) {
    fail("materials must be a bounded array");
  }
  const materials = value.materials.map(startupMaterial);
  if (materials.filter((material) => material.kind === "corporate-ca-handoff").length !== 1) {
    fail("exactly one corporate CA handoff is required");
  }
  return Object.freeze({
    schemaVersion: 1,
    agent: expectedPackageId,
    configurationEnvironment: resolvedEnvironment(
      value.configurationEnvironment,
      "configurationEnvironment",
    ),
    runtimeEnvironment: resolvedEnvironment(value.runtimeEnvironment, "runtimeEnvironment"),
    applicationRuntime: applicationRuntime(value.applicationRuntime),
    managedState: managedState(value.managedState),
    materials: Object.freeze(materials),
    actions: startupActions(value.actions),
  });
}

function verifiedImageAdapterSource(): HarnessStartupAdapterSource {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      HARNESS_STARTUP_ADAPTER_FILE,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch {
    return fail(`managed image does not contain ${HARNESS_STARTUP_ADAPTER_FILE}`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== 0 ||
      stat.gid !== 0 ||
      (stat.mode & 0o777) !== 0o444 ||
      stat.size < 1 ||
      stat.size > MAX_ADAPTER_BYTES
    ) {
      fail("managed image startup adapter must be a bounded root:root mode 0444 regular file");
    }
    return {
      filename: HARNESS_STARTUP_ADAPTER_FILE,
      source: fs.readFileSync(descriptor, "utf8"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function invokeStartupAdapter(
  source: HarnessStartupAdapterSource,
  request: HarnessStartupAdapterRequest,
): unknown {
  if (Buffer.byteLength(source.source, "utf8") > MAX_ADAPTER_BYTES)
    fail("startup adapter is oversized");
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson, "utf8") > MAX_REQUEST_BYTES)
    fail("startup request is oversized");
  try {
    return loadHarnessAdapterFromSource(source, HARNESS_STARTUP_PLAN_ADAPTER_CONTRACT).buildPlan(
      request,
    );
  } catch (error) {
    if (!(error instanceof HarnessAdapterError)) throw error;
    return fail("startup adapter could not be evaluated");
  }
}

function requireMatchingPackageAuthority(
  request: HarnessStartupAdapterRequest,
  source: HarnessStartupAdapterSource,
): void {
  if (request.profileKind !== "package") return;

  // The fixed image-local path is selected only after the runtime verifies the
  // qualified immutable image. Host-loaded adapter bytes must additionally
  // carry the exact package receipt. Binding that receipt to signed image
  // publication metadata remains the release attestation gate; it must not be
  // approximated by trusting an arbitrary host source path here.
  if (source.harnessPackage === undefined && source.filename === HARNESS_STARTUP_ADAPTER_FILE) {
    return;
  }

  let requested: HarnessPackageIdentity;
  let provided: HarnessPackageIdentity;
  try {
    requested = parseHarnessPackageIdentity(request.harnessPackage);
    provided = parseHarnessPackageIdentity(source.harnessPackage);
  } catch {
    return fail("receipt-backed startup adapter source has no valid package identity");
  }
  if (
    request.packageId !== requested.id ||
    requested.kind !== provided.kind ||
    requested.id !== provided.id ||
    requested.packageVersion !== provided.packageVersion ||
    requested.contentDigest !== provided.contentDigest
  ) {
    fail("startup adapter source does not match the receipt-backed package identity");
  }
}

/** Evaluate one self-contained package adapter and validate its finite result. */
export function buildHarnessStartupPlanFromSource(
  request: HarnessStartupAdapterRequest,
  source: HarnessStartupAdapterSource,
): ManagedStartupAgentEnvironment {
  requireMatchingPackageAuthority(request, source);
  return validateHarnessStartupPlan(invokeStartupAdapter(source, request), request.packageId);
}

function startupRequest(
  profile: ManagedStartupDurableProfile,
  environment: ApplicationEnvironment,
): HarnessStartupAdapterRequest {
  const applicationEnvironment = Object.fromEntries(
    PUBLIC_APPLICATION_ENVIRONMENT.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  if (isManagedStartupPackageProfile(profile)) {
    return {
      profileKind: "package",
      packageId: profile.agent,
      harnessPackage: profile.harnessPackage,
      packageConfig: profile.packageConfig,
      corporateCa: profile.corporateCa,
      applicationEnvironment,
    };
  }
  return {
    packageId: profile.agent,
    settings: {
      configuration: profile.agentConfig,
      inference: profile.inference,
      proxy: profile.proxy,
      dashboard: profile.dashboard,
      tools: profile.tools,
      messaging: profile.messaging,
      tuning: profile.tuning,
      corporateCa: profile.corporateCa,
    },
    applicationEnvironment,
  };
}

/**
 * Invoke the one package-owned startup planner installed in the selected
 * image, then reduce its output to the finite plan that core can apply.
 */
export function mapManagedStartupProfileToAgentEnvironment(
  profile: ManagedStartupDurableProfile,
  environment: ApplicationEnvironment = EMPTY_APPLICATION_ENVIRONMENT,
  options: MapManagedStartupEnvironmentOptions = {},
): ManagedStartupAgentEnvironment {
  const request = startupRequest(validateManagedStartupDurableProfile(profile), environment);
  const source = options.adapterSource ?? verifiedImageAdapterSource();
  return buildHarnessStartupPlanFromSource(request, source);
}
