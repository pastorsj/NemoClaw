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
  HarnessProviderBrokerOperation,
  HarnessProviderBrokerPlan,
} from "@nvidia/nemoclaw-harness-contract";
import {
  HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT,
  type HarnessProviderBrokerPlanRequest,
} from "./adapter/provider-broker";
import { HarnessAdapterError, loadHarnessAdapter } from "./adapter/loader";
import { readString } from "./manifest-readers";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "./package/store";
import {
  assertTreeAuthority,
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
const STAGING_CACHE = Symbol.for("nemoclaw.provider-broker.staging-cache");

type StagedRuntime = {
  readonly root: string;
  readonly files: readonly (readonly [string, string])[];
};
type StagingCache = Map<string, StagedRuntime>;

export class HarnessProviderBrokerError extends Error {
  override readonly name = "HarnessProviderBrokerError";
}

function stagingCache(): StagingCache {
  const processWithCache = process as NodeJS.Process & { [STAGING_CACHE]?: StagingCache };
  if (processWithCache[STAGING_CACHE]) return processWithCache[STAGING_CACHE];
  const cache: StagingCache = new Map();
  Object.defineProperty(processWithCache, STAGING_CACHE, { value: cache });
  process.once("exit", () => {
    for (const runtime of cache.values()) {
      fs.rmSync(runtime.root, { force: true, recursive: true });
    }
  });
  return cache;
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
  const key = `${identity.id}\0${identity.packageVersion}\0${identity.contentDigest}`;
  const cached = stagingCache().get(key);
  if (cached) {
    try {
      const root = fs.lstatSync(cached.root);
      if (root.isSymbolicLink() || !root.isDirectory() || (root.mode & 0o777) !== 0o700) {
        throw new Error("staging root changed");
      }
      for (const [relative, expectedDigest] of cached.files) {
        const target = path.join(cached.root, ...relative.split("/"));
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o400) {
          throw new Error("staged file changed");
        }
        const bytes = fs.readFileSync(target);
        if (
          bytes.length > HOST_FILE_BYTES ||
          crypto.createHash("sha256").update(bytes).digest("hex") !== expectedDigest
        ) {
          throw new Error("staged file contents changed");
        }
      }
      return cached.root;
    } catch {
      fs.rmSync(cached.root, { force: true, recursive: true });
      stagingCache().delete(key);
    }
  }

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
  const stagedFiles: Array<readonly [string, string]> = [];
  const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-broker-"));
  fs.chmodSync(stagedRoot, 0o700);
  try {
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
      const relative = path.posix.relative(manifestRoot, entry.relativePath);
      const destination = path.join(stagedRoot, ...relative.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o400 });
      stagedFiles.push([
        relative,
        crypto.createHash("sha256").update(bytes).digest("hex"),
      ] as const);
    }
    assertTreeAuthority(authority);
    const controller = path.join(stagedRoot, CONTROLLER_PATH);
    if (!fs.existsSync(controller)) {
      throw new HarnessProviderBrokerError(
        `Installed harness package does not contain ${CONTROLLER_PATH}`,
      );
    }
    stagingCache().set(key, Object.freeze({ root: stagedRoot, files: Object.freeze(stagedFiles) }));
    return stagedRoot;
  } catch (error) {
    fs.rmSync(stagedRoot, { force: true, recursive: true });
    throw error;
  }
}

function parseControllerResult(stdout: string): HarnessProviderBrokerControllerResult {
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
  if (result.ok === false && typeof result.message === "string" && result.message.length <= 8192) {
    return { ok: false, message: result.message };
  }
  if (
    result.ok === true &&
    typeof result.providerName === "string" &&
    result.providerName.length > 0 &&
    result.providerName.length <= 128 &&
    (result.credentialEnv === undefined || typeof result.credentialEnv === "string") &&
    (result.credentialValue === undefined || typeof result.credentialValue === "string")
  ) {
    return {
      ok: true,
      providerName: result.providerName,
      ...(typeof result.credentialEnv === "string" ? { credentialEnv: result.credentialEnv } : {}),
      ...(typeof result.credentialValue === "string"
        ? { credentialValue: result.credentialValue }
        : {}),
    };
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
        NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL ?? "https://portal.nousresearch.com",
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
  const parsed = parseControllerResult(result.stdout);
  if (!parsed.ok) throw new HarnessProviderBrokerError(parsed.message);
  if (parsed.providerName !== plan.providerName) {
    throw new HarnessProviderBrokerError(
      "Provider-broker controller result disagrees with its typed plan",
    );
  }
  return parsed;
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
