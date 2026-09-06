#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Generated from the generic NemoClaw messaging build contract; do not edit by hand.

// scripts/lib/reviewed-npm-archive.mts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
var NPM_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;
var EXACT_NPM_PACKAGE_SPEC =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
function runNpm(args, request) {
  const result = spawnSync(request.npmExecutable ?? "npm", args, {
    encoding: "utf-8",
    env: request.env,
    maxBuffer: NPM_OUTPUT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${request.label} npm ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}
function requireReviewedRequest(request) {
  if (!EXACT_NPM_PACKAGE_SPEC.test(request.packageSpec)) {
    throw new Error(`${request.label} must use an exact npm package spec: ${request.packageSpec}`);
  }
  if (!request.expectedIntegrity.startsWith("sha512-")) {
    throw new Error(`${request.label} must use a committed sha512 npm integrity value`);
  }
  if (!request.tarballUrl) {
    throw new Error(`${request.label} must use a committed npm tarball URL`);
  }
}
function readReviewedNpmArchiveFile(request) {
  if (!isAbsolute(request.archivePath)) {
    throw new Error(`${request.label} archive path must be absolute`);
  }
  let descriptor;
  try {
    const archivePath = resolve(request.archivePath);
    descriptor = openSync(archivePath, "r");
    const opened = fstatSync(descriptor);
    const pathEntry = lstatSync(archivePath);
    if (
      !opened.isFile() ||
      !pathEntry.isFile() ||
      pathEntry.isSymbolicLink() ||
      opened.dev !== pathEntry.dev ||
      opened.ino !== pathEntry.ino
    ) {
      throw new Error("archive must be a non-symlink regular file");
    }
    if (request.maximumBytes !== void 0 && opened.size > request.maximumBytes) {
      throw new Error("archive must be a bounded regular file");
    }
    const archive = readFileSync(descriptor);
    const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (actualIntegrity !== request.expectedIntegrity) {
      throw new Error(
        `${request.label} archive integrity mismatch
Expected: ${request.expectedIntegrity}
Actual:   ${actualIntegrity}`,
      );
    }
    return archive;
  } catch (error) {
    throw new Error(`${request.label} archive is unreadable: ${String(error)}`);
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
  }
}
function verifyReviewedNpmMetadata(request, npmRunner = runNpm) {
  requireReviewedRequest(request);
  const integrity = npmRunner(["view", request.packageSpec, "dist.integrity"], request).trim();
  if (integrity !== request.expectedIntegrity) {
    throw new Error(
      `${request.label} npm integrity mismatch
Expected: ${request.expectedIntegrity}
Actual:   ${integrity}`,
    );
  }
  const tarballUrl = npmRunner(["view", request.packageSpec, "dist.tarball"], request).trim();
  if (tarballUrl !== request.tarballUrl) {
    throw new Error(
      `${request.label} npm tarball URL mismatch
Expected: ${request.tarballUrl}
Actual:   ${tarballUrl}`,
    );
  }
  return { integrity, tarballUrl };
}
function resolveReviewedNpmArchivePath(packageSpec, rootDirectory, filename) {
  if (
    !filename ||
    isAbsolute(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new Error(`npm pack ${packageSpec} reported unsafe archive filename: ${filename}`);
  }
  const root = resolve(rootDirectory);
  const archivePath = resolve(root, filename);
  if (!archivePath.startsWith(`${root}${sep}`)) {
    throw new Error(
      `npm pack ${packageSpec} reported archive path outside pack directory: ${filename}`,
    );
  }
  if (!existsSync(archivePath)) {
    throw new Error(`npm pack ${packageSpec} did not create reported archive: ${filename}`);
  }
  const archive = lstatSync(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink()) {
    throw new Error(`npm pack ${packageSpec} reported a non-file archive: ${filename}`);
  }
  return archivePath;
}
function packReviewedNpmArchive(request, npmRunner = runNpm) {
  verifyReviewedNpmMetadata(request, npmRunner);
  const rootDirectory = mkdtempSync(
    join(request.tempDirectory ?? tmpdir(), "nemoclaw-reviewed-npm-pack-"),
  );
  try {
    const packJson = npmRunner(
      ["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"],
      request,
    );
    let parsed;
    try {
      parsed = JSON.parse(packJson);
    } catch (error) {
      throw new Error(`npm pack ${request.packageSpec} did not return JSON: ${String(error)}`);
    }
    const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : void 0;
    const filename =
      typeof entry === "object" && entry !== null && "filename" in entry
        ? String(entry.filename ?? "")
        : "";
    const actualIntegrity =
      typeof entry === "object" && entry !== null && "integrity" in entry
        ? String(entry.integrity ?? "")
        : "";
    if (!filename || !actualIntegrity) {
      throw new Error(`npm pack ${request.packageSpec} did not report filename and integrity`);
    }
    if (actualIntegrity !== request.expectedIntegrity) {
      throw new Error(
        `${request.label} downloaded tarball integrity mismatch
Expected: ${request.expectedIntegrity}
Actual:   ${actualIntegrity}`,
      );
    }
    return {
      archivePath: resolveReviewedNpmArchivePath(request.packageSpec, rootDirectory, filename),
      rootDirectory,
    };
  } catch (error) {
    rmSync(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}
function removeReviewedNpmArchive(archive) {
  rmSync(archive.rootDirectory, { recursive: true, force: true });
}
function normalizeRegistryOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`reviewed npm registry origin is invalid: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`reviewed npm registry must be a credential-free HTTPS origin: ${value}`);
  }
  return parsed.origin;
}
function readReviewedLock(lockfilePath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockfilePath, "utf-8"));
  } catch (error) {
    throw new Error(`reviewed npm lockfile is unreadable: ${String(error)}`);
  }
  if (typeof lock !== "object" || lock === null || Array.isArray(lock)) {
    throw new Error("reviewed npm lockfile must be a JSON object");
  }
  const lockRecord = lock;
  if (lockRecord.lockfileVersion !== 3) {
    throw new Error("reviewed npm lock requires lockfileVersion 3");
  }
  const packages = lockRecord.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new Error("reviewed npm lockfile is missing its packages map");
  }
  return packages;
}
function parseExactPackageSpec(packageSpec) {
  if (!EXACT_NPM_PACKAGE_SPEC.test(packageSpec)) {
    throw new Error(`reviewed npm lock must use an exact npm package spec: ${packageSpec}`);
  }
  const separator = packageSpec.lastIndexOf("@");
  return { name: packageSpec.slice(0, separator), version: packageSpec.slice(separator + 1) };
}
function packageNameFromLockLocation(location) {
  const marker = "node_modules/";
  const nestedMarkerIndex = location.lastIndexOf(`/${marker}`);
  const markerIndex =
    nestedMarkerIndex >= 0 ? nestedMarkerIndex + 1 : location.startsWith(marker) ? 0 : -1;
  const packageName = markerIndex >= 0 ? location.slice(markerIndex + marker.length) : "";
  if (!packageName) {
    throw new Error(`reviewed npm lock has an unsupported package location: ${location}`);
  }
  return packageName;
}
function lockDependencies(record, location) {
  const dependencies = /* @__PURE__ */ new Map();
  for (const [field, optional] of [
    ["dependencies", false],
    ["optionalDependencies", true],
  ]) {
    const value = record[field];
    if (value === void 0) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `reviewed npm lock has an invalid ${field} map: ${location || "root package"}`,
      );
    }
    for (const name of Object.keys(value)) {
      if (!EXACT_NPM_PACKAGE_SPEC.test(`${name}@0.0.0`)) {
        throw new Error(
          `reviewed npm lock has an invalid dependency name: ${location || "root package"}: ${name}`,
        );
      }
      dependencies.set(name, optional);
    }
  }
  const peerDependencies = record.peerDependencies;
  const peerDependenciesMeta = record.peerDependenciesMeta;
  if (
    peerDependenciesMeta !== void 0 &&
    (typeof peerDependenciesMeta !== "object" ||
      peerDependenciesMeta === null ||
      Array.isArray(peerDependenciesMeta))
  ) {
    throw new Error(
      `reviewed npm lock has an invalid peerDependenciesMeta map: ${location || "root package"}`,
    );
  }
  if (peerDependencies !== void 0) {
    if (
      typeof peerDependencies !== "object" ||
      peerDependencies === null ||
      Array.isArray(peerDependencies)
    ) {
      throw new Error(
        `reviewed npm lock has an invalid peerDependencies map: ${location || "root package"}`,
      );
    }
    for (const name of Object.keys(peerDependencies)) {
      if (!EXACT_NPM_PACKAGE_SPEC.test(`${name}@0.0.0`)) {
        throw new Error(
          `reviewed npm lock has an invalid dependency name: ${location || "root package"}: ${name}`,
        );
      }
      const peerMeta = peerDependenciesMeta?.[name];
      if (
        peerMeta !== void 0 &&
        (typeof peerMeta !== "object" || peerMeta === null || Array.isArray(peerMeta))
      ) {
        throw new Error(
          `reviewed npm lock has invalid peer dependency metadata: ${location || "root package"}: ${name}`,
        );
      }
      const optional = peerMeta?.optional === true;
      if (!dependencies.has(name)) dependencies.set(name, optional);
    }
  }
  return [...dependencies].map(([name, optional]) => ({ name, optional }));
}
function assertNotProductionDev(productionLocations, location, record) {
  if (productionLocations?.has(location) && record.dev === true) {
    throw new Error(`reviewed npm lock marks a production dependency as dev: true: ${location}`);
  }
}
function resolveLockDependencyLocation(packages, requesterLocation, dependencyName) {
  let ancestorLocation = requesterLocation;
  while (true) {
    const candidate = ancestorLocation
      ? `${ancestorLocation}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!ancestorLocation) return void 0;
    const parentMarker = ancestorLocation.lastIndexOf("/node_modules/");
    ancestorLocation = parentMarker >= 0 ? ancestorLocation.slice(0, parentMarker) : "";
  }
}
function productionLockLocations(packages) {
  const root = packages[""];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("reviewed npm lock is missing its root package record");
  }
  const reachable = /* @__PURE__ */ new Set();
  const pending = [{ location: "", record: root }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const dependency of lockDependencies(current.record, current.location)) {
      const location = resolveLockDependencyLocation(packages, current.location, dependency.name);
      if (!location) {
        if (dependency.optional) continue;
        throw new Error(
          `reviewed npm lock is missing a production dependency: ${current.location || "root package"}: ${dependency.name}`,
        );
      }
      if (reachable.has(location)) continue;
      const record = packages[location];
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw new Error(`reviewed npm lock has an invalid package record: ${location}`);
      }
      reachable.add(location);
      pending.push({ location, record });
    }
  }
  return reachable;
}
function verifyReviewedLockDigest(lockfilePath, expectedLockSha256, label) {
  if (!/^[0-9a-f]{64}$/.test(expectedLockSha256)) {
    throw new Error(`${label} must use a committed lowercase SHA-256 lock identity`);
  }
  const actualLockSha256 = createHash("sha256").update(readFileSync(lockfilePath)).digest("hex");
  if (actualLockSha256 !== expectedLockSha256) {
    throw new Error(
      `${label} lock SHA-256 mismatch
Expected: ${expectedLockSha256}
Actual:   ${actualLockSha256}`,
    );
  }
}
function readReviewedLockPackages(
  packages,
  lockfilePath,
  registryOrigin,
  omitDev = false,
  allowEmpty = false,
  allowNestedShrinkwrap = false,
  reviewedRegistryPackages = [],
  allowedNestedShrinkwrapPackages = [],
  reviewedPackagesWithoutIntegrity = [],
) {
  const reviewed = [];
  const identities = /* @__PURE__ */ new Map();
  const reviewedRegistryIdentities = /* @__PURE__ */ new Map();
  const allowedNestedShrinkwrapIdentities = new Set(allowedNestedShrinkwrapPackages);
  const reviewedPackagesWithoutIntegrityBySpec = new Map(
    reviewedPackagesWithoutIntegrity.map((reviewed2) => [reviewed2.packageSpec, reviewed2]),
  );
  for (const reviewedPackage of reviewedRegistryPackages) {
    requireReviewedRequest(reviewedPackage);
    let parsedTarball;
    try {
      parsedTarball = new URL(reviewedPackage.tarballUrl);
    } catch {
      throw new Error(`${reviewedPackage.label} must use a valid reviewed npm tarball URL`);
    }
    if (
      parsedTarball.protocol !== "https:" ||
      parsedTarball.username ||
      parsedTarball.password ||
      reviewedRegistryIdentities.has(reviewedPackage.packageSpec)
    ) {
      throw new Error(
        `${reviewedPackage.label} must use one credential-free HTTPS package identity`,
      );
    }
    reviewedRegistryIdentities.set(reviewedPackage.packageSpec, reviewedPackage);
  }
  const productionLocations = omitDev ? productionLockLocations(packages) : void 0;
  for (const [location, value] of Object.entries(packages)) {
    if (location === "") continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`reviewed npm lock has an invalid package record: ${location}`);
    }
    const record = value;
    assertNotProductionDev(productionLocations, location, record);
    if (omitDev && record.dev === true) continue;
    const locationName = packageNameFromLockLocation(location);
    const packageName = typeof record.name === "string" ? record.name : locationName;
    const version = typeof record.version === "string" ? record.version : "";
    const packageSpec = `${packageName}@${version}`;
    if (
      !allowNestedShrinkwrap &&
      Object.prototype.hasOwnProperty.call(record, "hasShrinkwrap") &&
      !allowedNestedShrinkwrapIdentities.has(packageSpec)
    ) {
      throw new Error(
        `reviewed npm lock package must not delegate to nested shrinkwrap: ${location}`,
      );
    }
    const expectedIntegrity = typeof record.integrity === "string" ? record.integrity : "";
    const tarballUrl = typeof record.resolved === "string" ? record.resolved : "";
    const reviewedPackageWithoutIntegrity = reviewedPackagesWithoutIntegrityBySpec.get(packageSpec);
    if (expectedIntegrity) {
      requireReviewedRequest({
        expectedIntegrity,
        label: `locked npm package ${packageSpec}`,
        packageSpec,
        tarballUrl,
      });
    } else if (
      !reviewedPackageWithoutIntegrity ||
      reviewedPackageWithoutIntegrity.tarballUrl !== tarballUrl
    ) {
      throw new Error(
        `locked npm package ${packageSpec} must use a committed sha512 npm integrity value`,
      );
    }
    let parsedTarball;
    try {
      parsedTarball = new URL(tarballUrl);
    } catch {
      throw new Error(`reviewed npm lock has an invalid tarball URL: ${location}`);
    }
    const reviewedRegistryIdentity = reviewedRegistryIdentities.get(packageSpec);
    if (reviewedRegistryIdentity) {
      if (
        reviewedRegistryIdentity.expectedIntegrity !== expectedIntegrity ||
        reviewedRegistryIdentity.tarballUrl !== tarballUrl ||
        parsedTarball.username ||
        parsedTarball.password
      ) {
        throw new Error(
          `reviewed npm lock package does not match its approved registry identity: ${location}`,
        );
      }
    } else if (
      parsedTarball.origin !== registryOrigin ||
      parsedTarball.username ||
      parsedTarball.password
    ) {
      throw new Error(`reviewed npm lock package must use the reviewed registry: ${location}`);
    }
    const prior = identities.get(packageSpec);
    if (prior) {
      if (prior.expectedIntegrity !== expectedIntegrity || prior.tarballUrl !== tarballUrl) {
        throw new Error(`reviewed npm lock has conflicting package identity: ${packageSpec}`);
      }
      continue;
    }
    const request = {
      expectedIntegrity,
      label: `locked npm package ${packageSpec}`,
      packageSpec,
      tarballUrl,
    };
    identities.set(packageSpec, request);
    if (!reviewedPackageWithoutIntegrity) reviewed.push(request);
  }
  if (!allowEmpty && reviewed.length === 0) {
    throw new Error(`reviewed npm lock contains no packages: ${lockfilePath}`);
  }
  return reviewed;
}
function verifyReviewedNpmLockPackages(request) {
  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  return readReviewedLockPackages(
    readReviewedLock(request.lockfilePath),
    request.lockfilePath,
    registryOrigin,
    request.omitDev,
    true,
    request.allowNestedShrinkwrap,
    request.reviewedRegistryPackages,
    request.allowedNestedShrinkwrapPackages,
    request.reviewedPackagesWithoutIntegrity,
  ).map(({ packageSpec }) => packageSpec);
}
function verifyReviewedNpmLock(request, npmRunner = runNpm) {
  requireReviewedRequest(request);
  verifyReviewedLockDigest(request.lockfilePath, request.expectedLockSha256, request.label);
  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  const packages = readReviewedLock(request.lockfilePath);
  const { name, version } = parseExactPackageSpec(request.packageSpec);
  const root = packages[""];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("reviewed npm lock is missing its root package record");
  }
  const rootDependencies = root.dependencies;
  const rootOptionalDependencies = root.optionalDependencies;
  if (
    typeof rootDependencies !== "object" ||
    rootDependencies === null ||
    Array.isArray(rootDependencies) ||
    Object.keys(rootDependencies).length !== 1 ||
    rootDependencies[name] !== version ||
    (rootOptionalDependencies !== void 0 &&
      (typeof rootOptionalDependencies !== "object" ||
        rootOptionalDependencies === null ||
        Array.isArray(rootOptionalDependencies) ||
        Object.keys(rootOptionalDependencies).length > 0))
  ) {
    throw new Error(`reviewed npm lock root must depend only on ${request.packageSpec}`);
  }
  const topLevel = packages[`node_modules/${name}`];
  if (!topLevel || typeof topLevel !== "object" || Array.isArray(topLevel)) {
    throw new Error(`reviewed npm lock is missing ${request.packageSpec}`);
  }
  if (topLevel.version !== version) {
    throw new Error(
      `reviewed npm lock version mismatch for ${name}: expected ${version}, found ${String(topLevel.version ?? "missing")}`,
    );
  }
  if (topLevel.integrity !== request.expectedIntegrity) {
    throw new Error(`reviewed npm lock integrity mismatch for ${request.packageSpec}`);
  }
  if (topLevel.resolved !== request.tarballUrl) {
    throw new Error(`reviewed npm lock tarball URL mismatch for ${request.packageSpec}`);
  }
  if (Object.prototype.hasOwnProperty.call(topLevel, "hasShrinkwrap")) {
    throw new Error(
      `reviewed npm lock must be authoritative for ${request.packageSpec}; nested shrinkwrap delegation is not allowed`,
    );
  }
  const reviewed = readReviewedLockPackages(packages, request.lockfilePath, registryOrigin);
  verifyReviewedNpmMetadata(request, npmRunner);
  return reviewed.map(({ packageSpec }) => packageSpec);
}
function verifyInstalledNpmLock(request) {
  verifyReviewedLockDigest(request.lockfilePath, request.expectedLockSha256, request.label);
  const packages = readReviewedLock(request.lockfilePath);
  const installRoot = resolve(request.installRoot);
  const nodeModulesRoot = resolve(installRoot, "node_modules");
  const verified = [];
  const productionLocations = request.omitDev ? productionLockLocations(packages) : void 0;
  for (const [location, record] of Object.entries(packages)) {
    if (location === "") continue;
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`${request.label} has an invalid locked package record: ${location}`);
    }
    assertNotProductionDev(productionLocations, location, record);
    if (request.omitDev && record.dev === true) continue;
    const locationName = packageNameFromLockLocation(location);
    const expectedName = typeof record.name === "string" ? record.name : locationName;
    const expectedVersion = typeof record.version === "string" ? record.version : "";
    const packageSpec = `${expectedName}@${expectedVersion}`;
    if (!EXACT_NPM_PACKAGE_SPEC.test(packageSpec)) {
      throw new Error(`${request.label} has an invalid locked package identity: ${packageSpec}`);
    }
    const packageDirectory = resolve(installRoot, location);
    if (!packageDirectory.startsWith(`${nodeModulesRoot}${sep}`)) {
      throw new Error(`${request.label} has an unsafe installed package path: ${location}`);
    }
    let packageEntry;
    try {
      packageEntry = lstatSync(packageDirectory);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (record.optional === true) continue;
        throw new Error(`${request.label} is missing installed package: ${packageSpec}`);
      }
      throw error;
    }
    if (!packageEntry.isDirectory() || packageEntry.isSymbolicLink()) {
      throw new Error(
        `${request.label} installed package must be a non-symlink directory: ${location}`,
      );
    }
    const manifestPath = join(packageDirectory, "package.json");
    let manifest;
    let manifestDescriptor;
    try {
      manifestDescriptor = openSync(manifestPath, "r");
      const openedManifestEntry = fstatSync(manifestDescriptor);
      const pathManifestEntry = lstatSync(manifestPath);
      if (
        !openedManifestEntry.isFile() ||
        !pathManifestEntry.isFile() ||
        pathManifestEntry.isSymbolicLink() ||
        openedManifestEntry.dev !== pathManifestEntry.dev ||
        openedManifestEntry.ino !== pathManifestEntry.ino
      ) {
        throw new Error("manifest must be a non-symlink regular file");
      }
      manifest = JSON.parse(readFileSync(manifestDescriptor, "utf-8"));
    } catch (error) {
      throw new Error(
        `${request.label} installed package manifest is unreadable: ${location}: ${String(error)}`,
      );
    } finally {
      if (manifestDescriptor !== void 0) closeSync(manifestDescriptor);
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error(`${request.label} installed package manifest is invalid: ${location}`);
    }
    const installed = manifest;
    if (installed.name !== expectedName || installed.version !== expectedVersion) {
      throw new Error(
        `${request.label} installed package identity mismatch at ${location}: expected ${packageSpec}, found ${String(installed.name ?? "missing")}@${String(installed.version ?? "missing")}`,
      );
    }
    verified.push(packageSpec);
  }
  return verified;
}
function verifyReviewedNpmCache(request, npmRunner = runNpm) {
  if (!isAbsolute(request.cacheDirectory)) {
    throw new Error(`reviewed npm cache path must be absolute: ${request.cacheDirectory}`);
  }
  const cacheDirectory = resolve(request.cacheDirectory);
  if (!existsSync(cacheDirectory)) {
    throw new Error(`reviewed npm cache does not exist: ${cacheDirectory}`);
  }
  const cache = lstatSync(cacheDirectory);
  if (!cache.isDirectory() || cache.isSymbolicLink()) {
    throw new Error(`reviewed npm cache must be a non-symlink directory: ${cacheDirectory}`);
  }
  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  const packages = readReviewedLockPackages(
    readReviewedLock(request.lockfilePath),
    request.lockfilePath,
    registryOrigin,
  );
  const env = {
    ...process.env,
    ...request.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_REGISTRY: `${registryOrigin}/`,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
  const verified = [];
  for (const reviewed of packages) {
    const archive = packReviewedNpmArchive(
      {
        ...reviewed,
        env,
        npmExecutable: request.npmExecutable,
        tempDirectory: request.tempDirectory,
      },
      npmRunner,
    );
    removeReviewedNpmArchive(archive);
    verified.push(reviewed.packageSpec);
  }
  return verified;
}
function parseCliOptions(argv) {
  const values = /* @__PURE__ */ new Map();
  let verifyOnly = false;
  let verifyLock = false;
  let verifyInstalledLock = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (arg === "--verify-lock") {
      verifyLock = true;
      continue;
    }
    if (arg === "--verify-installed-lock") {
      verifyInstalledLock = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`Unknown argument: ${arg ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  if (values.has("--cache")) {
    if (
      verifyOnly ||
      verifyLock ||
      verifyInstalledLock ||
      values.has("--package-spec") ||
      values.has("--integrity") ||
      values.has("--tarball-url") ||
      values.has("--label")
    ) {
      throw new Error("reviewed npm cache verification cannot be combined with archive options");
    }
    return {
      cacheDirectory: required("--cache"),
      lockfilePath: required("--lockfile"),
      mode: "cache",
      npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
      registryOrigin: required("--registry-origin"),
      tempDirectory: values.get("--temp-directory"),
    };
  }
  if (verifyInstalledLock) {
    if (verifyOnly || verifyLock || values.has("--cache") || values.has("--registry-origin")) {
      throw new Error("installed npm lock verification cannot be combined with other modes");
    }
    return {
      expectedLockSha256: required("--lock-sha256"),
      installRoot: required("--install-root"),
      label: required("--label"),
      lockfilePath: required("--lockfile"),
      mode: "installed-lock",
    };
  }
  if (verifyLock) {
    if (verifyOnly || values.has("--cache")) {
      throw new Error("reviewed npm lock verification cannot be combined with other modes");
    }
    return {
      expectedIntegrity: required("--integrity"),
      expectedLockSha256: required("--lock-sha256"),
      label: required("--label"),
      lockfilePath: required("--lockfile"),
      mode: "lock",
      npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
      packageSpec: required("--package-spec"),
      registryOrigin: required("--registry-origin"),
      tarballUrl: required("--tarball-url"),
      tempDirectory: values.get("--temp-directory"),
    };
  }
  if (values.has("--lockfile") || values.has("--registry-origin") || values.has("--install-root")) {
    throw new Error(
      "--lockfile, --registry-origin, and --install-root require a matching lock mode",
    );
  }
  return {
    expectedIntegrity: required("--integrity"),
    label: required("--label"),
    mode: "archive",
    npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
    packageSpec: required("--package-spec"),
    tarballUrl: required("--tarball-url"),
    tempDirectory: values.get("--temp-directory"),
    verifyOnly,
  };
}
function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}
if (isMainModule()) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options.mode === "cache") {
      const verified = verifyReviewedNpmCache(options);
      process.stdout.write(`Verified ${verified.length} locked npm cache archives
`);
    } else if (options.mode === "installed-lock") {
      const verified = verifyInstalledNpmLock(options);
      process.stdout.write(`Verified ${verified.length} installed npm package identities
`);
    } else if (options.mode === "lock") {
      const verified = verifyReviewedNpmLock(options);
      process.stdout.write(`Verified ${verified.length} locked npm packages
`);
    } else if (options.verifyOnly) {
      verifyReviewedNpmMetadata(options);
    } else {
      process.stdout.write(`${packReviewedNpmArchive(options).archivePath}
`);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// src/lib/messaging/manifest/registry.ts
var ChannelManifestRegistry = class {
  manifests = /* @__PURE__ */ new Map();
  constructor(manifests = []) {
    for (const manifest of manifests) {
      this.register(manifest);
    }
  }
  register(manifest) {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Duplicate channel manifest id '${manifest.id}'`);
    }
    this.manifests.set(manifest.id, manifest);
    return this;
  }
  get(channelId) {
    return this.manifests.get(channelId);
  }
  list() {
    return Array.from(this.manifests.values());
  }
  listAvailable(ctx = {}) {
    const supportedChannelIds = Array.isArray(ctx.supportedChannelIds)
      ? new Set(ctx.supportedChannelIds)
      : null;
    return this.list().filter((manifest) => {
      if (ctx.agent && !manifest.supportedAgents.includes(ctx.agent)) {
        return false;
      }
      if (supportedChannelIds && !supportedChannelIds.has(manifest.id)) {
        return false;
      }
      return true;
    });
  }
};
function createChannelManifestRegistry(manifests = []) {
  return new ChannelManifestRegistry(manifests);
}

// src/lib/messaging/channels/discord/manifest.ts
var discordManifest = {
  schemaVersion: 1,
  id: "discord",
  displayName: "Discord",
  description: "Discord bot messaging",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "DISCORD_BOT_TOKEN",
      prompt: {
        label: "Discord Bot Token",
        help: "Discord Developer Portal \u2192 Applications \u2192 Bot \u2192 Reset/Copy Token.",
      },
    },
    {
      id: "serverId",
      kind: "config",
      required: false,
      envKey: "DISCORD_SERVER_ID",
      statePath: "discordGuilds.serverId",
      prompt: {
        label: "Discord Server ID (for guild workspace access)",
        help: "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
        emptyValueMessage: "guild channels stay disabled",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "DISCORD_REQUIRE_MENTION",
      statePath: "discordGuilds.requireMention",
      promptWhenInput: "serverId",
      validValues: ["0", "1"],
      defaultValue: "1",
      prompt: {
        label: "Discord mention mode",
        help: "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
      },
    },
    {
      id: "userId",
      kind: "config",
      required: false,
      envKey: "DISCORD_USER_ID",
      statePath: "discordGuilds.userIds",
      promptWhenInput: "serverId",
      prompt: {
        label: "Discord User ID (optional guild allowlist)",
        help: "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
        emptyValueMessage: "any member in the configured server can message the bot",
      },
    },
  ],
  credentials: [
    {
      id: "discordBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-discord-bridge",
      providerEnvKey: "DISCORD_BOT_TOKEN",
      placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    },
  ],
  policyPresets: [
    {
      name: "discord",
      // The Discord policy owns the credential binding that sets
      // DISCORD_BOT_TOKEN to a revision-scoped placeholder. The sandbox process
      // reads that environment at boot, so applying this preset afterwards is too late.
      requiredAtCreate: true,
      validationWarningLines: [
        "For Discord preset validation, do not use curl as the success signal:",
        "curl is not in the preset binary allowlist, so curl probes can fail even",
        "when the policy is working. Validate the configured messaging bridge/gateway path.",
        'DNS-only checks such as dns.resolve("gateway.discord.gg")',
        "can also be inconclusive behind a proxy.",
        "The agent-specific gateway probe prints an HTTP status when it reaches Discord.",
        "Any HTTP response confirms reachability. A transport error or OpenShell policy",
        "denial means validation failed.",
      ],
      validationWarningLinesByAgent: {
        openclaw: [
          "OpenClaw validation uses its Node runtime:",
          `node -e "require('node:https').get('https://discord.com/api/v10/gateway',r=>console.log(r.statusCode)).on('error',e=>{console.error(e.message);process.exitCode=1})"`,
        ],
        hermes: [
          "Hermes validation uses its virtual-environment Python runtime:",
          `nemohermes <name> exec -- /opt/hermes/.venv/bin/python -c "import urllib.error, urllib.request; u='https://discord.com/api/v10/gateway';
try: print(urllib.request.urlopen(u, timeout=20).status)
except urllib.error.HTTPError as error: print(error.code)"`,
        ],
      },
    },
  ],
  render: [
    {
      id: "discord-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.discord",
        value: {
          enabled: true,
          accounts: {
            default: {
              // OpenShell sets DISCORD_BOT_TOKEN to the current revision-scoped
              // placeholder. Persisting the canonical placeholder here shadows
              // that process value and is rejected by the credential endpoint.
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              proxy: "{{discordProxyUrl}}",
              dmPolicy: "{{discord.allowedUsers.dmPolicy}}",
              allowFrom: "{{discord.allowedUsers.values}}",
            },
          },
        },
      },
    },
    {
      id: "discord-openclaw-guilds",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      when: "{{discord.hasGuilds}}",
      fragment: {
        path: "channels.discord",
        value: {
          groupPolicy: "allowlist",
          guilds: "{{discord.guilds}}",
        },
      },
    },
    {
      id: "discord-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.discord",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "discord-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "NEMOCLAW_DISCORD_GUILD_IDS={{discord.guildIds.csv}}",
        "DISCORD_ALLOWED_USERS={{discord.allowedUsers.csv}}",
        "DISCORD_ALLOW_ALL_USERS={{discord.allowAllUsers}}",
      ],
    },
    {
      id: "discord-hermes-config",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "discord",
        value: {
          require_mention: "{{discord.requireMention}}",
          free_response_channels: "",
          allowed_channels: "",
          auto_thread: true,
          reactions: true,
          channel_prompts: {},
        },
      },
    },
    {
      id: "discord-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.discord",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "discord",
      visibility: {
        configKeys: ["discord"],
        logPatterns: ["discord"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@openclaw/discord@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      id: "discord-openclaw-bridge-health",
      phase: "health-check",
      handler: "discord.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "discord-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "discord-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "serverId",
          kind: "config",
        },
        {
          id: "requireMention",
          kind: "config",
        },
        {
          id: "userId",
          kind: "config",
        },
      ],
    },
  ],
};

// src/lib/messaging/channels/googlechat/manifest.ts
var googlechatManifest = {
  schemaVersion: 1,
  id: "googlechat",
  displayName: "Google Chat",
  description: "Google Chat (Chat API) bot messaging (experimental)",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "serviceAccount",
      kind: "secret",
      required: true,
      envKey: "GOOGLECHAT_SERVICE_ACCOUNT",
      // Cap the mask — a ~2 KB SA JSON would otherwise echo thousands of stars.
      maskCap: 40,
      // Validate the paste now (token-paste hook re-prompts, then skips the
      // channel) so a bad key never reaches token-minting and aborts onboarding.
      // The googlechat.tokenPaste hook parses the paste as JSON; a truncated or
      // malformed paste is re-prompted here instead of failing later at minting.
      formatHint:
        "Paste the entire service-account JSON key on one line (minified) \u2014 the whole downloaded JSON file.",
      // Re-prompt on a bad paste — an SA JSON is long and easy to truncate.
      maxTokenAttempts: 3,
      prompt: {
        label: "Google Chat service account JSON",
        help: [
          "\u2503  GOOGLE CHAT \u2014 service account key",
          "\u2503",
          "\u2503  Google Cloud Console \u2192 IAM & Admin \u2192 Service Accounts",
          "\u2503    \u2192 your bot's SA \u2192 Keys \u2192 Add key \u2192 Create new key \u2192 JSON",
          "\u2503",
          "\u2503  A .json file downloads. Paste its contents below as ONE line (minified).",
          "",
        ].join("\n"),
      },
    },
    {
      id: "audienceType",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE_TYPE",
      statePath: "googlechatConfig.audienceType",
      validValues: ["app-url", "project-number"],
      defaultValue: "app-url",
    },
    {
      id: "audience",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE",
      statePath: "googlechatConfig.audience",
      prompt: {
        label: "Google Chat webhook audience",
        help: "Usually filled automatically from the public tunnel URL. For audienceType 'project-number', enter your GCP project number instead.",
        emptyValueMessage: "inbound webhook verification will be unconfigured",
      },
    },
    {
      id: "appPrincipal",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_APP_PRINCIPAL",
      statePath: "googlechatConfig.appPrincipal",
      formatPattern: "^[0-9]{6,32}$",
      formatHint:
        "appPrincipal is the add-on's numeric OAuth client ID (uniqueId, ~21 digits), not an email.",
      prompt: {
        label: "Google Chat appPrincipal",
        help: [
          "  Workspace account   \u2192 leave blank, done.",
          "  Personal Gmail      \u2192 needs the add-on's ~21-digit ID (not an email), stable across rebuilds.",
          "",
          "  If you already know it, paste it at the prompt and you're done.",
          "  If not, leave it blank \u2014 the first DM reveals it once the sandbox is live:",
          "",
          "    1.  Watch the gateway log:",
          '          nemoclaw <sandbox> logs --follow | grep "unexpected add-on principal"',
          "    2.  DM the bot once \u2014 it won't reply yet, that's expected. The log prints:",
          "          unexpected add-on principal: <N>",
          "    3.  Save that <N> and rebuild:",
          "          GOOGLECHAT_APP_PRINCIPAL=<N> nemoclaw <sandbox> channels add googlechat",
          "          nemoclaw <sandbox> rebuild --yes",
        ].join("\n"),
        emptyValueMessage: "Workspace accounts do not need it; personal accounts must set it later",
      },
    },
    {
      id: "allowFrom",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_ALLOWED_USERS",
      statePath: "allowedIds.googlechat",
      prompt: {
        label: "Google Chat DM allowlist (comma-separated)",
        help: [
          "Optional: restrict who can DM the bot.",
          "    OpenClaw:  users/NNN   (emails ignored)",
          "    Hermes:    email       (users/NNN ignored)",
          "    Blank:     pairing mode (recommended) \u2014 OpenClaw's pairing reply shows your users/NNN",
          "  Filling this switches DM policy to allowlist \u2014 a wrong-form entry is dropped silently, with no pairing code.",
        ].join("\n"),
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    // ── Hermes-only Pub/Sub pull config ──
    // Hermes supports a webhook too, but NemoClaw pulls instead, so it needs the
    // project and subscription. OpenClaw ignores both. Rendered only into
    // ~/.hermes/.env.
    {
      id: "projectId",
      kind: "config",
      required: false,
      envKey: "GOOGLE_CHAT_PROJECT_ID",
      statePath: "googlechatConfig.projectId",
      prompt: {
        label: "Google Chat GCP project ID (Hermes Pub/Sub pull)",
        help: "The Google Cloud project that owns the Pub/Sub subscription Hermes pulls Chat events from. OpenClaw ignores this.",
        emptyValueMessage: "required for the Hermes Google Chat channel",
      },
    },
    {
      id: "subscriptionName",
      kind: "config",
      required: false,
      envKey: "GOOGLE_CHAT_SUBSCRIPTION_NAME",
      statePath: "googlechatConfig.subscriptionName",
      prompt: {
        label: "Google Chat Pub/Sub subscription (projects/<p>/subscriptions/<s>)",
        help: [
          "The pull subscription bound to the Chat events topic. Hermes pulls from it over the Pub/Sub REST API; the gateway-minted token is scoped to both chat.bot and pubsub.",
          "    Its topic must grant roles/pubsub.publisher to the app's push account:",
          "      Interactive features   service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
          "      Classic bot            chat-api-push@system.gserviceaccount.com",
          "      Shown at               Chat API \u2192 Configuration \u2192 Connection settings",
          "      Missing it             channel connects, no event arrives, Chat says the bot is not responding",
        ].join("\n"),
        emptyValueMessage: "required for the Hermes Google Chat channel",
      },
    },
  ],
  // Outbound auth is gateway-minted: the OpenShell `google-service-account-jwt`
  // refresh provider mints the Google Chat bot token from the pasted service
  // account, and the L7 proxy injects it as `Authorization: Bearer` on
  // chat.googleapis.com. The service-account private key stays gateway-side and
  // never enters the sandbox. The bridge provider + refresh are wired in
  // src/lib/onboard/messaging-bridge-provider.ts; the googlechat-outbound-auth
  // runtime preload makes the plugin send the injected bearer instead of signing
  // in-process. No credentials/secretFiles here — the pasted serviceAccount is
  // consumed only as gateway-side refresh material, never delivered into the sandbox.
  // (The `serviceAccountFile` in `render` below is a start-gate marker only, not a
  // delivered file — see the comment there.)
  // On `channels remove` this gateway-side material is torn down by
  // applyChannelRemoveToGatewayAndRegistry via bridgeProviderNamesForChannel (which
  // deletes the bridge provider from the gateway), not by clearChannelTokens — that
  // clears only per-channel sandbox tokens and is intentionally a no-op for a bridge
  // channel, so an empty `credentials` does not leave the service account behind.
  credentials: [],
  policyPresets: [
    {
      name: "googlechat",
      policyKeys: ["googlechat"],
      // Pub/Sub REST pull + Chat REST reply is a different egress shape from
      // OpenClaw's inbound webhook, so it resolves its own policy key.
      agentPolicyKeys: {
        hermes: ["googlechat_hermes"],
      },
    },
  ],
  render: [
    {
      id: "googlechat-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.googlechat",
        value: {
          enabled: true,
          // Start-gate SENTINEL — a deliberately synthetic, non-existent path, NOT a
          // real credential location. OpenClaw's channel-start gate only requires some
          // serviceAccount* to be set (isConfigured: credentialSource !== "none") to
          // start the webhook; it accepts any non-empty string here and does not read
          // the file at start. The token is gateway-minted and proxy-injected, and the
          // googlechat-outbound-auth preload short-circuits the token producer before
          // this path could be read, so no service-account key is ever delivered into
          // the sandbox. (Clean fix is upstream: a non-SA "configured"/accessToken
          // credential source in @openclaw/googlechat — tracked follow-up.)
          serviceAccountFile: "/nonexistent/googlechat-gateway-minted-no-service-account-file",
          audienceType: "{{googlechatConfig.audienceType}}",
          audience: "{{googlechatConfig.audience}}",
          appPrincipal: "{{googlechatConfig.appPrincipal}}",
          webhookPath: "/googlechat",
          healthMonitor: {
            enabled: false,
          },
          dm: {
            policy: "{{allowedIds.googlechat.dmPolicy}}",
            allowFrom: "{{allowedIds.googlechat.values}}",
          },
        },
      },
    },
    {
      id: "googlechat-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.googlechat",
        value: {
          enabled: true,
        },
      },
    },
    {
      // ── Workaround Analysis ──
      // 1. What:  render gateway.reload.mode=off into the sandbox's openclaw.json.
      // 2. Why:   ~60s after boot OpenClaw rewrites its OWN config (adds default
      //           provider-plugin entries); with hot-reload ON it reloads plugins,
      //           rebuilds the HTTP route table and DROPS the Google Chat webhook
      //           route → inbound 404s, bot goes silent ~60s after every start.
      // 3. Alts:  none in-sandbox — the self-write is OpenClaw's; a periodic restart
      //           only resets the timer. Real fix is upstream (5).
      // 4. Risk:  low — the sandbox openclaw.json is build-time-sealed (0600 +
      //           integrity hash), so nothing legitimately reloads it at runtime;
      //           NemoClaw still restarts the gateway explicitly on rebuild/restart.
      // 5. Exit:  upstream reload re-mounts channels (not just plugins) on config
      //           reload → drop this fragment.
      id: "googlechat-openclaw-gateway-reload-off",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "gateway.reload",
        value: {
          mode: "off",
        },
      },
    },
    // ── Hermes render ──
    // Non-secret pull config and the allowlist only: no SA JSON or token reaches
    // the sandbox, which sends the placeholder the L7 proxy swaps.
    {
      id: "googlechat-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "GOOGLE_CHAT_PROJECT_ID={{googlechatConfig.projectId}}",
        "GOOGLE_CHAT_SUBSCRIPTION_NAME={{googlechatConfig.subscriptionName}}",
        "GOOGLE_CHAT_ALLOWED_USERS={{allowedIds.googlechat.csv}}",
      ],
    },
    {
      id: "googlechat-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.google_chat",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "googlechat",
      visibility: {
        configKeys: ["googlechat"],
        logPatterns: ["googlechat"],
      },
      // Interim sandbox-DNS workaround: the sandbox netns is DNS-less (all
      // resolution goes through the L7 proxy), but OpenClaw's Google Chat fetches
      // default to STRICT SSRF mode, which does a LOCAL getaddrinfo first and
      // fails with EAI_AGAIN. This boot preload rewrites the plugin's googleapis
      // fetches (inbound cert verify + all outbound sends) to the guard's
      // first-class `trusted_env_proxy` mode, so they skip the local resolve and
      // route by hostname through the L7 proxy (which resolves + enforces policy).
      // No sentinel IP. It replaces the older googlechat-dns-resolve.ts sentinel
      // shim, and is exactly the upstream OpenClaw fix (trusted-env-proxy fetch,
      // like web_fetch openclaw#50650) applied in the plugin bundle; remove once
      // that lands upstream. See runtime/googlechat-trusted-proxy-fetch.ts.
      //
      // Second boot preload: move OUTBOUND auth off the in-sandbox SA key. By
      // default @openclaw/googlechat signs an auth JWT with the SA private key
      // in-process, which forces the key to live in the sandbox. This preload
      // rewrites the plugin's single token producer to return the OpenShell
      // gateway-minted credential placeholder (GOOGLE_CHAT_ACCESS_TOKEN) so the
      // L7 proxy injects the real bearer outbound and the key never enters the
      // sandbox. See runtime/googlechat-outbound-auth.ts.
      nodePreloads: [
        {
          module: "googlechat-trusted-proxy-fetch",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat trusted-proxy-fetch patch (route googleapis via trusted env proxy)",
          installedMessage:
            "[channels] Google Chat trusted-proxy-fetch patch installed (NODE_OPTIONS updated)",
        },
        {
          module: "googlechat-outbound-auth",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat outbound-auth patch (gateway-minted bearer)",
          installedMessage:
            "[channels] Google Chat outbound-auth patch installed (NODE_OPTIONS updated)",
        },
      ],
      secretScans: [
        {
          path: "/sandbox/.openclaw/openclaw.json",
          pattern: "-----BEGIN (?:RSA )?PRIVATE KEY-----",
          message:
            "[SECURITY] Google Chat service account private key leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@openclaw/googlechat@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-Dv0xOmcxAThEr6hoK+ioofHNu18hfbIceQrEHX3AHZPpOUiTJvToVpA5eX87NQINewwfSJf0gVhE6kSbSk2Aew==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.7.1.tgz",
      },
      required: true,
    },
    // The base image ships aiohttp but not the google-* SDKs, which the inherited
    // connect() and reply path both need.
    {
      id: "hermesGooglePubsubPackage",
      agent: "hermes",
      manager: "python-package",
      spec: "google-cloud-pubsub==2.39.0",
      required: true,
    },
    {
      id: "hermesGoogleApiClientPackage",
      agent: "hermes",
      manager: "python-package",
      spec: "google-api-python-client==2.194.0",
      required: true,
    },
    {
      id: "hermesGoogleAuthPackage",
      agent: "hermes",
      manager: "python-package",
      spec: "google-auth==2.55.1",
      required: true,
    },
  ],
  hooks: [
    {
      // OpenClaw-only: gates the inbound webhook audience. Hermes pull mode
      // serves no webhook, and running this gate would skip the channel and drop
      // its policy preset.
      id: "googlechat-tunnel-audience-gate",
      phase: "enroll",
      handler: "googlechat.tunnelAudienceGate",
      agents: ["openclaw"],
      inputs: ["audienceType", "audience"],
      outputs: [
        {
          id: "audience",
          kind: "config",
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-service-account",
      phase: "enroll",
      handler: "googlechat.tokenPaste",
      outputs: [
        {
          id: "serviceAccount",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowFrom",
          kind: "config",
        },
      ],
    },
    {
      // OpenClaw-only: appPrincipal is the add-on's OAuth principal for inbound
      // webhook verification — meaningless to Hermes pull mode.
      id: "googlechat-openclaw-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["openclaw"],
      outputs: [
        {
          id: "appPrincipal",
          kind: "config",
        },
      ],
    },
    {
      // Hermes-only: collect the Pub/Sub project + subscription for pull mode.
      id: "googlechat-hermes-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["hermes"],
      outputs: [
        {
          id: "projectId",
          kind: "config",
        },
        {
          id: "subscriptionName",
          kind: "config",
        },
      ],
    },
  ],
};

// src/lib/messaging/channels/slack/manifest.ts
var slackManifest = {
  schemaVersion: 1,
  id: "slack",
  displayName: "Slack",
  description: "Slack bot messaging",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "SLACK_BOT_TOKEN",
      formatPattern: "^xoxb-[A-Za-z0-9_-]+$",
      formatHint: "Slack bot tokens start with 'xoxb-' (e.g. xoxb-<workspace>-<bot>-<redacted>).",
      prompt: {
        label: "Slack Bot Token",
        help: "Slack API \u2192 Your Apps \u2192 OAuth & Permissions \u2192 Bot User OAuth Token (xoxb-...).",
      },
    },
    {
      id: "appToken",
      kind: "secret",
      required: true,
      envKey: "SLACK_APP_TOKEN",
      formatPattern: "^xapp-[A-Za-z0-9_-]+$",
      formatHint:
        "Slack app tokens start with 'xapp-' (e.g. xapp-<version>-<app-id>-<team-id>-<redacted>).",
      prompt: {
        label: "Slack App Token (Socket Mode)",
        help: "Slack API \u2192 Your Apps \u2192 Basic Information \u2192 App-Level Tokens (xapp-...).",
      },
    },
    {
      id: "allowedUsers",
      kind: "config",
      required: false,
      envKey: "SLACK_ALLOWED_USERS",
      statePath: "allowedIds.slack",
      prompt: {
        label: "Slack Member IDs (comma-separated allowlist)",
        help: "In Slack, open each allowed human user's profile -> More -> Copy member ID. Enter one or more comma-separated member IDs, not the app or bot user ID. Member IDs look like U01ABC2DEF3.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    {
      id: "allowedChannels",
      kind: "config",
      required: false,
      envKey: "SLACK_ALLOWED_CHANNELS",
      statePath: "slackConfig.allowedChannels",
      prompt: {
        label: "Slack Channel IDs (comma-separated allowlist)",
        help: "Optional: enter comma-separated Slack channel IDs where the bot may answer @mentions. Channel IDs look like C012AB3CD.",
        emptyValueMessage: "channel @mentions stay unrestricted by channel ID",
      },
    },
  ],
  credentials: [
    {
      id: "slackBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-slack-bridge",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      primary: true,
    },
    {
      id: "slackAppToken",
      sourceInput: "appToken",
      providerName: "{sandboxName}-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    },
  ],
  policyPresets: [{ name: "slack", requiredAtCreate: true }],
  render: [
    {
      id: "slack-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.slack",
        value: {
          enabled: true,
          accounts: {
            default: {
              // No botToken/appToken here: OpenShell 0.0.106 injects both as
              // revision-scoped placeholders and rejects the provider-shaped
              // alias once the policy binds them. OpenClaw resolves the
              // default account from process.env.SLACK_BOT_TOKEN and
              // SLACK_APP_TOKEN when the config omits them.
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              dmPolicy: "{{allowedIds.slack.dmPolicy}}",
              allowFrom: "{{allowedIds.slack.values}}",
              groupPolicy: "{{allowedIds.slack.groupPolicy}}",
              channels: "{{allowedIds.slack.channels}}",
            },
          },
        },
      },
    },
    {
      id: "slack-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.slack",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "slack-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "SLACK_ALLOWED_USERS={{allowedIds.slack.csv}}",
        "SLACK_ALLOWED_CHANNELS={{slackConfig.allowedChannels.csv}}",
      ],
    },
    {
      id: "slack-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.slack",
        value: {
          enabled: true,
          extra: {
            rich_blocks: true,
          },
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "slack",
      visibility: {
        configKeys: ["slack"],
        logPatterns: ["slack"],
      },
      nodePreloads: [
        {
          module: "slack-channel-guard",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Slack channel guard (unhandled-rejection safety net)",
          installedMessage: "[channels] Slack channel guard installed (NODE_OPTIONS updated)",
        },
      ],
      secretScans: [
        {
          path: "/sandbox/.openclaw/openclaw.json",
          pattern: "(?:xoxb|xapp)-(?!OPENSHELL-RESOLVE-ENV-)",
          message: "[SECURITY] Slack token leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    },
    hermes: {},
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@openclaw/slack@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-dwVGEVCmoTQrOIeZaSCIOPg8pT7hB883QQEXdp9EZUDzTGuvSc+KxH2iERSOV/59hROQctYdcobGn/vdB1H4XA==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      id: "slack-socket-mode-gateway-conflict",
      phase: "pre-enable",
      handler: "slack.socketModeGatewayConflict",
      onFailure: "abort",
    },
    {
      id: "slack-openclaw-bridge-health",
      phase: "health-check",
      handler: "slack.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "slack-socket-mode-gateway-status",
      phase: "status",
      handler: "slack.socketModeGatewayStatus",
      outputs: [
        {
          id: "gatewayOverlaps",
          kind: "status",
        },
      ],
    },
    {
      id: "slack-status-health",
      phase: "status",
      handler: "slack.statusHealth",
      providesReadiness: true,
      agents: ["openclaw"],
      outputs: [
        {
          id: "channelHealth",
          kind: "status",
        },
      ],
    },
    {
      id: "slack-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
        {
          id: "appToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "slack-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "allowedChannels",
          kind: "config",
        },
      ],
    },
    {
      id: "slack-credential-validation",
      phase: "reachability-check",
      handler: "slack.validateCredentials",
      inputs: ["botToken", "appToken"],
      onFailure: "skip-channel",
    },
  ],
};

// src/lib/messaging/channels/teams/contract.ts
var TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT = {
  channelId: "teams",
  renderId: "teams-openclaw-channel",
  hookId: "teams-openclaw-channel",
  handlerId: "common.staticOutputs",
  kind: "json-fragment",
  agent: "openclaw",
  target: "openclaw.json",
  configPath: "channels.msteams",
  webhookPath: "/api/messages",
};
function authorizeTeamsOpenClawWebhookField(entry) {
  if (!isPlainDataObject(entry)) return [];
  const contract = TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT;
  if (
    ownDataPropertyValue(entry, "channelId") !== contract.channelId ||
    ownDataPropertyValue(entry, "renderId") !== contract.renderId ||
    ownDataPropertyValue(entry, "hookId") !== contract.hookId ||
    ownDataPropertyValue(entry, "handler") !== contract.handlerId ||
    ownDataPropertyValue(entry, "kind") !== contract.kind ||
    ownDataPropertyValue(entry, "agent") !== contract.agent ||
    ownDataPropertyValue(entry, "target") !== contract.target ||
    ownDataPropertyValue(entry, "path") !== contract.configPath
  ) {
    return [];
  }
  const value = ownDataPropertyValue(entry, "value");
  if (!isPlainDataObject(value)) return [];
  const webhook = ownDataPropertyValue(value, "webhook");
  if (
    !isPlainDataObject(webhook) ||
    !hasExactlyOwnDataProperties(webhook, ["path", "port"]) ||
    !isTcpPort(ownDataPropertyValue(webhook, "port")) ||
    ownDataPropertyValue(webhook, "path") !== contract.webhookPath
  ) {
    return [];
  }
  return [{ path: ["value", "webhook"], value: webhook }];
}
function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownDataPropertyValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : void 0;
}
function hasExactlyOwnDataProperties(value, expected) {
  const actual = Object.getOwnPropertyNames(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isTcpPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

// src/lib/messaging/channels/teams/manifest.ts
var teamsManifest = {
  schemaVersion: 1,
  id: "teams",
  displayName: "Microsoft Teams",
  description: "Microsoft Teams bot messaging (experimental)",
  enrollmentNotes: [
    "Microsoft Teams requires a public HTTPS webhook endpoint at /api/messages; expose the configured Teams webhook port before installing the Teams app.",
    "Use Azure AD object IDs in TEAMS_ALLOWED_USERS so only authorized users can interact with the bot.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "appId",
      kind: "config",
      required: true,
      envKey: "MSTEAMS_APP_ID",
      statePath: "teamsConfig.appId",
      prompt: {
        label: "Microsoft Teams Client ID",
        help: "Run `teams app create --endpoint https://<public-url>/api/messages`, then copy CLIENT_ID.",
      },
    },
    {
      id: "clientSecret",
      kind: "secret",
      required: true,
      envKey: "MSTEAMS_APP_PASSWORD",
      prompt: {
        label: "Microsoft Teams Client Secret",
        help: "Use the CLIENT_SECRET printed by `teams app create`. It is shown once; rotate it in Entra ID if it was lost.",
      },
    },
    {
      id: "tenantId",
      kind: "config",
      required: true,
      envKey: "MSTEAMS_TENANT_ID",
      statePath: "teamsConfig.tenantId",
      prompt: {
        label: "Microsoft Teams Tenant ID",
        help: "Use the TENANT_ID printed by `teams app create` or shown by `teams status --verbose`.",
      },
    },
    {
      id: "allowedUsers",
      kind: "config",
      required: false,
      envKey: "TEAMS_ALLOWED_USERS",
      statePath: "allowedIds.teams",
      prompt: {
        label: "Microsoft Teams AAD Object IDs (comma-separated allowlist)",
        help: "Recommended: run `teams status --verbose` and enter the Azure AD object IDs allowed to use the bot.",
      },
    },
    {
      id: "webhookPort",
      kind: "config",
      required: false,
      envKey: "MSTEAMS_PORT",
      statePath: "teamsConfig.webhookPort",
      defaultValue: "3978",
      prompt: {
        label: "Microsoft Teams webhook port",
        help: "Local bot webhook port to expose publicly. Defaults to 3978 and serves /api/messages.",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "TEAMS_REQUIRE_MENTION",
      statePath: "teamsConfig.requireMention",
      validValues: ["0", "1"],
      defaultValue: "1",
      prompt: {
        label: "Microsoft Teams mention mode",
        help: "Controls OpenClaw group and channel behavior only. Direct messages are unaffected.",
      },
    },
  ],
  credentials: [
    {
      id: "teamsClientSecret",
      sourceInput: "clientSecret",
      providerName: "{sandboxName}-teams-bridge",
      providerEnvKey: "MSTEAMS_APP_PASSWORD",
      placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
      primary: true,
    },
  ],
  // requiredAtCreate - the preset carries this channel's credential_binding:
  // - The provider profile is endpointless, so the binding is the only thing that
  //   makes MSTEAMS_APP_PASSWORD injectable.
  // - The sandbox reads the provider environment once, at boot, so a preset
  //   applied afterwards never reaches the running agent.
  policyPresets: [{ name: "teams", policyKeys: ["teams"], requiredAtCreate: true }],
  hostForward: {
    port: "{{teamsConfig.webhookPort}}",
    label: "Microsoft Teams webhook",
  },
  render: [
    {
      id: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.renderId,
      kind: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.kind,
      agent: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.agent,
      target: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.target,
      fragment: {
        path: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.configPath,
        value: {
          enabled: true,
          appId: "{{teamsConfig.appId}}",
          // No appPassword here: OpenShell 0.0.106 injects
          // MSTEAMS_APP_PASSWORD as a revision-scoped placeholder and rejects
          // the canonical form once the policy binds the credential. The
          // OpenClaw Teams token resolver falls back to
          // process.env.MSTEAMS_APP_PASSWORD. Hermes receives the same runtime
          // placeholder under TEAMS_CLIENT_SECRET through its runtime alias.
          tenantId: "{{teamsConfig.tenantId}}",
          webhook: {
            port: "{{teamsConfig.webhookPort}}",
            path: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.webhookPath,
          },
          healthMonitor: {
            enabled: false,
          },
          // OpenClaw Teams streaming can duplicate or collapse preview and final messages.
          // Keep final-only mode until that path is fixed and covered by runtime validation.
          streaming: {
            mode: "off",
          },
          dmPolicy: "{{allowedIds.teams.dmPolicy}}",
          allowFrom: "{{allowedIds.teams.values}}",
          groupPolicy: "open",
          requireMention: "{{teamsConfig.requireMention}}",
        },
      },
    },
    {
      id: "teams-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.msteams",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "teams-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "TEAMS_CLIENT_ID={{teamsConfig.appId}}",
        "TEAMS_TENANT_ID={{teamsConfig.tenantId}}",
        "TEAMS_ALLOWED_USERS={{allowedIds.teams.csv}}",
        "TEAMS_PORT={{teamsConfig.webhookPort}}",
      ],
    },
    {
      id: "teams-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.teams",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "msteams",
      visibility: {
        configKeys: ["msteams"],
        logPatterns: ["msteams", "teams"],
      },
      nodePreloads: [
        {
          module: "msteams-message-hints",
          injectInto: ["boot", "connect"],
          // Require the packaged asset at setup time. The preload itself fails
          // open at runtime so an upstream shape change preserves Teams with a
          // bounded warning instead of preventing the gateway from starting.
          optional: false,
          installMessage:
            "[channels] Installing Microsoft Teams message hint patch (native mentions)",
          installedMessage:
            "[channels] Microsoft Teams message hint patch installed (NODE_OPTIONS updated)",
        },
      ],
    },
    hermes: {
      envAliases: [
        {
          envKey: "MSTEAMS_APP_PASSWORD",
          targetEnvKey: "TEAMS_CLIENT_SECRET",
          match: "^openshell:resolve:env:v[0-9]+_MSTEAMS_APP_PASSWORD$",
          value: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@openclaw/msteams@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.7.1.tgz",
      },
      required: true,
    },
    {
      id: "hermesTeamsAppsPackage",
      agent: "hermes",
      manager: "python-package",
      spec: "microsoft-teams-apps==2.0.13.4",
      required: true,
    },
  ],
  hooks: [
    {
      id: "teams-host-forward-port-conflict",
      phase: "pre-enable",
      handler: "teams.hostForwardPortConflict",
      inputs: ["webhookPort"],
      onFailure: "abort",
    },
    {
      id: "teams-host-forward-port-status",
      phase: "status",
      handler: "teams.hostForwardPortStatus",
      outputs: [
        {
          id: "hostForwardPortOverlaps",
          kind: "status",
        },
      ],
    },
    {
      id: "teams-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "clientSecret",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "teams-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "appId",
          kind: "config",
          required: true,
        },
        {
          id: "tenantId",
          kind: "config",
          required: true,
        },
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "webhookPort",
          kind: "config",
        },
        {
          id: "requireMention",
          kind: "config",
        },
      ],
    },
  ],
};

// src/lib/messaging/channels/telegram/manifest.ts
var telegramManifest = {
  schemaVersion: 1,
  id: "telegram",
  displayName: "Telegram",
  description: "Telegram bot messaging",
  diagnosticsProbe: "log-tail",
  enrollmentNotes: [
    "For Telegram group chats, disable privacy mode in @BotFather (/setprivacy -> your bot -> Disable).",
    "After changing privacy mode, remove and re-add the bot to each group before testing @mentions.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "TELEGRAM_BOT_TOKEN",
      prompt: {
        label: "Telegram Bot Token",
        help: "Create a bot via @BotFather on Telegram, then copy the token.",
      },
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_ALLOWED_IDS",
      statePath: "allowedIds.telegram",
      prompt: {
        label: "Telegram User ID (for DM access)",
        help: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_REQUIRE_MENTION",
      statePath: "telegramConfig.requireMention",
      validValues: ["0", "1"],
      defaultValue: "1",
      prompt: {
        label: "Telegram group mention mode",
        help: "Controls Telegram group-chat behavior only \u2014 reply only when @mentioned vs. to all group messages. Direct messages are unaffected by this setting and remain subject to pairing and TELEGRAM_ALLOWED_IDS.",
      },
    },
    {
      id: "groupPolicy",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_GROUP_POLICY",
      statePath: "telegramConfig.groupPolicy",
      validValues: ["open", "allowlist", "disabled"],
      defaultValue: "open",
      prompt: {
        label: "Telegram group policy",
        help: "Controls OpenClaw Telegram group access. Hermes does not expose an equivalent disable-groups policy.",
      },
    },
  ],
  credentials: [
    {
      id: "telegramBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-telegram-bridge",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
      placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    },
  ],
  policyPresets: [
    {
      name: "telegram",
      // requiredAtCreate - the preset carries this channel's credential_binding:
      // - The provider profile is endpointless, so the binding is the only thing
      //   that makes TELEGRAM_BOT_TOKEN injectable.
      // - The sandbox reads the provider environment once, at boot; the agent
      //   inherits that read for the life of the container.
      // - A preset applied after boot never reaches the agent, and no restart
      //   recovers it.
      requiredAtCreate: true,
      policyKeys: ["telegram_bot"],
      agentPolicyKeys: {
        hermes: ["telegram"],
      },
    },
  ],
  render: [
    {
      id: "telegram-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.telegram",
        value: {
          enabled: true,
          accounts: {
            default: {
              // No botToken here:
              // - OpenShell injects TELEGRAM_BOT_TOKEN as a revision-scoped
              //   placeholder and refuses the canonical form once the policy
              //   binds the credential.
              // - OpenClaw resolves the default account from
              //   process.env.TELEGRAM_BOT_TOKEN, so the env value is enough.
              // - The bot token travels in the request path
              //   (/bot<TOKEN>/method); OpenShell rewrites URL path
              //   placeholders, so no rewrite flag is needed on the endpoint.
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              proxy: "{{proxyUrl}}",
              groupPolicy: "{{telegramConfig.groupPolicy}}",
              dmPolicy: "{{allowedIds.telegram.dmPolicy}}",
              allowFrom: "{{allowedIds.telegram.values}}",
            },
          },
        },
      },
    },
    {
      id: "telegram-openclaw-groups",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      when: "{{telegramConfig.openclawGroups}}",
      fragment: {
        path: "channels.telegram.groups",
        value: "{{telegramConfig.openclawGroups}}",
      },
    },
    {
      id: "telegram-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.telegram",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "telegram-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      // TELEGRAM_BOT_TOKEN is deliberately absent: OpenShell injects it into the
      // sandbox environment, and Hermes reads it with getenv under the same name.
      lines: ["TELEGRAM_ALLOWED_USERS={{allowedIds.telegram.csv}}"],
    },
    {
      id: "telegram-hermes-config",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "telegram",
        value: {
          require_mention: "{{telegramConfig.requireMention}}",
        },
      },
    },
    {
      id: "telegram-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.telegram",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "telegram",
      visibility: {
        configKeys: ["telegram"],
        logPatterns: ["telegram"],
      },
      nodePreloads: [
        {
          module: "telegram-diagnostics",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Telegram diagnostics (provider readiness + inference errors)",
          installedMessage: "[channels] Telegram diagnostics installed (NODE_OPTIONS updated)",
        },
      ],
    },
  },
  hooks: [
    {
      id: "telegram-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "telegram-allowlist-aliases",
      phase: "enroll",
      handler: "telegram.allowlistAliases",
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: "telegram-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "requireMention",
          kind: "config",
        },
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: "telegram-openclaw-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["openclaw"],
      outputs: [
        {
          id: "groupPolicy",
          kind: "config",
        },
      ],
    },
    {
      id: "telegram-get-me-reachability",
      phase: "reachability-check",
      handler: "telegram.getMeReachability",
      inputs: ["botToken"],
      onFailure: "skip-channel",
    },
    {
      id: "telegram-openclaw-bridge-health",
      phase: "health-check",
      handler: "telegram.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "telegram-gateway-conflict-status",
      phase: "status",
      handler: "telegram.gatewayConflictStatus",
      outputs: [
        {
          id: "bridgeHealth",
          kind: "status",
        },
      ],
    },
    {
      id: "telegram-status-health",
      phase: "status",
      handler: "telegram.statusHealth",
      agents: ["openclaw"],
      outputs: [
        {
          id: "channelHealth",
          kind: "status",
        },
      ],
    },
  ],
};

// src/lib/messaging/channels/wechat/contract.ts
var WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT = {
  channelId: "wechat",
  planHookId: "wechat-seed-openclaw-account",
  handlerId: "wechat.seedOpenClawAccount",
  outputId: "openclawWeixinAccountFile",
  kind: "build-file",
  required: true,
  mode: "0600",
};
var WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.handlerId;
var WECHAT_SEED_OPENCLAW_ACCOUNT_PLAN_HOOK_ID = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.planHookId;
var WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.outputId;
var WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";
function authorizeWechatAccountFilePlaceholders(value) {
  const content = isPlainDataObject2(value) ? ownDataPropertyValue2(value, "content") : void 0;
  if (
    !isPlainDataObject2(value) ||
    !hasExactlyOwnDataProperties2(value, ["content", "mode", "path"]) ||
    !isWechatAccountFilePath(ownDataPropertyValue2(value, "path")) ||
    ownDataPropertyValue2(value, "mode") !== WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.mode ||
    !isPlainDataObject2(content) ||
    !hasOnlyOwnDataProperties(content, ["baseUrl", "savedAt", "token", "userId"]) ||
    !hasOwnDataProperty(content, "savedAt") ||
    !hasOwnDataProperty(content, "token") ||
    ownDataPropertyValue2(content, "token") !== WECHAT_TOKEN_PLACEHOLDER ||
    !isNonEmptyString(ownDataPropertyValue2(content, "savedAt")) ||
    !isOptionalNonEmptyString(content, "baseUrl") ||
    !isOptionalNonEmptyString(content, "userId")
  ) {
    return [];
  }
  return [{ path: ["content", "token"], value: WECHAT_TOKEN_PLACEHOLDER }];
}
function wechatAccountFilePath(accountId) {
  return `openclaw-weixin/accounts/${accountId}.json`;
}
function assertSafeWechatAccountId(accountId) {
  if (!isSafeWechatAccountId(accountId)) {
    throw new Error("WeChat account id contains unsafe filename characters.");
  }
}
function isWechatAccountFilePath(value) {
  if (typeof value !== "string") return false;
  const prefix = "openclaw-weixin/accounts/";
  const suffix = ".json";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const accountId = value.slice(prefix.length, -suffix.length);
  return accountId === accountId.trim() && isSafeWechatAccountId(accountId);
}
function isSafeWechatAccountId(accountId) {
  return (
    accountId.length > 0 &&
    accountId !== "." &&
    accountId !== ".." &&
    !/[\\/\0-\x1F\x7F]/.test(accountId) &&
    !accountId.includes("..")
  );
}
function isPlainDataObject2(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownDataPropertyValue2(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : void 0;
}
function hasOwnDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== void 0 && "value" in descriptor;
}
function hasExactlyOwnDataProperties2(value, expected) {
  const actual = Object.getOwnPropertyNames(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function hasOnlyOwnDataProperties(value, allowed) {
  return Object.getOwnPropertyNames(value).every((key) => allowed.includes(key));
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isOptionalNonEmptyString(value, key) {
  return !hasOwnDataProperty(value, key) || isNonEmptyString(ownDataPropertyValue2(value, key));
}

// src/lib/messaging/channels/wechat/manifest.ts
var wechatManifest = {
  schemaVersion: 1,
  id: "wechat",
  displayName: "WeChat",
  description: "WeChat (personal) bot messaging",
  enrollmentHelp:
    "Captured automatically via a host-side QR scan during onboard \u2014 pair the bot by scanning the QR with WeChat on your phone (Discover \u2192 Scan). DM-only.",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "host-qr",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "WECHAT_BOT_TOKEN",
      prompt: {
        label: "WeChat Bot Token",
        help: "Captured automatically via a host-side QR scan during onboard \u2014 pair the bot by scanning the QR with WeChat on your phone (Discover \u2192 Scan). DM-only.",
      },
    },
    {
      id: "accountId",
      kind: "config",
      required: true,
      envKey: "WECHAT_ACCOUNT_ID",
      statePath: "wechatConfig.accountId",
    },
    {
      id: "baseUrl",
      kind: "config",
      required: false,
      envKey: "WECHAT_BASE_URL",
      statePath: "wechatConfig.baseUrl",
    },
    {
      id: "userId",
      kind: "config",
      required: false,
      envKey: "WECHAT_USER_ID",
      statePath: "wechatConfig.userId",
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "WECHAT_ALLOWED_IDS",
      statePath: "allowedIds.wechat",
      prompt: {
        label: "WeChat User ID(s) (DM allowlist)",
        help: "Optional: restrict who can DM the bot. The WeChat user id of the operator who scanned is added automatically; supply additional ids as a comma-separated list.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
  ],
  credentials: [
    {
      id: "wechatBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-wechat-bridge",
      providerEnvKey: "WECHAT_BOT_TOKEN",
      placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    },
  ],
  state: {
    openclaw: ["wechat", "openclaw-weixin"],
  },
  // Both agent policies bind the endpointless provider. Apply it before boot
  // so OpenShell injects WECHAT_BOT_TOKEN into the agent process environment.
  policyPresets: [{ name: "wechat", policyKeys: ["wechat_bridge"], requiredAtCreate: true }],
  render: [
    {
      id: "wechat-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.openclaw-weixin",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "wechat-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.openclaw-weixin",
        value: { enabled: true },
      },
    },
    {
      id: "wechat-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "WEIXIN_ACCOUNT_ID={{wechatConfig.accountId}}",
        "WEIXIN_BASE_URL={{wechatConfig.baseUrl}}",
        "WEIXIN_ALLOWED_USERS={{allowedIds.wechat.csv}}",
      ],
    },
    {
      id: "wechat-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.weixin",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "openclaw-weixin",
      visibility: {
        configKeys: ["openclaw-weixin"],
        logPatterns: ["wechat", "openclaw-weixin"],
      },
      nodePreloads: [
        {
          module: "wechat-account-placeholder",
          injectInto: ["boot"],
          optional: false,
        },
        {
          module: "wechat-diagnostics",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing WeChat diagnostics (provider readiness + inference errors)",
          installedMessage: "[channels] WeChat diagnostics installed (NODE_OPTIONS updated)",
        },
      ],
    },
    hermes: {
      envAliases: [
        {
          envKey: "WECHAT_BOT_TOKEN",
          targetEnvKey: "WEIXIN_TOKEN",
          match: "^openshell:resolve:env:v[0-9]+_WECHAT_BOT_TOKEN$",
          value: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      pin: true,
      integrity:
        "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==",
      tarballUrl:
        "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz",
      runtimeLock: {
        cachePath: "/usr/local/share/nemoclaw/wechat-npm-cache",
        installCacheEnvKey: "NEMOCLAW_WECHAT_NPM_INSTALL_CACHE",
        lockFile: "/usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
        projectsRoot: "/sandbox/.openclaw/npm/projects",
        verifierPath: "/usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts",
        offline: true,
        legacyPeerDeps: true,
      },
      required: true,
    },
  ],
  hooks: [
    {
      id: "wechat-host-qr",
      phase: "enroll",
      handler: "wechat.ilinkLogin",
      inputs: ["allowedIds"],
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
        {
          id: "accountId",
          kind: "config",
          required: true,
        },
        {
          id: "baseUrl",
          kind: "config",
        },
        {
          id: "userId",
          kind: "config",
        },
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "wechat-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.planHookId,
      phase: "post-agent-install",
      handler: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.handlerId,
      agents: ["openclaw"],
      inputs: [
        "wechatConfig.accountId",
        "wechatConfig.baseUrl",
        "wechatConfig.userId",
        "credential.wechatBotToken.placeholder",
      ],
      outputs: [
        {
          id: "openclawWeixinAccountsIndex",
          kind: "build-file",
          required: true,
        },
        {
          id: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.outputId,
          kind: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.kind,
          required: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.required,
        },
        {
          id: "openclawConfigPatch",
          kind: "build-file",
          required: true,
        },
      ],
      onFailure: "abort",
    },
    {
      id: "wechat-health-check",
      phase: "health-check",
      handler: "wechat.healthCheck",
      inputs: ["wechatConfig.accountId"],
      onFailure: "abort",
    },
  ],
};

// src/lib/messaging/channels/whatsapp/manifest.ts
var whatsappManifest = {
  schemaVersion: 1,
  id: "whatsapp",
  displayName: "WhatsApp",
  description: "WhatsApp Web messaging (QR pairing)",
  enrollmentHelp:
    "WhatsApp Web pairs via QR code scanned with your phone \u2014 no host-side token. After the sandbox is running, run `openshell term` and then use `openclaw channels login --channel whatsapp` for OpenClaw or `hermes whatsapp` for Hermes to display the QR.",
  enrollmentNotes: [
    "After pairing, run `nemoclaw <sandbox> channels status --channel whatsapp`. OpenClaw reports inbound delivery evidence; Hermes reports gateway and dashboard session-path diagnostics.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "in-sandbox-qr",
  },
  inputs: [
    {
      id: "mode",
      kind: "config",
      required: false,
      envKey: "WHATSAPP_MODE",
      statePath: "whatsappConfig.mode",
      validValues: ["self-chat", "bot"],
      // Hermes adapter default. `self-chat` replies only to messages the paired
      // account sends to itself and reads no allowlist, so a paired sandbox works
      // with nothing else set. `bot` serves other senders.
      defaultValue: "self-chat",
      prompt: {
        label: "WhatsApp reply mode",
        help: "self-chat replies only to messages the paired account sends to itself. bot replies to other senders and stops replying to that self-chat: an unknown sender receives a pairing code you approve with `hermes pairing approve whatsapp <code>`, unless you set WHATSAPP_ALLOWED_IDS to a fixed sender list before this command.",
        emptyValueMessage: "the sandbox replies only in your own self-chat",
      },
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "WHATSAPP_ALLOWED_IDS",
      statePath: "allowedIds.whatsapp",
    },
  ],
  credentials: [],
  policyPresets: ["whatsapp"],
  render: [
    {
      id: "whatsapp-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.whatsapp",
        value: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
            },
          },
        },
      },
    },
    {
      id: "whatsapp-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.whatsapp",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "whatsapp-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "WHATSAPP_ENABLED=true",
        "WHATSAPP_MODE={{whatsappConfig.mode}}",
        "WHATSAPP_DM_POLICY={{whatsappConfig.dmPolicy}}",
        "WHATSAPP_ALLOWED_USERS={{allowedIds.whatsapp.csv}}",
      ],
    },
    {
      id: "whatsapp-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.whatsapp",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "whatsapp",
      visibility: {
        configKeys: ["whatsapp"],
        logPatterns: ["whatsapp"],
      },
      nodePreloads: [
        {
          module: "whatsapp-qr-compact",
          injectInto: ["connect"],
          optional: true,
          installMessage:
            "[channels] Installing WhatsApp compact-QR renderer (scan-friendly pairing)",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "node-package",
      spec: "npm:@openclaw/whatsapp@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      // Only Hermes reads a reply mode: NemoClaw renders `WHATSAPP_MODE` and
      // `WHATSAPP_DM_POLICY` into the Hermes env, and the OpenClaw fragment
      // carries no sender policy, so prompting an OpenClaw operator would
      // collect an answer nothing consumes.
      id: "whatsapp-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["hermes"],
      outputs: [
        {
          id: "mode",
          kind: "config",
        },
      ],
    },
    {
      id: "whatsapp-status-health",
      phase: "status",
      handler: "whatsapp.statusHealth",
      agents: ["openclaw", "hermes"],
      outputs: [
        {
          id: "channelHealth",
          kind: "status",
        },
      ],
    },
  ],
};

// src/lib/messaging/channels/built-ins.ts
var BUILT_IN_CHANNEL_MANIFESTS = [
  telegramManifest,
  discordManifest,
  wechatManifest,
  slackManifest,
  whatsappManifest,
  teamsManifest,
  googlechatManifest,
];
function createBuiltInChannelManifestRegistry() {
  return createChannelManifestRegistry(BUILT_IN_CHANNEL_MANIFESTS);
}

// src/lib/messaging/channels/metadata.ts
var CONFIG_ENV_ALIASES_BY_ENV_KEY = {
  DISCORD_SERVER_ID: ["DISCORD_SERVER_IDS"],
  DISCORD_USER_ID: ["DISCORD_ALLOWED_IDS"],
  MSTEAMS_APP_ID: ["TEAMS_CLIENT_ID"],
  MSTEAMS_TENANT_ID: ["TEAMS_TENANT_ID"],
  TEAMS_ALLOWED_USERS: ["MSTEAMS_ALLOWED_USERS"],
  MSTEAMS_PORT: ["TEAMS_PORT"],
};
function listBuiltInMessagingChannelManifests(options = {}) {
  return selectManifests(options);
}
function listAvailableMessagingChannelIds(options = {}) {
  return selectManifests(options).map((manifest) => manifest.id);
}
function listMessagingCredentialMetadata(options = {}) {
  return selectManifests(options).flatMap((manifest) =>
    manifest.credentials.map((credential) => ({
      channelId: manifest.id,
      credentialId: credential.id,
      sourceInput: credential.sourceInput,
      providerNameTemplate: credential.providerName,
      providerNameSuffix: providerNameSuffix(credential.providerName),
      providerEnvKey: credential.providerEnvKey,
      placeholder: credential.placeholder,
      primary: credential.primary === true,
    })),
  );
}
function listMessagingCredentialEnvAssignments(options = {}) {
  return selectManifests(options).flatMap((manifest) => {
    const credentialsByTemplate = new Map(
      manifest.credentials.map((credential) => [
        `{{credential.${credential.id}.placeholder}}`,
        credential,
      ]),
    );
    const renderedAssignments = manifest.render.flatMap((render) => {
      if (options.agent && render.agent !== options.agent) return [];
      if (render.kind !== "env-lines") return [];
      return render.lines.flatMap((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) return [];
        const credential = credentialsByTemplate.get(line.slice(separator + 1));
        if (!credential) return [];
        return [
          {
            channelId: manifest.id,
            agent: render.agent,
            sourceEnvKey: credential.providerEnvKey,
            targetEnvKey: line.slice(0, separator),
            placeholder: credential.placeholder,
          },
        ];
      });
    });
    const runtimeAgents = options.agent ? [options.agent] : manifest.supportedAgents;
    const runtimeAssignments = runtimeAgents.flatMap((agent) => {
      if (options.agent && agent !== options.agent) return [];
      if (!manifest.supportedAgents.includes(agent)) return [];
      return (manifest.runtime?.[agent]?.envAliases ?? []).flatMap((alias) => {
        if (!alias.targetEnvKey) return [];
        const credential = manifest.credentials.find(
          (candidate) => candidate.providerEnvKey === alias.envKey,
        );
        if (!credential) return [];
        return [
          {
            channelId: manifest.id,
            agent,
            sourceEnvKey: alias.envKey,
            targetEnvKey: alias.targetEnvKey,
            placeholder: credential.placeholder,
          },
        ];
      });
    });
    return [...renderedAssignments, ...runtimeAssignments];
  });
}
function getMessagingCredentialEnvKeysByChannel(options = {}) {
  return Object.fromEntries(
    selectManifests(options).map((manifest) => [
      manifest.id,
      manifest.credentials.map((credential) => credential.providerEnvKey),
    ]),
  );
}
function getMessagingChannelForCredentialEnvKey(envKey, options = {}) {
  return (
    listMessagingCredentialMetadata(options).find(
      (credential) => credential.providerEnvKey === envKey,
    )?.channelId ?? null
  );
}
function getMessagingProviderSuffixesByChannel(options = {}) {
  return Object.fromEntries(
    selectManifests(options).flatMap((manifest) => {
      const suffixes = manifest.credentials.map((credential) =>
        providerNameSuffix(credential.providerName),
      );
      return suffixes.length > 0 ? [[manifest.id, suffixes]] : [];
    }),
  );
}
function listMessagingProviderSuffixes(options = {}) {
  return uniqueStrings(
    listMessagingCredentialMetadata(options).map((credential) => credential.providerNameSuffix),
  );
}
function listMessagingProviderNamesForChannel(sandboxName, channelId, options = {}) {
  const manifest = selectManifests(options).find((entry) => entry.id === channelId);
  if (!manifest) return [];
  return manifest.credentials.map((credential) =>
    credential.providerName.replaceAll("{sandboxName}", sandboxName),
  );
}
function listMessagingChannelsWithoutCredentials(options = {}) {
  return selectManifests(options)
    .filter((manifest) => manifest.credentials.length === 0)
    .map((manifest) => manifest.id);
}
function listMessagingConfigEnvMetadata(options = {}) {
  return selectManifests(options).flatMap((manifest) =>
    manifest.inputs.flatMap((input) => {
      if (input.kind !== "config" || !input.envKey) return [];
      return [
        {
          channelId: manifest.id,
          inputId: input.id,
          envKey: input.envKey,
          ...(input.statePath ? { statePath: input.statePath } : {}),
          ...(input.validValues ? { validValues: input.validValues } : {}),
        },
      ];
    }),
  );
}
function listMessagingConfigEnvKeys(options = {}) {
  return uniqueStrings(listMessagingConfigEnvMetadata(options).map((input) => input.envKey));
}
function getMessagingConfigEnvAliases(options = {}) {
  const envKeys = new Set(listMessagingConfigEnvKeys(options));
  return Object.fromEntries(
    Object.entries(CONFIG_ENV_ALIASES_BY_ENV_KEY).filter(([envKey]) => envKeys.has(envKey)),
  );
}
function listMessagingPolicyPresetMetadata(options = {}) {
  return selectManifests(options).flatMap((manifest) =>
    (manifest.policyPresets ?? []).map((preset) => {
      const normalized = normalizePolicyPreset(preset);
      return {
        channelId: manifest.id,
        presetName: normalized.name,
        policyKeys: normalized.policyKeys ?? [normalized.name],
        agentPolicyKeys: normalized.agentPolicyKeys ?? {},
        requiredAtCreate: normalized.requiredAtCreate === true,
        validationWarningLines: normalized.validationWarningLines ?? [],
        validationWarningLinesByAgent: normalized.validationWarningLinesByAgent ?? {},
      };
    }),
  );
}
function getMessagingPolicyKeysByChannel(options = {}) {
  const result = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    const keys = options.agent
      ? (preset.agentPolicyKeys[options.agent] ?? preset.policyKeys)
      : preset.policyKeys;
    result[preset.channelId] = uniqueStrings([...(result[preset.channelId] ?? []), ...keys]);
  }
  return result;
}
function listRequiredCreateTimeMessagingPolicyPresetNames(options = {}) {
  return uniqueStrings(
    listMessagingPolicyPresetMetadata(options)
      .filter((preset) => preset.requiredAtCreate)
      .map((preset) => preset.presetName),
  );
}
function listRequiredCreateTimeMessagingPolicyPresetsByChannel(options = {}) {
  const result = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    if (!preset.requiredAtCreate) continue;
    result[preset.channelId] = uniqueStrings([
      ...(result[preset.channelId] ?? []),
      preset.presetName,
    ]);
  }
  return result;
}
function listMessagingPolicyPresetsByChannel(options = {}) {
  const result = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    result[preset.channelId] = uniqueStrings([
      ...(result[preset.channelId] ?? []),
      preset.presetName,
    ]);
  }
  return result;
}
function getMessagingPolicyKeyAliases(options = {}) {
  const result = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    result[preset.presetName] = uniqueStrings([
      ...(result[preset.presetName] ?? []),
      ...preset.policyKeys,
      ...Object.values(preset.agentPolicyKeys).flatMap((keys) => keys ?? []),
    ]);
  }
  return result;
}
function getMessagingPolicyPresetValidationWarnings(options = {}) {
  const result = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    const agentLines = options.agent
      ? (preset.validationWarningLinesByAgent[options.agent] ?? [])
      : Object.values(preset.validationWarningLinesByAgent).flatMap((lines) => lines ?? []);
    const warningLines = [...preset.validationWarningLines, ...agentLines];
    if (warningLines.length === 0) continue;
    result[preset.presetName] = uniqueStrings([
      ...(result[preset.presetName] ?? []),
      ...warningLines,
    ]);
  }
  return result;
}
function listOpenClawManagedChannelNames(options = {}) {
  return uniqueStrings(
    selectManifests({ ...options, agent: "openclaw" }).flatMap((manifest) =>
      manifest.runtime?.openclaw?.channelName ? [manifest.runtime.openclaw.channelName] : [],
    ),
  );
}
function listOpenClawPluginExtensionIds(options = {}) {
  return uniqueStrings(
    selectManifests({ ...options, agent: "openclaw" }).flatMap((manifest) => {
      const extensionId = manifest.runtime?.openclaw?.channelName;
      const installsPlugin = (manifest.agentPackages ?? []).some(
        (agentPackage) =>
          agentPackage.agent === "openclaw" && agentPackage.manager === "node-package",
      );
      return extensionId && installsPlugin ? [extensionId] : [];
    }),
  );
}
function listOpenClawRuntimeChannelMetadata(options = {}) {
  return selectManifests({ ...options, agent: "openclaw" }).flatMap((manifest) => {
    const visibility = manifest.runtime?.openclaw?.visibility;
    if (!visibility) return [];
    if (visibility.configKeys.length === 0 || visibility.logPatterns.length === 0) return [];
    return [
      {
        channelId: manifest.id,
        configKeys: [...visibility.configKeys],
        logPatterns: [...visibility.logPatterns],
      },
    ];
  });
}
function listMessagingPackageInstallSpecs(options = {}) {
  return selectManifests(options).flatMap((manifest) =>
    (manifest.agentPackages ?? []).flatMap((agentPackage) => {
      if (options.agent && agentPackage.agent !== options.agent) return [];
      return [
        {
          channelId: manifest.id,
          packageId: agentPackage.id,
          agents: [agentPackage.agent],
          ...packageInstallValue(agentPackage),
        },
      ];
    }),
  );
}
function selectManifests(options) {
  const manifests = options.manifests ?? BUILT_IN_CHANNEL_MANIFESTS;
  const agent = options.agent;
  const selected = agent
    ? manifests.filter((manifest) => manifest.supportedAgents.includes(agent))
    : manifests;
  return [...selected];
}
function providerNameSuffix(providerNameTemplate) {
  return providerNameTemplate.replaceAll("{sandboxName}", "");
}
function normalizePolicyPreset(preset) {
  return typeof preset === "string" ? { name: preset } : preset;
}
function packageInstallValue(value) {
  return {
    manager: value.manager,
    spec: value.spec,
    ...(typeof value.pin === "boolean" ? { pin: value.pin } : {}),
  };
}
function uniqueStrings(values) {
  return [...new Set(values)];
}

// src/lib/messaging/applier/credential-env-cleanup.ts
var HERMES_ENV_RENDER_TARGET = "~/.hermes/.env";
var EXPORT_PREFIX = /^export[ \t]+/;
function readEnvLineKey(line) {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim().replace(EXPORT_PREFIX, "").trim();
  return key.length > 0 ? key : null;
}
function ownedCredentialEnvKeys(plan) {
  const declared = getMessagingCredentialEnvKeysByChannel();
  const owned = /* @__PURE__ */ new Set();
  for (const binding of plan.credentialBindings) {
    const envKey = typeof binding.providerEnvKey === "string" ? binding.providerEnvKey : "";
    const allowed = declared[binding.channelId] ?? [];
    if (envKey.length > 0 && allowed.includes(envKey)) owned.add(envKey);
  }
  return owned;
}
function currentCredentialEnvAssignments(plan) {
  return new Map(
    listMessagingCredentialEnvAssignments()
      .filter((assignment) => assignment.agent === plan.agent)
      .map((assignment) => [assignment.targetEnvKey, assignment.sourceEnvKey]),
  );
}
function staleCredentialEnvKeys(plan, rendered) {
  const owned = ownedCredentialEnvKeys(plan);
  const assigned = currentCredentialEnvAssignments(plan);
  const candidates = new Set(owned);
  for (const [lineKey, providerEnvKey] of assigned) {
    if (owned.has(providerEnvKey)) candidates.add(lineKey);
  }
  const stale = /* @__PURE__ */ new Set();
  for (const key of candidates) {
    if (assigned.has(key) && rendered.has(key)) continue;
    stale.add(key);
  }
  return stale;
}
function migrationOnlyEnvTargets(plan, renderedTargets) {
  const owned =
    plan.agent === "hermes" &&
    !renderedTargets.has(HERMES_ENV_RENDER_TARGET) &&
    ownedCredentialEnvKeys(plan).size > 0;
  return owned ? [HERMES_ENV_RENDER_TARGET] : [];
}

// src/lib/messaging/applier/openclaw-plugin-allow.ts
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function enabledPluginId(render) {
  const segments = render.path?.split(".").filter(Boolean) ?? [];
  if (
    segments.length !== 3 ||
    segments[0] !== "plugins" ||
    segments[1] !== "entries" ||
    !isObject(render.value) ||
    render.value.enabled !== true
  ) {
    return null;
  }
  return segments[2] ?? null;
}
function allowRenderedOpenClawPlugins(config, renderEntries) {
  const renderedPluginIds = renderEntries.flatMap((render) => {
    const pluginId = enabledPluginId(render);
    return pluginId ? [pluginId] : [];
  });
  if (renderedPluginIds.length === 0) return;
  const plugins = config.plugins;
  if (!isObject(plugins)) {
    throw new Error("OpenClaw messaging render requires a plugins object.");
  }
  const existingAllow = plugins.allow;
  if (existingAllow !== void 0 && !Array.isArray(existingAllow)) {
    throw new Error("OpenClaw plugins.allow must be an array.");
  }
  const allowedPluginIds = (existingAllow ?? []).filter((pluginId) => typeof pluginId === "string");
  plugins.allow = [.../* @__PURE__ */ new Set([...allowedPluginIds, ...renderedPluginIds])];
}

// src/lib/messaging/post-agent-install-selection.ts
function normalizeMessagingChannelId(channelId) {
  return channelId.trim().toLowerCase();
}
function enabledPlanChannels(plan) {
  const disabled = new Set(
    (plan.disabledChannels ?? []).map(normalizeMessagingChannelId).filter(Boolean),
  );
  return plan.channels.filter((channel) => {
    const channelId = normalizeMessagingChannelId(channel.channelId);
    return channelId.length > 0 && channel.active && !channel.disabled && !disabled.has(channelId);
  });
}
function enabledPlanChannelIds(plan) {
  return new Set(
    enabledPlanChannels(plan).map((channel) => normalizeMessagingChannelId(channel.channelId)),
  );
}
function filterEnabledPlanEntries(plan, entries) {
  const enabled = enabledPlanChannelIds(plan);
  return entries.filter((entry) => enabled.has(normalizeMessagingChannelId(entry.channelId)));
}
function selectActiveMessagingChannelIds(plan) {
  const seen = /* @__PURE__ */ new Set();
  const channels = [];
  for (const item of enabledPlanChannels(plan)) {
    const channel = normalizeMessagingChannelId(item.channelId);
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);
    channels.push(channel);
  }
  return channels;
}
function selectEnabledMessagingAgentRender(plan) {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  return plan.agentRender.filter(
    (render) =>
      render.agent === plan.agent && active.has(normalizeMessagingChannelId(render.channelId)),
  );
}
function selectEnabledPostAgentInstallBuildFiles(plan) {
  const active = new Set(selectActiveMessagingChannelIds(plan));
  const channels = enabledPlanChannels(plan);
  return plan.buildSteps.filter((step) => {
    const channelId = normalizeMessagingChannelId(step.channelId);
    if (!active.has(channelId) || step.kind !== "build-file") return false;
    if (!step.hookId) return true;
    const matchingChannels = channels.filter(
      (channel) => normalizeMessagingChannelId(channel.channelId) === channelId,
    );
    if (matchingChannels.length !== 1) return false;
    const matchedHook = matchingChannels[0]?.hooks?.find((hook) => hook.id === step.hookId);
    return matchedHook !== void 0 && matchedHook.phase === "post-agent-install";
  });
}

// src/lib/messaging/applier/build/messaging-build-applier.mts
import { spawnSync as spawnSync2 } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync,
  readFileSync as readFileSync2,
  realpathSync,
  rmSync as rmSync2,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute as isAbsolute2, resolve as resolve2, sep as sep2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY = Object.freeze({
  schemaVersion: 1,
  packageIdentity: "exact-npm-package-spec",
  registryIntegrityField: "dist.integrity",
  packedArchiveIntegrity: "must-match-committed-sri",
  registryTarballField: "dist.tarball",
  registryTarballUrl: "must-match-committed-url",
});
function isPinnedHermesUvPackageSpec(spec) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*\])?==[A-Za-z0-9][A-Za-z0-9_.!+~-]*$/.test(
    spec,
  );
}
var MessagingBuildApplierError = class extends Error {};
var DEFAULT_MESSAGING_RUNTIME_PLAN_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json";
function reviewedOpenClawPluginIntegrityByPackageSpec(
  env = process.env,
  manifests = BUILT_IN_CHANNEL_MANIFESTS,
) {
  const entries = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const integrity =
        packageSpec.integrity ?? packageSpec.integrityByVersion?.[npmPackage.version];
      if (integrity) entries.push([npmPackage.packageSpec, integrity]);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}
function reviewedOpenClawPluginTarballUrlByPackageSpec(
  env = process.env,
  manifests = BUILT_IN_CHANNEL_MANIFESTS,
) {
  const entries = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const tarballUrl =
        packageSpec.tarballUrl ?? packageSpec.tarballUrlByVersion?.[npmPackage.version];
      if (tarballUrl) entries.push([npmPackage.packageSpec, tarballUrl]);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}
function reviewedOpenClawPluginRuntimeLocksByPackageSpec(env, manifests) {
  const entries = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.manager !== "node-package" || !packageSpec.runtimeLock) {
        continue;
      }
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      entries.push([npmPackage.packageSpec, packageSpec.runtimeLock]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}
function readMessagingBuildPlanFromEnv(env, agent) {
  const encoded = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!encoded || encoded.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must be base64-encoded JSON: ${formatError(error)}`,
    );
  }
  if (
    !isObject2(parsed) ||
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
  return parsed;
}
function applyMessagingAgentRenderToObject(config, plan, target) {
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
function applyMessagingAgentRenderToEnvLines(envLines, plan, target) {
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
function applyMessagingAgentRenderToLocalFiles(plan, options = {}) {
  if (!plan) return [];
  const appliedTargets = [];
  const grouped = /* @__PURE__ */ new Map();
  for (const render of enabledAgentRender(plan)) {
    const entries = grouped.get(render.target) ?? [];
    entries.push(render);
    grouped.set(render.target, entries);
  }
  for (const target of migrationOnlyEnvTargets(plan, new Set(grouped.keys()))) {
    grouped.set(target, []);
  }
  for (const [target, renderEntries] of grouped) {
    const kinds = uniqueStrings2(renderEntries.map((entry) => entry.kind));
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
  return uniqueStrings2(appliedTargets);
}
function activeChannels(plan) {
  if (!plan) return [];
  return selectActiveMessagingChannelIds(plan);
}
function messagingRuntimePlanPath(env = process.env) {
  const configured = env.NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH?.trim();
  return configured || DEFAULT_MESSAGING_RUNTIME_PLAN_PATH;
}
function buildMessagingRuntimePlanArtifact(plan) {
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
function writeMessagingRuntimePlanArtifact(plan, targetPath) {
  const artifact = buildMessagingRuntimePlanArtifact(plan);
  if (!artifact) return null;
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    `${JSON.stringify(artifact, null, 2)}
`,
  );
  chmodSync(targetPath, 420);
  return targetPath;
}
function sanitizeRuntimeArtifactChannels(channels) {
  return channels.flatMap((channel) => {
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
function sanitizeRuntimeArtifactCredentialBindings(bindings) {
  return bindings.flatMap((binding) => {
    const channelId = sanitizeOptionalString(binding.channelId);
    const providerEnvKey = sanitizeOptionalString(binding.providerEnvKey);
    if (!channelId || !providerEnvKey) return [];
    return [{ channelId, providerEnvKey }];
  });
}
function sanitizeRuntimeSetup(setup) {
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
function sanitizeRuntimeSetupEntries(entries, allowedKeys) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    if (!isObject2(entry)) {
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
    const sanitized = { channelId };
    for (const key of allowedKeys) {
      if (key === "channelId" || entry[key] === void 0) continue;
      sanitized[key] = cloneRuntimeArtifactValue(entry[key], `runtime setup entry ${index}.${key}`);
    }
    return sanitized;
  });
}
function cloneRuntimeArtifactValue(value, label) {
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
  if (isObject2(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        assertSafeObjectKey(key, label);
        return [key, cloneRuntimeArtifactValue(entry, `${label}.${key}`)];
      }),
    );
  }
  throw new MessagingBuildApplierError(`${label} must be JSON-serializable`);
}
function sanitizeStringArray(values) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const value of values) {
    const clean = sanitizeOptionalString(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
function sanitizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function collectOpenClawMessagingPluginInstallSpecs(plan, env) {
  return collectOpenClawMessagingPluginInstalls(plan, env).map((install) => install.spec);
}
function collectHermesMessagingUvPackages(plan) {
  return collectHermesMessagingUvPackageInstalls(plan).map((install) => install.spec);
}
function collectManagedImageOpenClawPluginInstallSpecs(env) {
  return collectManagedImageOpenClawPluginInstalls(env).map((install) => install.spec);
}
function collectManagedImageHermesUvPackages() {
  return collectTrustedHermesUvPackageInstalls(BUILT_IN_CHANNEL_MANIFESTS).map(
    (install) => install.spec,
  );
}
function collectOpenClawMessagingPluginInstalls(plan, env) {
  const installs = [];
  const seen = /* @__PURE__ */ new Set();
  const trustedManifests = trustedChannelManifestsForActivePlan(plan);
  let trustedSpecs;
  let reviewedIntegrity;
  let reviewedTarballUrls;
  let runtimeLocks;
  for (const step of enabledBuildStepsForPhase(plan, "agent-install")) {
    if (step.kind !== "package-install") continue;
    if (step.value === void 0) {
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
    const install = readNodePackageInstall(step.value, step.outputId);
    const resolvedSpec = resolveOpenClawPackageSpec(install.spec, env);
    const npmPackage = parseNpmPackageSpec(resolvedSpec);
    if (npmPackage && !trustedSpecs.has(resolvedSpec)) {
      throw new MessagingBuildApplierError(
        `Messaging package-install output ${step.outputId} is not declared by a trusted built-in manifest for active OpenClaw channels: ${resolvedSpec}`,
      );
    }
    const integrity = npmPackage ? reviewedIntegrity[npmPackage.packageSpec] : void 0;
    const tarballUrl = npmPackage ? reviewedTarballUrls[npmPackage.packageSpec] : void 0;
    const resolvedInstall = {
      spec: resolvedSpec,
      ...(npmPackage ? { npmPackageSpec: npmPackage.packageSpec } : {}),
      ...(integrity ? { integrity } : {}),
      ...(tarballUrl ? { tarballUrl } : {}),
      ...(npmPackage && runtimeLocks[npmPackage.packageSpec]
        ? { runtimeLock: runtimeLocks[npmPackage.packageSpec] }
        : {}),
      pin: integrity !== void 0,
    };
    const key = JSON.stringify(resolvedInstall);
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push(resolvedInstall);
  }
  return installs;
}
function collectManagedImageOpenClawPluginInstalls(env) {
  const reviewedIntegrity = reviewedOpenClawPluginIntegrityByPackageSpec(
    env,
    BUILT_IN_CHANNEL_MANIFESTS,
  );
  const reviewedTarballUrls = reviewedOpenClawPluginTarballUrlByPackageSpec(
    env,
    BUILT_IN_CHANNEL_MANIFESTS,
  );
  const runtimeLocks = reviewedOpenClawPluginRuntimeLocksByPackageSpec(
    env,
    BUILT_IN_CHANNEL_MANIFESTS,
  );
  const installs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const manifest of BUILT_IN_CHANNEL_MANIFESTS) {
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
function trustedChannelManifestsForActivePlan(plan) {
  const active = new Set(activeChannels(plan));
  return BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) => active.has(manifest.id));
}
function trustedOpenClawPluginSpecsForManifests(manifests, env) {
  const specs = /* @__PURE__ */ new Set();
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
function collectHermesMessagingUvPackageInstalls(plan) {
  const installs = [];
  const seen = /* @__PURE__ */ new Set();
  const trustedSpecs = trustedHermesUvPackageSpecsForPlan(plan);
  for (const step of enabledBuildStepsForPhase(plan, "agent-install")) {
    if (step.kind !== "package-install") continue;
    if (step.value === void 0) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    if (readMessagingPackageManager(step.value, step.outputId) !== "python-package") continue;
    assertPackageManagerDeclared(plan, "python-package");
    const install = readPythonPackageInstall(step.value, step.outputId);
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
function trustedHermesUvPackageSpecsForPlan(plan) {
  const active = new Set(activeChannels(plan));
  return new Set(
    collectTrustedHermesUvPackageInstalls(
      BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) => active.has(manifest.id)),
    ).map((install) => install.spec),
  );
}
function collectTrustedHermesUvPackageInstalls(manifests) {
  const specs = /* @__PURE__ */ new Set();
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
function messagingRepairEnvOverrides(plan, env = process.env) {
  const overrides = {};
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
function installOpenClawMessagingPlugins(plan, env) {
  installOpenClawPluginPackages(
    collectOpenClawMessagingPluginInstalls(plan, env),
    env,
    plan ? effectiveBuildProfile(plan).nodeArchiveRemediation === "package-helper" : false,
  );
}
function installOpenClawPluginPackages(installs, env, enableRemediation) {
  for (const install of installs) {
    const installCache = install.runtimeLock
      ? requireWritableRuntimeInstallCache(install.runtimeLock, env)
      : void 0;
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
    const packed = packVerifiedOpenClawPluginArchive(install, installEnv, enableRemediation);
    try {
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
      rmSync2(packed.rootDir, { recursive: true, force: true });
    }
  }
}
function requireWritableRuntimeInstallCache(runtimeLock, env) {
  const configured = sanitizeOptionalString(env[runtimeLock.installCacheEnvKey]);
  if (!configured) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must name the sandbox-writable temporary npm cache prepared from ${runtimeLock.cachePath}`,
    );
  }
  if (!isAbsolute2(configured)) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must be an absolute path`,
    );
  }
  let installCache;
  try {
    if (lstatSync2(configured).isSymbolicLink()) {
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
  const trustedCache = existsSync2(runtimeLock.cachePath)
    ? realpathSync(runtimeLock.cachePath)
    : resolve2(runtimeLock.cachePath);
  if (installCache === trustedCache || installCache.startsWith(`${trustedCache}${sep2}`)) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must not make the trusted npm cache writable`,
    );
  }
  return installCache;
}
function runMessagingPostRenderRepair(plan, env) {
  if (!plan) return;
  const repair = effectiveBuildProfile(plan).postRenderRepair;
  if (!repair) return;
  runCommand(repair.command, {
    ...env,
    ...messagingRepairEnvOverrides(plan, env),
  });
}
function applyPostAgentInstallBuildFilesToLocalFiles(plan, options = {}) {
  const appliedTargets = [];
  for (const step of enabledBuildStepsForPhase(plan, "post-agent-install")) {
    if (step.kind !== "build-file") continue;
    if (step.value === void 0) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging build-file output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    appliedTargets.push(
      applyBuildFileOutputToLocalAgentRoot(plan, readBuildFileOutput(step.value), options),
    );
  }
  return uniqueStrings2(appliedTargets);
}
function applyJsonRenderEntriesToLocalFile(plan, target, renderEntries, options) {
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
      : `${JSON.stringify(config, null, 2)}
`,
  );
  chmodSync(targetPath, 384);
  return targetPath;
}
function applyEnvRenderEntriesToLocalFile(plan, target, renderEntries, options) {
  const targetPath = resolveAgentRenderTarget(plan, target, options);
  const envLines =
    readTextIfExists(targetPath)
      ?.split(/\r?\n/)
      .filter((line) => line.length > 0) ?? [];
  const rendered = /* @__PURE__ */ new Set();
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
  const stale = staleCredentialEnvKeys(plan, rendered);
  const keptLines = envLines.filter((line) => {
    const key = readEnvLineKey(line);
    return key === null || !stale.has(key);
  });
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    keptLines.length > 0
      ? `${keptLines.join("\n")}
`
      : "",
  );
  chmodSync(targetPath, 384);
  return targetPath;
}
function applyMessagingRenderEntriesToObject(config, renderEntries, target, plan) {
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
function applyDeclaredRenderFinalizers(config, renderEntries, plan) {
  const finalizers = effectiveBuildProfile(plan).renderFinalizers ?? [];
  if (finalizers.includes("allow-rendered-plugins")) {
    allowRenderedOpenClawPlugins(config, renderEntries);
  }
  if (finalizers.includes("inherit-api-server-toolsets")) {
    finalizeHermesRenderedPlatformToolsets(config);
  }
}
function readEnvRenderLines(render) {
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
function finalizeHermesRenderedPlatformToolsets(config) {
  const platforms = config.platforms;
  const platformToolsets = config.platform_toolsets;
  if (!isObject2(platforms) || !isObject2(platformToolsets)) return;
  const apiServerToolsets = platformToolsets.api_server;
  if (!Array.isArray(apiServerToolsets)) return;
  for (const [platform, platformConfig] of Object.entries(platforms)) {
    if (
      platform === "api_server" ||
      !isObject2(platformConfig) ||
      platformConfig.enabled !== true
    ) {
      continue;
    }
    if (!Array.isArray(platformToolsets[platform])) {
      platformToolsets[platform] = [...apiServerToolsets];
    }
  }
}
function resolveAgentRenderTarget(plan, target, options = {}) {
  const home = options.homeDir ?? homedir();
  const configRoot = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home);
  const normalizedRoot = resolve2(configRoot);
  if (target.startsWith("~/")) {
    const resolvedTarget2 = resolve2(home, target.slice(2));
    if (
      resolvedTarget2 === normalizedRoot ||
      !resolvedTarget2.startsWith(`${normalizedRoot}${sep2}`)
    ) {
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
      );
    }
    return resolvedTarget2;
  }
  const relativeTarget = normalizeBuildFilePath(target);
  const resolvedTarget = resolve2(configRoot, relativeTarget);
  if (!resolvedTarget.startsWith(`${normalizedRoot}${sep2}`)) {
    throw new MessagingBuildApplierError(
      `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
    );
  }
  return resolvedTarget;
}
function effectiveBuildProfile(plan) {
  if (plan.packageBuild) return validateBuildProfile(plan.packageBuild);
  return legacyBuildProfile(plan);
}
function legacyBuildProfile(plan) {
  const targets = plan.agentRender.map((entry) => entry.target);
  const homeTarget = targets.find((target) => target.startsWith("~/"));
  const packageManagers = uniqueStrings2(
    plan.buildSteps.flatMap((step) => {
      if (step.kind !== "package-install" || !isObject2(step.value) || Array.isArray(step.value)) {
        return [];
      }
      const manager = step.value.manager;
      return manager === "node-package" || manager === "python-package" ? [manager] : [];
    }),
  );
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
          renderFinalizers: ["allow-rendered-plugins"],
          postRenderRepair: {
            command: ["openclaw", "doctor", "--fix", "--non-interactive"],
          },
          nodeArchiveRemediation: "package-helper",
        }
      : {}),
    ...(hermesLegacy ? { renderFinalizers: ["inherit-api-server-toolsets"] } : {}),
  });
}
function validateBuildProfile(profile) {
  if (!/^~\/[A-Za-z0-9._-]+$/u.test(profile.configRoot)) {
    throw new MessagingBuildApplierError("Messaging build profile has an unsafe config root");
  }
  if (
    profile.packageManagers.some(
      (manager) => manager !== "node-package" && manager !== "python-package",
    )
  ) {
    throw new MessagingBuildApplierError(
      "Messaging build profile has an unsupported package manager",
    );
  }
  const repair = profile.postRenderRepair;
  if (
    repair !== void 0 &&
    (!isObject2(repair) ||
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
function assertPackageManagerDeclared(plan, manager) {
  if (!plan || !effectiveBuildProfile(plan).packageManagers.includes(manager)) {
    throw new MessagingBuildApplierError(
      `Messaging build profile does not declare package manager '${manager}'`,
    );
  }
}
function resolveHomeTarget(target, home) {
  if (!target.startsWith("~/")) {
    throw new MessagingBuildApplierError(`Messaging config root ${target} must be home-relative`);
  }
  const normalizedHome = resolve2(home);
  const resolvedTarget = resolve2(home, target.slice(2));
  if (resolvedTarget === normalizedHome || !resolvedTarget.startsWith(`${normalizedHome}${sep2}`)) {
    throw new MessagingBuildApplierError(
      `Messaging config root ${target} must stay inside ${home}`,
    );
  }
  return resolvedTarget;
}
function enabledAgentRender(plan) {
  return selectEnabledMessagingAgentRender(plan);
}
function enabledBuildStepsForPhase(plan, phase) {
  if (!plan) return [];
  if (phase === "post-agent-install") {
    return selectEnabledPostAgentInstallBuildFiles(plan);
  }
  return enabledBuildSteps(plan).filter((step) => buildStepMatchesPhase(plan, step, phase));
}
function enabledBuildSteps(plan) {
  const active = new Set(activeChannels(plan));
  return plan.buildSteps.filter((step) => active.has(step.channelId));
}
function buildStepMatchesPhase(plan, step, phase) {
  const hookPhase = step.hookId ? findHookPhase(plan, step.channelId, step.hookId) : void 0;
  if (hookPhase) return hookPhase === phase;
  if (phase === "agent-install") return step.kind === "package-install";
  if (phase === "post-agent-install") return step.kind === "build-file";
  return false;
}
function findHookPhase(plan, channelId, hookId) {
  const channel = plan.channels.find((candidate) => candidate.channelId === channelId);
  return channel?.hooks?.find((hook) => hook.id === hookId)?.phase;
}
function applyBuildFileOutputToLocalAgentRoot(plan, file, options = {}) {
  const home = options.homeDir ?? homedir();
  const root = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home);
  const relativePath = normalizeBuildFilePath(file.path);
  const target = resolve2(root, relativePath);
  const normalizedRoot = resolve2(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep2}`)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${file.path} must stay inside ${root}`,
    );
  }
  const contents =
    file.merge !== void 0
      ? mergeBuildFileContent(readTextIfExists(target), file.merge, target)
      : serializeBuildFileContent(file.content);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  if (file.mode) chmodSync(target, parseBuildFileMode(file.path, file.mode));
  return target;
}
function mergeBuildFileContent(existing, patch, target) {
  if (!isObject2(patch)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file merge for ${target} must be an object.`,
    );
  }
  const root = parseJsonObject(existing, target);
  mergeJsonObjects(root, patch);
  return `${JSON.stringify(root, null, 2)}
`;
}
function parseJsonObject(existing, target) {
  if (!existing || existing.trim().length === 0) return {};
  const parsed = JSON.parse(existing);
  if (!isObject2(parsed)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file target ${target} must contain an object.`,
    );
  }
  return parsed;
}
function readTextIfExists(path) {
  return existsSync2(path) ? readFileSync2(path, "utf-8") : void 0;
}
function readBuildFileOutput(value) {
  if (!isObject2(value)) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  const file = value;
  if (typeof file.path !== "string" || file.path.trim().length === 0) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  if (file.content === void 0 && file.merge === void 0) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${file.path} must include content or merge`,
    );
  }
  if (file.mode !== void 0 && typeof file.mode !== "string") {
    throw new MessagingBuildApplierError(`Messaging build-file ${file.path} mode must be a string`);
  }
  return file;
}
function normalizeBuildFilePath(pathValue) {
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
function serializeBuildFileContent(value) {
  if (value === void 0) return "";
  if (typeof value === "string")
    return value.endsWith("\n")
      ? value
      : `${value}
`;
  return `${JSON.stringify(value, null, 2)}
`;
}
function parseBuildFileMode(pathValue, mode) {
  if (!/^[0-7]{3,4}$/.test(mode) || (mode.length === 4 && mode[0] !== "0")) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must be an octal file mode`,
    );
  }
  const parsed = Number.parseInt(mode, 8);
  if ((parsed & 18) !== 0) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must not be group/world writable`,
    );
  }
  return parsed;
}
function readMessagingPackageManager(value, outputId) {
  if (!isObject2(value)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  }
  const install = value;
  if (install.manager === "node-package" || install.manager === "python-package") {
    return install.manager;
  }
  throw new MessagingBuildApplierError(
    `Messaging package-install output ${outputId} has an unsupported package manager`,
  );
}
function readNodePackageInstall(install, outputId) {
  if (typeof install.spec !== "string" || install.spec.trim().length === 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must include a package spec`,
    );
  }
  if (install.pin !== void 0 && typeof install.pin !== "boolean") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} pin must be boolean`,
    );
  }
  if (install.integrity !== void 0 && typeof install.integrity !== "string") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrity must be a string`,
    );
  }
  if (install.integrityByVersion !== void 0 && !isStringRecord(install.integrityByVersion)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrityByVersion must map versions to strings`,
    );
  }
  return install;
}
function readPythonPackageInstall(install, outputId) {
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
function resolveOpenClawPackageSpec(spec, env) {
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
function parseNpmPackageSpec(spec) {
  if (!spec.startsWith("npm:")) return null;
  const packageSpec = spec.slice("npm:".length);
  const versionAt = packageSpec.startsWith("@")
    ? packageSpec.indexOf("@", 1)
    : packageSpec.lastIndexOf("@");
  if (versionAt <= 0 || versionAt === packageSpec.length - 1) return { packageSpec };
  return { packageSpec, version: packageSpec.slice(versionAt + 1) };
}
var EXACT_NPM_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function requireExactNpmPackageSpec(spec, manifestId) {
  const parsed = parseNpmPackageSpec(spec);
  if (!parsed) {
    throw new MessagingBuildApplierError(
      `Trusted manifest ${manifestId} declares a non-npm OpenClaw plugin package: ${spec}`,
    );
  }
  if (!parsed.version || !EXACT_NPM_VERSION_PATTERN.test(parsed.version)) {
    throw new MessagingBuildApplierError(
      `Trusted manifest ${manifestId} must use an exact-version OpenClaw plugin package: ${spec}`,
    );
  }
  return { packageSpec: parsed.packageSpec, version: parsed.version };
}
function runCommand(args, env) {
  console.log(`+ ${args.join(" ")}`);
  const result = spawnSync2(args[0], args.slice(1), {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new MessagingBuildApplierError(
      `${args[0]} exited with status ${String(result.status ?? "unknown")}`,
    );
  }
}
function packVerifiedOpenClawPluginArchive(install, env, enableRemediation) {
  if (!install.npmPackageSpec) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin spec ${install.spec} must use an npm: package with committed integrity pin`,
    );
  }
  if (!install.integrity) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} has no committed npm integrity pin`,
    );
  }
  if (!install.tarballUrl) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} has no committed npm tarball URL`,
    );
  }
  const archive = packReviewedNpmArchive({
    env,
    expectedIntegrity: install.integrity,
    label: `OpenClaw plugin ${install.npmPackageSpec}`,
    packageSpec: install.npmPackageSpec,
    tarballUrl: install.tarballUrl,
  });
  const exactPackage = requireExactNpmPackageSpec(install.spec, install.npmPackageSpec);
  const remediated = enableRemediation
    ? runPackageOwnedNodeArchiveRemediation({
        archivePath: archive.archivePath,
        env,
        packageSpec: exactPackage.packageSpec,
        workingDirectory: archive.rootDirectory,
      })
    : { archivePath: archive.archivePath };
  return { archivePath: remediated.archivePath, rootDir: archive.rootDirectory };
}
function runPackageOwnedNodeArchiveRemediation(request) {
  const helper = sanitizeOptionalString(request.env.NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER);
  if (!helper) return { archivePath: request.archivePath };
  if (!isAbsolute2(helper)) {
    throw new MessagingBuildApplierError(
      "NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER must be an absolute path",
    );
  }
  const result = spawnSync2(
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
  let output;
  try {
    output = JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned invalid JSON: ${formatError(error)}`,
    );
  }
  if (!isObject2(output) || typeof output.archivePath !== "string") {
    throw new MessagingBuildApplierError(
      "Node package remediation helper did not return an archivePath",
    );
  }
  const archivePath = resolve2(output.archivePath);
  const workingDirectory = realpathSync(request.workingDirectory);
  if (archivePath !== workingDirectory && !archivePath.startsWith(`${workingDirectory}${sep2}`)) {
    throw new MessagingBuildApplierError(
      "Node package remediation helper returned an archive outside its working directory",
    );
  }
  try {
    if (lstatSync2(archivePath).isSymbolicLink() || !statSync(archivePath).isFile()) {
      throw new Error("archive is not a regular file");
    }
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned an unreadable archive: ${formatError(error)}`,
    );
  }
  return { archivePath };
}
function credentialPlaceholderRules(plan) {
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
function preserveCredentialPlaceholders(desired, existing, rules) {
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
        Array.isArray(existing) ? existing[index] : void 0,
        rules,
      ),
    );
  }
  if (isObject2(desired)) {
    const existingObject = isObject2(existing) ? existing : {};
    return Object.fromEntries(
      Object.entries(desired).map(([key, value]) => [
        key,
        preserveCredentialPlaceholders(value, existingObject[key], rules),
      ]),
    );
  }
  return desired;
}
function getJsonPath(root, pathValue) {
  let cursor = root;
  for (const segment of pathValue.split(".").filter(Boolean)) {
    if (!isObject2(cursor)) return void 0;
    cursor = cursor[segment];
  }
  return cursor;
}
function isProviderPlaceholderForEnvKey(value, envKey) {
  const openShellPrefix = "openshell:resolve:env:";
  if (value.startsWith(openShellPrefix)) {
    return placeholderSuffixMatchesEnvKey(value.slice(openShellPrefix.length), envKey);
  }
  const aliasMatch = value.match(/^[A-Za-z0-9]+-OPENSHELL-RESOLVE-ENV-(.+)$/);
  return aliasMatch ? placeholderSuffixMatchesEnvKey(aliasMatch[1], envKey) : false;
}
function placeholderSuffixMatchesEnvKey(suffix, envKey) {
  if (suffix === envKey) return true;
  const revisionMatch = suffix.match(/^v[0-9]+_(.+)$/);
  return revisionMatch?.[1] === envKey;
}
function setJsonPath(root, pathValue, value) {
  const segments = pathValue.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new MessagingBuildApplierError("Messaging render path must not be empty");
  }
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeObjectKey(segment, "Messaging render path");
    if (!isObject2(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment];
  }
  const finalSegment = segments[segments.length - 1];
  assertSafeObjectKey(finalSegment, "Messaging render path");
  if (isObject2(cursor[finalSegment]) && isObject2(value)) {
    mergeJsonObjects(cursor[finalSegment], value);
    return;
  }
  cursor[finalSegment] = value;
}
function mergeJsonObjects(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new MessagingBuildApplierError(
        "Messaging object merge rejected unsafe object key " + key,
      );
    }
    const existing = target[key];
    if (isObject2(existing) && isObject2(value)) {
      mergeJsonObjects(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      setMergedObjectValue(target, key, [.../* @__PURE__ */ new Set([...existing, ...value])]);
    } else {
      setMergedObjectValue(target, key, value);
    }
  }
}
function setMergedObjectValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function mergeEnvLines(existingLines, desiredLines) {
  const desired = /* @__PURE__ */ new Map();
  const rawDesiredLines = [];
  for (const line of desiredLines) {
    const key = readEnvLineKey(line);
    if (key) {
      desired.set(key, line);
    } else {
      rawDesiredLines.push(line);
    }
  }
  const written = /* @__PURE__ */ new Set();
  for (const [index, line] of existingLines.entries()) {
    const key = readEnvLineKey(line);
    if (!key || !desired.has(key)) continue;
    existingLines[index] = desired.get(key);
    written.add(key);
  }
  for (const [key, line] of desired) {
    if (!written.has(key)) existingLines.push(line);
  }
  existingLines.push(...rawDesiredLines);
}
function parseGeneratedYamlObject(existing, target) {
  if (!existing || existing.trim().length === 0) return {};
  const lines = existing
    .split(/\r?\n/)
    .map((line, index) => {
      if (isIgnorableGeneratedYamlLine(line)) return null;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      return { indent, text: line.slice(indent), lineNumber: index + 1 };
    })
    .filter((line) => line !== null);
  if (lines.length === 0) return {};
  const [parsed, nextIndex] = parseGeneratedYamlBlock(lines, 0, lines[0]?.indent ?? 0, target);
  if (nextIndex !== lines.length || !isObject2(parsed)) {
    throw new MessagingBuildApplierError(`Messaging YAML target ${target} must contain an object.`);
  }
  return parsed;
}
function isIgnorableGeneratedYamlLine(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...";
}
function parseGeneratedYamlBlock(lines, startIndex, indent, target) {
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
function parseGeneratedYamlMap(lines, startIndex, indent, target) {
  const parsed = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
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
function parseGeneratedYamlArray(lines, startIndex, indent, target) {
  const parsed = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
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
function parseGeneratedYamlScalar(value, target, lineNumber) {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has invalid quoted scalar at line ${lineNumber}: ${formatError(error)}`,
      );
    }
  }
  return value;
}
function serializeGeneratedYamlObject(value) {
  return serializeGeneratedYamlValue(value);
}
function serializeGeneratedYamlValue(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0)
      return `${pad}[]
`;
    let out = "";
    for (const item of value) {
      if (isObject2(item)) {
        out += `${pad}-
`;
        out += serializeGeneratedYamlValue(item, indent + 1);
      } else if (Array.isArray(item)) {
        out += `${pad}-
`;
        out += serializeGeneratedYamlValue(item, indent + 1);
      } else {
        out += `${pad}- ${formatGeneratedYamlScalar(item)}
`;
      }
    }
    return out;
  }
  if (isObject2(value)) {
    let out = "";
    for (const [key, item] of Object.entries(value)) {
      assertSafeObjectKey(key, "Messaging YAML object");
      if (Array.isArray(item)) {
        out +=
          item.length === 0
            ? `${pad}${key}: []
`
            : `${pad}${key}:
${serializeGeneratedYamlValue(item, indent + 1)}`;
      } else if (isObject2(item)) {
        const entries = Object.entries(item);
        out +=
          entries.length === 0
            ? `${pad}${key}: {}
`
            : `${pad}${key}:
${serializeGeneratedYamlValue(item, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${formatGeneratedYamlScalar(item)}
`;
      }
    }
    return out;
  }
  return `${pad}${formatGeneratedYamlScalar(value)}
`;
}
function formatGeneratedYamlScalar(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return JSON.stringify(value);
  if (value === "") return JSON.stringify(value);
  if (/[:{}\[\],&*?|>!%@`#'\"]/.test(value) || value.includes("\n") || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}
function isTruthyEnv(value) {
  if (!value || value.trim() === "") return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
function requiredSerializableValue(value, label) {
  if (value === void 0) {
    throw new MessagingBuildApplierError(`Messaging ${label} is missing`);
  }
  return value;
}
function assertSafeObjectKey(key, context) {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new MessagingBuildApplierError(`${context} rejected unsafe object key ${key}`);
  }
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringRecord(value) {
  return isObject2(value) && Object.values(value).every((item) => typeof item === "string");
}
function uniqueStrings2(values) {
  return [...new Set(values)];
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function applyMessagingBuildPhase(plan, phase, env = process.env, options = {}) {
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
    installMessagingPackages(plan, env);
    return [];
  }
  const applyPostAgentInstallOutputs = () => [
    ...applyMessagingAgentRenderToLocalFiles(plan),
    ...applyPostAgentInstallBuildFilesToLocalFiles(plan),
  ];
  const appliedTargets = applyPostAgentInstallOutputs();
  if (
    plan &&
    effectiveBuildProfile(plan).postRenderRepair !== void 0 &&
    !options.managedStartupRuntime
  ) {
    runMessagingPostRenderRepair(plan, env);
    return uniqueStrings2([...appliedTargets, ...applyPostAgentInstallOutputs()]);
  }
  return uniqueStrings2(appliedTargets);
}
function installMessagingPackages(plan, env) {
  if (!plan) return;
  const managers = effectiveBuildProfile(plan).packageManagers;
  if (managers.includes("node-package")) installOpenClawMessagingPlugins(plan, env);
  if (managers.includes("python-package")) installHermesMessagingUvPackages(plan, env);
}
function installHermesMessagingUvPackages(plan, env) {
  const selectedPackages = collectHermesMessagingUvPackageInstalls(plan).map(
    (install) => install.spec,
  );
  installHermesUvPackages(selectedPackages, env);
}
function installHermesUvPackages(selectedPackages, env) {
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
function installManagedImageCapabilityUnion(agent, env = process.env) {
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
function describeMessagingBuildPhase(plan, phase, env) {
  return {
    agent: plan?.agent ?? "unknown",
    phase,
    channels: activeChannels(plan),
    runtimePlanPath: phase === "runtime-setup" ? messagingRuntimePlanPath(env) : "",
    doctorEnv:
      plan && effectiveBuildProfile(plan).postRenderRepair !== void 0
        ? messagingRepairEnvOverrides(plan, env)
        : {},
    installSpecs:
      plan && effectiveBuildProfile(plan).packageManagers.includes("node-package")
        ? collectOpenClawMessagingPluginInstallSpecs(plan, env)
        : [],
    hermesUvPackages:
      plan && effectiveBuildProfile(plan).packageManagers.includes("python-package")
        ? collectHermesMessagingUvPackages(plan)
        : [],
    openclawVersion: env.OPENCLAW_VERSION || "",
  };
}
function main(argv = process.argv.slice(2)) {
  const { agent, phase, dryRun, managedStartupRuntime, mode } = parseMessagingBuildArgs(argv);
  const plan = readMessagingBuildPlanFromEnv(process.env, agent);
  if (phase === "managed-image-capability-union") {
    if (plan) {
      throw new MessagingBuildApplierError(
        "Managed-image capability union must be built without a serialized messaging plan",
      );
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
            installSpecs:
              agent === "openclaw"
                ? collectManagedImageOpenClawPluginInstallSpecs(process.env)
                : [],
            hermesUvPackages: agent === "hermes" ? collectManagedImageHermesUvPackages() : [],
            openclawVersion: process.env.OPENCLAW_VERSION || "",
          },
          null,
          2,
        ),
      );
      return;
    }
    installManagedImageCapabilityUnion(agent, process.env);
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify(describeMessagingBuildPhase(plan, phase, process.env), null, 2));
    return;
  }
  applyMessagingBuildPhase(plan, phase, process.env, { managedStartupRuntime, mode });
}
function parseMessagingBuildArgs(argv) {
  let agent;
  let phase;
  let dryRun = false;
  let managedStartupRuntime = false;
  let mode = "apply";
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
    agent: agent ?? "openclaw",
    phase: resolvedPhase,
    dryRun,
    managedStartupRuntime,
    mode,
  };
}
function readApplyModeArg(value) {
  if (value === "apply" || value === "clear") {
    return value;
  }
  throw new MessagingBuildApplierError("--mode must be 'apply' or 'clear'");
}
function readAgentArg(value) {
  const agent = sanitizeOptionalString(value);
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(agent)) return agent;
  throw new MessagingBuildApplierError("--agent must be a canonical package id");
}
function readPhaseArg(value) {
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
function isMainModule2() {
  return process.argv[1]
    ? import.meta.url === pathToFileURL2(resolve2(process.argv[1])).href
    : false;
}
if (isMainModule2()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
export {
  DEFAULT_MESSAGING_RUNTIME_PLAN_PATH,
  MessagingBuildApplierError,
  OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY,
  activeChannels,
  applyMessagingAgentRenderToEnvLines,
  applyMessagingAgentRenderToLocalFiles,
  applyMessagingAgentRenderToObject,
  applyMessagingBuildPhase,
  applyPostAgentInstallBuildFilesToLocalFiles,
  buildMessagingRuntimePlanArtifact,
  collectHermesMessagingUvPackages,
  collectManagedImageHermesUvPackages,
  collectManagedImageOpenClawPluginInstallSpecs,
  collectOpenClawMessagingPluginInstallSpecs,
  describeMessagingBuildPhase,
  installManagedImageCapabilityUnion,
  installMessagingPackages,
  installOpenClawMessagingPlugins,
  main,
  messagingRepairEnvOverrides,
  messagingRuntimePlanPath,
  readMessagingBuildPlanFromEnv,
  requireWritableRuntimeInstallCache,
  reviewedOpenClawPluginIntegrityByPackageSpec,
  reviewedOpenClawPluginTarballUrlByPackageSpec,
  runMessagingPostRenderRepair,
  writeMessagingRuntimePlanArtifact,
};
