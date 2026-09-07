// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  HarnessProviderBrokerControllerRequest,
  HarnessProviderBrokerControllerResult,
  HarnessProviderBrokerInspectionResult,
  HarnessProviderBrokerOperation,
  HarnessProviderBrokerPlan,
} from "@nvidia/nemoclaw-harness-contract";
import {
  HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT,
  type HarnessProviderBrokerPlanRequest,
} from "./adapter/provider-broker";
import { HarnessAdapterError, loadHarnessAdapter } from "./adapter/loader";
import { readString } from "./manifest-readers";
import {
  getHarnessPackageStoreRoot,
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
} from "./package/store";
import {
  assertTreeAuthority,
  currentEffectiveUid,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "./package/tree";
import type { HarnessPackageIdentity } from "./package/types";

const CONTROLLER_PATH = "host/provider-broker-control.cts";
const HOST_FILE_LIMIT = 64;
const HOST_FILE_BYTES = 2 * 1024 * 1024;
const HOST_TOTAL_BYTES = 16 * 1024 * 1024;
const CONTROLLER_INPUT_BYTES = 256 * 1024;
const CONTROLLER_OUTPUT_BYTES = 256 * 1024;
const CONTROLLER_TIMEOUT_MS = 20_000;
const HOST_RUNTIME_DIRECTORY = "provider-broker-runtimes";

type ProviderBrokerHostFile = {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly relativePath: string;
};

type ProviderBrokerHostRuntime = {
  readonly directories: readonly string[];
  readonly root: string;
  readonly files: readonly ProviderBrokerHostFile[];
};

export class HarnessProviderBrokerError extends Error {
  override readonly name = "HarnessProviderBrokerError";
}

function assertPrivateRuntimeDirectory(directory: string): void {
  const stat = fs.lstatSync(directory, { bigint: true });
  const uid = currentEffectiveUid();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o7777n) !== 0o700n ||
    (uid !== null && stat.uid !== uid)
  ) {
    throw new HarnessProviderBrokerError(
      "Provider-broker host runtime directory is not current-user private",
    );
  }
}

function ensurePrivateRuntimeDirectory(directory: string): void {
  try {
    assertPrivateRuntimeDirectory(directory);
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  assertPrivateRuntimeDirectory(directory);
}

function runtimePathIsMissing(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function runtimeDirectoryPaths(options: HarnessPackageStoreOptions): {
  readonly base: string;
  readonly shard: string;
  readonly staging: string;
} {
  const storeRoot = path.resolve(options.storeRoot ?? getHarnessPackageStoreRoot());
  const base = path.join(path.dirname(storeRoot), HOST_RUNTIME_DIRECTORY);
  return Object.freeze({
    base,
    shard: path.join(base, "sha256"),
    staging: path.join(base, "staging"),
  });
}

function expectedRuntimeDirectories(files: readonly ProviderBrokerHostFile[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const components = file.relativePath.split("/");
    for (let end = 1; end < components.length; end += 1) {
      directories.add(components.slice(0, end).join("/"));
    }
  }
  return Object.freeze(
    [...directories].sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth === 0 ? left.localeCompare(right) : depth;
    }),
  );
}

function updateRuntimeDigestFrame(hash: crypto.Hash, value: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length);
  hash.update(value);
}

function digestProviderBrokerHostRuntime(files: readonly ProviderBrokerHostFile[]): string {
  const hash = crypto.createHash("sha256");
  hash.update("nemoclaw-provider-broker-host-runtime\0", "utf8");
  for (const file of files) {
    updateRuntimeDigestFrame(hash, Buffer.from(file.relativePath, "utf8"));
    updateRuntimeDigestFrame(hash, Buffer.from("file:0400", "utf8"));
    updateRuntimeDigestFrame(hash, file.bytes);
  }
  return hash.digest("hex");
}

function validatePersistentHostRuntime(
  runtimeRoot: string,
  expectedFiles: readonly ProviderBrokerHostFile[],
  expectedDirectories: readonly string[],
): void {
  const tree = validateHarnessPackageTree(runtimeRoot, {
    sourceTrust: "mutable",
    limits: {
      maxDepth: 32,
      maxEntries: HOST_FILE_LIMIT * 32,
      maxFileBytes: HOST_FILE_BYTES,
      maxTotalBytes: HOST_TOTAL_BYTES,
    },
  });
  const authority = getPackageTreeAuthority(tree);
  if ((authority.root.stat.mode & 0o7777n) !== 0o700n) {
    throw new HarnessProviderBrokerError(
      "Provider-broker host runtime root has unsafe permissions",
    );
  }
  const expectedPaths = new Map<string, "directory" | ProviderBrokerHostFile>();
  for (const relativePath of expectedDirectories) expectedPaths.set(relativePath, "directory");
  for (const file of expectedFiles) expectedPaths.set(file.relativePath, file);
  if (authority.entries.length !== expectedPaths.size) {
    throw new HarnessProviderBrokerError("Provider-broker host runtime tree changed");
  }
  for (const entry of authority.entries) {
    const expected = expectedPaths.get(entry.relativePath);
    if (!expected || (expected === "directory") !== (entry.type === "directory")) {
      throw new HarnessProviderBrokerError("Provider-broker host runtime tree changed");
    }
    const expectedMode = entry.type === "directory" ? 0o700n : 0o400n;
    if ((entry.stat.mode & 0o7777n) !== expectedMode) {
      throw new HarnessProviderBrokerError("Provider-broker host runtime permissions changed");
    }
    if (expected !== "directory") {
      const bytes = readVerifiedFile(entry, HOST_FILE_BYTES);
      if (
        bytes.length !== expected.bytes.length ||
        crypto.createHash("sha256").update(bytes).digest("hex") !== expected.digest
      ) {
        throw new HarnessProviderBrokerError("Provider-broker host runtime contents changed");
      }
    }
  }
  assertTreeAuthority(authority);
}

function removePrivateRuntimeStage(runtime: ProviderBrokerHostRuntime): void {
  for (const file of [...runtime.files].reverse()) {
    const target = path.join(runtime.root, ...file.relativePath.split("/"));
    const stat = fs.lstatSync(target, { bigint: true });
    const uid = currentEffectiveUid();
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1n ||
      (stat.mode & 0o7777n) !== 0o400n ||
      (uid !== null && stat.uid !== uid) ||
      crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== file.digest
    ) {
      throw new HarnessProviderBrokerError(
        "Provider-broker host runtime staging cleanup could not prove ownership",
      );
    }
    fs.unlinkSync(target);
  }
  for (const relativePath of [...runtime.directories].reverse()) {
    const target = path.join(runtime.root, ...relativePath.split("/"));
    assertPrivateRuntimeDirectory(target);
    fs.rmdirSync(target);
  }
  assertPrivateRuntimeDirectory(runtime.root);
  fs.rmdirSync(runtime.root);
}

function publishPersistentHostRuntime(
  target: string,
  paths: ReturnType<typeof runtimeDirectoryPaths>,
  files: readonly ProviderBrokerHostFile[],
  directories: readonly string[],
): void {
  const stageRoot = path.join(
    paths.staging,
    `.${path.basename(target)}.${String(process.pid)}.${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  const createdDirectories: string[] = [];
  const createdFiles: ProviderBrokerHostFile[] = [];
  const stagedRuntime = (): ProviderBrokerHostRuntime =>
    Object.freeze({
      root: stageRoot,
      files: Object.freeze([...createdFiles]),
      directories: Object.freeze([...createdDirectories]),
    });
  let published = false;
  try {
    for (const relativePath of directories) {
      fs.mkdirSync(path.join(stageRoot, ...relativePath.split("/")), { mode: 0o700 });
      createdDirectories.push(relativePath);
    }
    for (const file of files) {
      fs.writeFileSync(path.join(stageRoot, ...file.relativePath.split("/")), file.bytes, {
        flag: "wx",
        mode: 0o400,
      });
      createdFiles.push(file);
    }
    validatePersistentHostRuntime(stageRoot, files, directories);
    try {
      fs.renameSync(stageRoot, target);
      published = true;
    } catch (publicationError) {
      let existingRuntimeValid = false;
      try {
        validatePersistentHostRuntime(target, files, directories);
        existingRuntimeValid = true;
      } catch {
        /* Preserve the original publication failure when no exact winner exists. */
      }
      removePrivateRuntimeStage(stagedRuntime());
      if (!existingRuntimeValid) throw publicationError;
    }
    validatePersistentHostRuntime(target, files, directories);
  } catch (error) {
    if (!published && fs.existsSync(stageRoot)) {
      try {
        removePrivateRuntimeStage(stagedRuntime());
      } catch (cleanupError) {
        throw new HarnessProviderBrokerError(
          "Provider-broker host runtime staging cleanup was incomplete",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}

function validateManagedManifest(manifest: Record<string, unknown>): void {
  const declaration = manifest.provider_broker;
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new HarnessProviderBrokerError(
      "Installed harness package does not support a provider broker",
    );
  }
  const capability = declaration as Record<string, unknown>;
  if (capability.support !== "managed" || capability.adapter !== "provider-broker") {
    throw new HarnessProviderBrokerError(
      "Installed harness package does not support a managed provider broker",
    );
  }
}

function loadProviderBrokerAdapter(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
) {
  return loadHarnessAdapter(identity, HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT, {
    ...options,
    validateManifest: validateManagedManifest,
  });
}

export function buildHarnessProviderBrokerPlan(
  identity: HarnessPackageIdentity,
  request: HarnessProviderBrokerPlanRequest,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderBrokerPlan {
  try {
    return loadProviderBrokerAdapter(identity, options).plan(request);
  } catch (error) {
    if (error instanceof HarnessAdapterError || error instanceof HarnessProviderBrokerError) {
      throw new HarnessProviderBrokerError(error.message, { cause: error });
    }
    throw error;
  }
}

function stageProviderBrokerHost(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions,
): string {
  const installed = resolvePinnedHarnessPackage(identity, options);
  if (readString(installed.packageManifest.manifest, "name") !== identity.id) {
    throw new HarnessProviderBrokerError(
      "Installed harness package manifest does not match its receipt",
    );
  }
  validateManagedManifest(installed.packageManifest.manifest);
  const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
  if (tree.contentDigest !== identity.contentDigest) {
    throw new HarnessProviderBrokerError(
      "Installed harness package tree does not match its receipt",
    );
  }
  const authority = getPackageTreeAuthority(tree);
  const manifestRoot = path.posix.dirname(installed.packageManifest.envelope.manifest);
  const hostPrefix = path.posix.join(manifestRoot, "host");
  const files = authority.entries.filter(
    (entry) =>
      entry.type === "file" &&
      (entry.relativePath === hostPrefix || entry.relativePath.startsWith(`${hostPrefix}/`)) &&
      !entry.relativePath.startsWith(`${hostPrefix}/source/`),
  );
  if (files.length === 0 || files.length > HOST_FILE_LIMIT) {
    throw new HarnessProviderBrokerError(
      "Installed provider-broker host runtime exceeds its file boundary",
    );
  }
  let totalBytes = 0;
  const hostFiles: ProviderBrokerHostFile[] = [];
  for (const entry of files) {
    if (entry.stat.size > BigInt(HOST_FILE_BYTES)) {
      throw new HarnessProviderBrokerError(
        "Installed provider-broker host file exceeds its read boundary",
      );
    }
    const bytes = readVerifiedFile(entry, HOST_FILE_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > HOST_TOTAL_BYTES) {
      throw new HarnessProviderBrokerError(
        "Installed provider-broker host runtime exceeds its read boundary",
      );
    }
    hostFiles.push(
      Object.freeze({
        bytes,
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
        relativePath: path.posix.relative(manifestRoot, entry.relativePath),
      }),
    );
  }
  assertTreeAuthority(authority);
  if (!hostFiles.some((file) => file.relativePath === CONTROLLER_PATH)) {
    throw new HarnessProviderBrokerError(
      `Installed harness package does not contain ${CONTROLLER_PATH}`,
    );
  }

  hostFiles.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  const paths = runtimeDirectoryPaths(options);
  ensurePrivateRuntimeDirectory(paths.base);
  ensurePrivateRuntimeDirectory(paths.shard);
  ensurePrivateRuntimeDirectory(paths.staging);
  // Keep the controller path stable after this CLI exits because package-owned
  // brokers bind process ownership to that exact path. The path addresses the
  // canonical host-runtime bytes rather than the whole package receipt, so a
  // package update that leaves those bytes unchanged can inspect and tear down
  // the existing broker. Every caller still revalidates its own exact receipt.
  const runtimeRoot = path.join(paths.shard, digestProviderBrokerHostRuntime(hostFiles));
  const directories = expectedRuntimeDirectories(hostFiles);
  if (runtimePathIsMissing(runtimeRoot)) {
    publishPersistentHostRuntime(runtimeRoot, paths, hostFiles, directories);
  } else {
    try {
      validatePersistentHostRuntime(runtimeRoot, hostFiles, directories);
    } catch (error) {
      throw new HarnessProviderBrokerError(
        "Provider-broker host runtime does not match its exact package receipt",
        { cause: error },
      );
    }
  }
  assertTreeAuthority(authority);
  validatePersistentHostRuntime(runtimeRoot, hostFiles, directories);
  return runtimeRoot;
}

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CREDENTIAL_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CREDENTIAL_VALUE_MAX_BYTES = 64 * 1024;

function hasExactControllerFields(
  result: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const fields = Object.keys(result);
  return fields.length === expected.size && fields.every((field) => expected.has(field));
}

function isBoundedCredentialValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= CREDENTIAL_VALUE_MAX_BYTES
  );
}

function parseControllerResult(
  stdout: string,
  operation: HarnessProviderBrokerControllerRequest["operation"],
): HarnessProviderBrokerControllerResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HarnessProviderBrokerError("Provider-broker controller returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessProviderBrokerError("Provider-broker controller returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (
    result.ok === false &&
    hasExactControllerFields(result, new Set(["message", "ok"])) &&
    typeof result.message === "string" &&
    result.message.length > 0 &&
    result.message.length <= 8192
  ) {
    // The controller receives refresh credentials. Its diagnostic is therefore
    // never safe to propagate across the package-to-core boundary.
    return { ok: false, message: "Provider-broker controller reported a failure" };
  }
  if (
    result.ok !== true ||
    typeof result.providerName !== "string" ||
    !PROVIDER_NAME_PATTERN.test(result.providerName)
  ) {
    throw new HarnessProviderBrokerError("Provider-broker controller returned an invalid result");
  }
  const providerName = result.providerName as string;
  if (
    operation === "inspect-broker" &&
    hasExactControllerFields(
      result,
      new Set(["brokerReady", "ok", "providerName", "sandboxRegistered"]),
    ) &&
    typeof result.brokerReady === "boolean" &&
    typeof result.sandboxRegistered === "boolean" &&
    (!result.sandboxRegistered || result.brokerReady)
  ) {
    return {
      ok: true,
      providerName,
      brokerReady: result.brokerReady,
      sandboxRegistered: result.sandboxRegistered,
    };
  }
  if (
    operation === "teardown-broker" &&
    hasExactControllerFields(result, new Set(["ok", "providerName", "teardownComplete"])) &&
    result.teardownComplete === true
  ) {
    return {
      ok: true,
      providerName,
      teardownComplete: true,
    };
  }
  if (
    operation === "register-refresh-provider" &&
    hasExactControllerFields(
      result,
      new Set(["credentialEnv", "credentialValue", "ok", "providerName"]),
    ) &&
    typeof result.credentialEnv === "string" &&
    CREDENTIAL_ENV_PATTERN.test(result.credentialEnv) &&
    isBoundedCredentialValue(result.credentialValue)
  ) {
    return {
      ok: true,
      providerName,
      credentialEnv: result.credentialEnv,
      credentialValue: result.credentialValue,
    };
  }
  if (
    operation === "ensure-broker" &&
    hasExactControllerFields(result, new Set(["ok", "providerName"]))
  ) {
    return { ok: true, providerName };
  }
  throw new HarnessProviderBrokerError("Provider-broker controller returned an invalid result");
}

export function runHarnessProviderBrokerController(
  identity: HarnessPackageIdentity,
  request: HarnessProviderBrokerControllerRequest,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderBrokerControllerResult {
  const plan = buildHarnessProviderBrokerPlan(
    identity,
    {
      operation: request.operation,
      sandboxName: request.sandboxName,
    },
    options,
  );
  if (plan.kind !== "managed") {
    throw new HarnessProviderBrokerError(plan.reason);
  }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input, "utf8") > CONTROLLER_INPUT_BYTES) {
    throw new HarnessProviderBrokerError("Provider-broker controller input exceeds its boundary");
  }
  const stagedRoot = stageProviderBrokerHost(identity, options);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", path.join(stagedRoot, CONTROLLER_PATH)],
    {
      cwd: stagedRoot,
      encoding: "utf8",
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH ?? "",
        NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN ?? "openshell",
      },
      input,
      maxBuffer: CONTROLLER_OUTPUT_BYTES,
      timeout: CONTROLLER_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") {
    throw new HarnessProviderBrokerError("Provider-broker controller process failed");
  }
  const parsed = parseControllerResult(result.stdout, request.operation);
  if (!parsed.ok) throw new HarnessProviderBrokerError(parsed.message);
  if (parsed.providerName !== plan.providerName) {
    throw new HarnessProviderBrokerError(
      "Provider-broker controller result disagrees with its typed plan",
    );
  }
  if (request.operation === "teardown-broker" && parsed.teardownComplete !== true) {
    throw new HarnessProviderBrokerError(
      "Provider-broker teardown controller did not confirm host cleanup",
    );
  }
  if (request.operation !== "teardown-broker" && parsed.teardownComplete === true) {
    throw new HarnessProviderBrokerError(
      "Provider-broker controller returned a teardown result for a setup operation",
    );
  }
  if (
    request.operation === "inspect-broker" &&
    (parsed.brokerReady === undefined || parsed.sandboxRegistered === undefined)
  ) {
    throw new HarnessProviderBrokerError(
      "Provider-broker inspection controller did not return typed readiness",
    );
  }
  if (
    request.operation !== "inspect-broker" &&
    (parsed.brokerReady !== undefined || parsed.sandboxRegistered !== undefined)
  ) {
    throw new HarnessProviderBrokerError(
      "Provider-broker controller returned inspection state for another operation",
    );
  }
  return parsed;
}

/** Inspect exact package-owned broker readiness without reading or returning credentials. */
export function inspectHarnessProviderBroker(
  identity: HarnessPackageIdentity,
  sandboxName: string,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderBrokerInspectionResult {
  const result = runHarnessProviderBrokerController(
    identity,
    { operation: "inspect-broker", sandboxName },
    options,
  );
  if (!result.ok || result.brokerReady === undefined || result.sandboxRegistered === undefined) {
    throw new HarnessProviderBrokerError(
      "Provider-broker inspection controller did not return typed readiness",
    );
  }
  return result;
}

export function describeHarnessProviderBroker(
  identity: HarnessPackageIdentity,
  sandboxName: string,
  options: HarnessPackageStoreOptions = {},
): string {
  const plan = buildHarnessProviderBrokerPlan(
    identity,
    {
      operation: "describe-provider",
      sandboxName,
    },
    options,
  );
  if (plan.kind !== "managed") throw new HarnessProviderBrokerError(plan.reason);
  return plan.providerName;
}
