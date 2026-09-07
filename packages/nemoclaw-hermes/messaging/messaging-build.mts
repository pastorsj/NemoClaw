// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Generated from the generic NemoClaw messaging build contract; do not edit by hand.

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

// scripts/lib/reviewed-npm-archive.mts
import { spawnSync } from "node:child_process";
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
var NPM_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024,
  EXACT_NPM_PACKAGE_SPEC =
    /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
function runNpm(args, request) {
  let result = spawnSync(request.npmExecutable ?? "npm", args, {
    encoding: "utf-8",
    env: request.env,
    maxBuffer: NPM_OUTPUT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${request.label} npm ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}
function requireReviewedRequest(request) {
  if (!EXACT_NPM_PACKAGE_SPEC.test(request.packageSpec))
    throw new Error(`${request.label} must use an exact npm package spec: ${request.packageSpec}`);
  if (!request.expectedIntegrity.startsWith("sha512-"))
    throw new Error(`${request.label} must use a committed sha512 npm integrity value`);
  if (!request.tarballUrl) throw new Error(`${request.label} must use a committed npm tarball URL`);
}
function verifyReviewedNpmMetadata(request, npmRunner = runNpm) {
  requireReviewedRequest(request);
  let integrity = npmRunner(["view", request.packageSpec, "dist.integrity"], request).trim();
  if (integrity !== request.expectedIntegrity)
    throw new Error(
      `${request.label} npm integrity mismatch
Expected: ${request.expectedIntegrity}
Actual:   ${integrity}`,
    );
  let tarballUrl = npmRunner(["view", request.packageSpec, "dist.tarball"], request).trim();
  if (tarballUrl !== request.tarballUrl)
    throw new Error(
      `${request.label} npm tarball URL mismatch
Expected: ${request.tarballUrl}
Actual:   ${tarballUrl}`,
    );
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
  )
    throw new Error(`npm pack ${packageSpec} reported unsafe archive filename: ${filename}`);
  let root = resolve(rootDirectory),
    archivePath = resolve(root, filename);
  if (!archivePath.startsWith(`${root}${sep}`))
    throw new Error(
      `npm pack ${packageSpec} reported archive path outside pack directory: ${filename}`,
    );
  if (!existsSync(archivePath))
    throw new Error(`npm pack ${packageSpec} did not create reported archive: ${filename}`);
  let archive = lstatSync(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink())
    throw new Error(`npm pack ${packageSpec} reported a non-file archive: ${filename}`);
  return archivePath;
}
function packReviewedNpmArchive(request, npmRunner = runNpm) {
  verifyReviewedNpmMetadata(request, npmRunner);
  let rootDirectory = mkdtempSync(
    join(request.tempDirectory ?? tmpdir(), "nemoclaw-reviewed-npm-pack-"),
  );
  try {
    let packJson = npmRunner(
        ["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"],
        request,
      ),
      parsed;
    try {
      parsed = JSON.parse(packJson);
    } catch (error) {
      throw new Error(`npm pack ${request.packageSpec} did not return JSON: ${String(error)}`);
    }
    let entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : void 0,
      filename =
        typeof entry == "object" && entry !== null && "filename" in entry
          ? String(entry.filename ?? "")
          : "",
      actualIntegrity =
        typeof entry == "object" && entry !== null && "integrity" in entry
          ? String(entry.integrity ?? "")
          : "";
    if (!filename || !actualIntegrity)
      throw new Error(`npm pack ${request.packageSpec} did not report filename and integrity`);
    if (actualIntegrity !== request.expectedIntegrity)
      throw new Error(
        `${request.label} downloaded tarball integrity mismatch
Expected: ${request.expectedIntegrity}
Actual:   ${actualIntegrity}`,
      );
    return {
      archivePath: resolveReviewedNpmArchivePath(request.packageSpec, rootDirectory, filename),
      rootDirectory,
    };
  } catch (error) {
    throw (rmSync(rootDirectory, { recursive: !0, force: !0 }), error);
  }
}

// src/lib/messaging/channels/package-built-ins.ts
var package_built_ins_default = Object.freeze([]);

// src/lib/messaging/applier/package-credential-cleanup.ts
var EXPORT_PREFIX = /^export[ \t]+/;
function readEnvLineKey(line) {
  let index = line.indexOf("=");
  if (index <= 0) return null;
  let key = line.slice(0, index).trim().replace(EXPORT_PREFIX, "").trim();
  return key.length > 0 ? key : null;
}
function ownedCredentialEnvKeys(plan) {
  return new Set(
    plan.credentialBindings.flatMap((binding) =>
      typeof binding.providerEnvKey == "string" && binding.providerEnvKey.length > 0
        ? [binding.providerEnvKey]
        : [],
    ),
  );
}
function staleCredentialEnvKeys(plan, rendered) {
  return new Set([...ownedCredentialEnvKeys(plan)].filter((key) => !rendered.has(key)));
}
function migrationOnlyEnvTargets(plan, renderedTargets) {
  if (ownedCredentialEnvKeys(plan).size === 0) return [];
  let targets = (plan.agentRender ?? [])
    .filter((entry) => entry.kind === "env-lines")
    .map((entry) => entry.target);
  return [...new Set(targets)].filter((target) => !renderedTargets.has(target));
}

// src/lib/messaging/applier/rendered-plugin-allow.ts
function isObject(value) {
  return typeof value == "object" && value !== null && !Array.isArray(value);
}
function enabledPluginId(render) {
  let segments = render.path?.split(".").filter(Boolean) ?? [];
  return segments.length !== 3 ||
    segments[0] !== "plugins" ||
    segments[1] !== "entries" ||
    !isObject(render.value) ||
    render.value.enabled !== !0
    ? null
    : (segments[2] ?? null);
}
function allowRenderedPlugins(config, renderEntries) {
  let renderedPluginIds = renderEntries.flatMap((render) => {
    let pluginId = enabledPluginId(render);
    return pluginId ? [pluginId] : [];
  });
  if (renderedPluginIds.length === 0) return;
  let plugins = config.plugins;
  if (!isObject(plugins)) throw new Error("Messaging render requires a plugins object.");
  let existingAllow = plugins.allow;
  if (existingAllow !== void 0 && !Array.isArray(existingAllow))
    throw new Error("Messaging plugins.allow must be an array.");
  let allowedPluginIds = (existingAllow ?? []).filter((pluginId) => typeof pluginId == "string");
  plugins.allow = [.../* @__PURE__ */ new Set([...allowedPluginIds, ...renderedPluginIds])];
}

// src/lib/messaging/post-agent-install-selection.ts
function normalizeMessagingChannelId(channelId) {
  return channelId.trim().toLowerCase();
}
function enabledPlanChannels(plan) {
  let disabled = new Set(
    (plan.disabledChannels ?? []).map(normalizeMessagingChannelId).filter(Boolean),
  );
  return plan.channels.filter((channel) => {
    let channelId = normalizeMessagingChannelId(channel.channelId);
    return channelId.length > 0 && channel.active && !channel.disabled && !disabled.has(channelId);
  });
}
function selectActiveMessagingChannelIds(plan) {
  let seen = /* @__PURE__ */ new Set(),
    channels = [];
  for (let item of enabledPlanChannels(plan)) {
    let channel = normalizeMessagingChannelId(item.channelId);
    !channel || seen.has(channel) || (seen.add(channel), channels.push(channel));
  }
  return channels;
}
function selectEnabledMessagingAgentRender(plan) {
  let active = new Set(selectActiveMessagingChannelIds(plan));
  return plan.agentRender.filter(
    (render) =>
      render.agent === plan.agent && active.has(normalizeMessagingChannelId(render.channelId)),
  );
}
function selectEnabledPostAgentInstallBuildFiles(plan) {
  let active = new Set(selectActiveMessagingChannelIds(plan)),
    channels = enabledPlanChannels(plan);
  return plan.buildSteps.filter((step) => {
    let channelId = normalizeMessagingChannelId(step.channelId);
    if (!active.has(channelId) || step.kind !== "build-file") return !1;
    if (!step.hookId) return !0;
    let matchingChannels = channels.filter(
      (channel) => normalizeMessagingChannelId(channel.channelId) === channelId,
    );
    if (matchingChannels.length !== 1) return !1;
    let matchedHook = matchingChannels[0]?.hooks?.find((hook) => hook.id === step.hookId);
    return matchedHook !== void 0 && matchedHook.phase === "post-agent-install";
  });
}

// src/lib/messaging/applier/build/messaging-build-applier.mts
var NODE_PACKAGE_ARCHIVE_PROVENANCE_POLICY = Object.freeze({
  schemaVersion: 1,
  packageIdentity: "exact-npm-package-spec",
  registryIntegrityField: "dist.integrity",
  packedArchiveIntegrity: "must-match-committed-sri",
  registryTarballField: "dist.tarball",
  registryTarballUrl: "must-match-committed-url",
});
function isPinnedPythonPackageSpec(spec) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*\])?==[A-Za-z0-9][A-Za-z0-9_.!+~-]*$/.test(
    spec,
  );
}
var MessagingBuildApplierError = class extends Error {},
  DEFAULT_MESSAGING_RUNTIME_PLAN_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json";
function readMessagingBuildPlanFromEnv(env, agent) {
  let encoded = env.NEMOCLAW_MESSAGING_PLAN_B64;
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
    typeof parsed.sandboxName != "string" ||
    !Array.isArray(parsed.channels) ||
    !Array.isArray(parsed.credentialBindings) ||
    !Array.isArray(parsed.agentRender) ||
    !Array.isArray(parsed.buildSteps)
  )
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must contain a ${agent} messaging plan`,
    );
  return parsed;
}
function readMessagingRuntimeProfile(profilePath, packageId) {
  if (!isAbsolute2(profilePath))
    throw new MessagingBuildApplierError("--profile must be an absolute path");
  let parsed;
  try {
    let metadata = lstatSync2(profilePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024)
      throw new Error("profile is not a bounded regular file");
    parsed = JSON.parse(readFileSync2(profilePath, "utf8"));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Messaging runtime profile is invalid: ${formatError(error)}`,
    );
  }
  if (
    !isObject2(parsed) ||
    Object.keys(parsed).some((key) => !["packageId", "build", "channelsPath"].includes(key)) ||
    parsed.packageId !== packageId ||
    !isObject2(parsed.build) ||
    typeof parsed.channelsPath != "string" ||
    !/^[a-z][a-z0-9-]*\.json$/u.test(parsed.channelsPath)
  )
    throw new MessagingBuildApplierError(
      "Messaging runtime profile does not match the selected package",
    );
  let channelsPath = resolve2(dirname(profilePath), parsed.channelsPath);
  if (!channelsPath.startsWith(`${dirname(profilePath)}${sep2}`))
    throw new MessagingBuildApplierError("Messaging runtime channel profile escapes its directory");
  let channels;
  try {
    let metadata = lstatSync2(channelsPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024)
      throw new Error("channel profile is not a bounded regular file");
    channels = JSON.parse(readFileSync2(channelsPath, "utf8"));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Messaging channel profile is invalid: ${formatError(error)}`,
    );
  }
  if (!Array.isArray(channels))
    throw new MessagingBuildApplierError("Messaging channel profile must be an array");
  let profile = {
    packageId: parsed.packageId,
    build: parsed.build,
    channels,
  };
  validateBuildProfile(profile.build, !0);
  let channelIds = /* @__PURE__ */ new Set();
  for (let channel of profile.channels) {
    if (
      !isObject2(channel) ||
      typeof channel.channelId != "string" ||
      channelIds.has(channel.channelId)
    )
      throw new MessagingBuildApplierError("Messaging runtime profile has invalid channels");
    if (
      (channelIds.add(channel.channelId),
      !isObject2(channel.lifecycle) || !Array.isArray(channel.lifecycle.packageInstalls ?? []))
    )
      throw new MessagingBuildApplierError(
        "Messaging runtime profile has invalid package installs",
      );
  }
  return profile;
}
function runtimePackageDeclarations(profile, activeChannelIds) {
  return profile.channels.flatMap((channel) =>
    activeChannelIds && !activeChannelIds.has(channel.channelId)
      ? []
      : (channel.lifecycle.packageInstalls ?? []).map((install) => ({
          channelId: channel.channelId,
          ...install,
        })),
  );
}
function resolveRuntimePackageSpec(spec, profile, env) {
  let versionEnvironment =
      profile.build.packageInstallers?.["node-package"]?.packageVersionEnvironment,
    version = versionEnvironment ? sanitizeOptionalString(env[versionEnvironment]) : "",
    resolved = spec.replaceAll("{{package.version}}", () => {
      if (!version)
        throw new MessagingBuildApplierError(
          `${versionEnvironment ?? "Package version environment"} is required for the package version template`,
        );
      return version;
    });
  if (/\{\{\s*[^}]+\s*\}\}/u.test(resolved))
    throw new MessagingBuildApplierError(`Unresolved package-install template in ${spec}`);
  return resolved;
}
function selectedRuntimePackageDeclarations(plan, profile) {
  let declarations = runtimePackageDeclarations(profile, new Set(activeChannels(plan)));
  return enabledBuildStepsForPhase(plan, "agent-install")
    .filter((step) => step.kind === "package-install" && step.value !== void 0)
    .map((step) => {
      let value = step.value,
        manager = readMessagingPackageManager(value, step.outputId),
        declared = declarations.find(
          (candidate) =>
            candidate.channelId === step.channelId &&
            candidate.id === step.outputId &&
            candidate.manager === manager &&
            candidate.spec === value.spec,
        );
      if (!declared)
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is not declared by the package runtime profile`,
        );
      return declared;
    });
}
function collectRuntimeNodePackages(plan, profile, env, allChannels = !1) {
  let declarations = (
      allChannels
        ? runtimePackageDeclarations(profile)
        : selectedRuntimePackageDeclarations(plan, profile)
    ).filter((install) => install.manager === "node-package"),
    seen = /* @__PURE__ */ new Set(),
    installs = [];
  for (let declaration of declarations) {
    let spec = resolveRuntimePackageSpec(declaration.spec, profile, env),
      npmPackage = requireExactNpmPackageSpec(spec, declaration.channelId),
      integrity = declaration.integrity ?? declaration.integrityByVersion?.[npmPackage.version],
      tarballUrl = declaration.tarballUrl ?? declaration.tarballUrlByVersion?.[npmPackage.version];
    if (declaration.pin !== !0 || !integrity || !tarballUrl)
      throw new MessagingBuildApplierError(
        `Managed messaging package ${npmPackage.packageSpec} must have a committed integrity pin and tarball URL`,
      );
    seen.has(npmPackage.packageSpec) ||
      (seen.add(npmPackage.packageSpec),
      installs.push({
        spec,
        npmPackageSpec: npmPackage.packageSpec,
        integrity,
        tarballUrl,
        ...(declaration.runtimeLock ? { runtimeLock: declaration.runtimeLock } : {}),
        pin: !0,
      }));
  }
  return installs;
}
function collectRuntimePythonPackages(plan, profile, allChannels = !1) {
  let declarations = (
      allChannels
        ? runtimePackageDeclarations(profile)
        : selectedRuntimePackageDeclarations(plan, profile)
    ).filter((install) => install.manager === "python-package"),
    specs = /* @__PURE__ */ new Set();
  for (let declaration of declarations) {
    if (!isPinnedPythonPackageSpec(declaration.spec))
      throw new MessagingBuildApplierError(
        `Messaging Python package must use a safe exact-pinned package spec: ${declaration.spec}`,
      );
    specs.add(declaration.spec);
  }
  return [...specs].map((spec) => ({ spec }));
}
function applyMessagingAgentRenderToLocalFiles(plan, options = {}) {
  if (!plan) return [];
  let appliedTargets = [],
    grouped = /* @__PURE__ */ new Map();
  for (let render of enabledAgentRender(plan)) {
    let entries = grouped.get(render.target) ?? [];
    (entries.push(render), grouped.set(render.target, entries));
  }
  for (let target of migrationOnlyEnvTargets(plan, new Set(grouped.keys())))
    grouped.set(target, []);
  for (let [target, renderEntries] of grouped) {
    let kinds = uniqueStrings(renderEntries.map((entry) => entry.kind));
    if (kinds.length > 1)
      throw new MessagingBuildApplierError(
        `Cannot apply mixed messaging render kinds to ${target}.`,
      );
    kinds[0] === "json-fragment"
      ? appliedTargets.push(applyJsonRenderEntriesToLocalFile(plan, target, renderEntries, options))
      : appliedTargets.push(applyEnvRenderEntriesToLocalFile(plan, target, renderEntries, options));
  }
  return uniqueStrings(appliedTargets);
}
function activeChannels(plan) {
  return plan ? selectActiveMessagingChannelIds(plan) : [];
}
function messagingRuntimePlanPath(env = process.env) {
  return env.NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH?.trim() || DEFAULT_MESSAGING_RUNTIME_PLAN_PATH;
}
function buildMessagingRuntimePlanArtifact(plan) {
  return plan
    ? {
        schemaVersion: 1,
        sandboxName: plan.sandboxName,
        agent: plan.agent,
        ...(typeof plan.workflow == "string" && plan.workflow ? { workflow: plan.workflow } : {}),
        channels: sanitizeRuntimeArtifactChannels(plan.channels),
        disabledChannels: sanitizeStringArray(plan.disabledChannels ?? []),
        credentialBindings: sanitizeRuntimeArtifactCredentialBindings(plan.credentialBindings),
        runtimeSetup: sanitizeRuntimeSetup(plan.runtimeSetup),
      }
    : null;
}
function writeMessagingRuntimePlanArtifact(plan, targetPath) {
  let artifact = buildMessagingRuntimePlanArtifact(plan);
  return artifact
    ? (mkdirSync(dirname(targetPath), { recursive: !0 }),
      writeFileSync(
        targetPath,
        `${JSON.stringify(artifact, null, 2)}
`,
      ),
      chmodSync(targetPath, 420),
      targetPath)
    : null;
}
function sanitizeRuntimeArtifactChannels(channels) {
  return channels.flatMap((channel) => {
    let channelId = sanitizeOptionalString(channel.channelId);
    return channelId
      ? [
          {
            channelId,
            active: channel.active === !0,
            disabled: channel.disabled === !0,
          },
        ]
      : [];
  });
}
function sanitizeRuntimeArtifactCredentialBindings(bindings) {
  return bindings.flatMap((binding) => {
    let channelId = sanitizeOptionalString(binding.channelId),
      providerEnvKey = sanitizeOptionalString(binding.providerEnvKey);
    return !channelId || !providerEnvKey ? [] : [{ channelId, providerEnvKey }];
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
  return Array.isArray(entries)
    ? entries.map((entry, index) => {
        if (!isObject2(entry))
          throw new MessagingBuildApplierError(
            `Messaging runtime setup entry ${index} must be an object`,
          );
        let channelId = sanitizeOptionalString(entry.channelId);
        if (!channelId)
          throw new MessagingBuildApplierError(
            `Messaging runtime setup entry ${index} must include channelId`,
          );
        let sanitized = { channelId };
        for (let key of allowedKeys)
          key === "channelId" ||
            entry[key] === void 0 ||
            (sanitized[key] = cloneRuntimeArtifactValue(
              entry[key],
              `runtime setup entry ${index}.${key}`,
            ));
        return sanitized;
      })
    : [];
}
function cloneRuntimeArtifactValue(value, label) {
  if (
    value === null ||
    typeof value == "string" ||
    typeof value == "number" ||
    typeof value == "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value.map((entry, index) =>
      cloneRuntimeArtifactValue(entry, `${label}[${String(index)}]`),
    );
  if (isObject2(value))
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, entry]) => (
          assertSafeObjectKey(key, label),
          [key, cloneRuntimeArtifactValue(entry, `${label}.${key}`)]
        ),
      ),
    );
  throw new MessagingBuildApplierError(`${label} must be JSON-serializable`);
}
function sanitizeStringArray(values) {
  let seen = /* @__PURE__ */ new Set(),
    out = [];
  for (let value of values) {
    let clean = sanitizeOptionalString(value);
    !clean || seen.has(clean) || (seen.add(clean), out.push(clean));
  }
  return out;
}
function sanitizeOptionalString(value) {
  return typeof value == "string" ? value.trim() : "";
}
function messagingRepairEnvOverrides(plan, env = process.env) {
  let overrides = {};
  if (plan) {
    let active = new Set(activeChannels(plan));
    for (let binding of plan.credentialBindings)
      active.has(binding.channelId) &&
        typeof binding.providerEnvKey == "string" &&
        typeof binding.placeholder == "string" &&
        (overrides[binding.providerEnvKey] = binding.placeholder);
  }
  if (isTruthyEnv(env.NEMOCLAW_WEB_SEARCH_ENABLED)) {
    let provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "brave").trim();
    if (provider === "brave") overrides.BRAVE_API_KEY = "openshell:resolve:env:BRAVE_API_KEY";
    else if (provider === "tavily")
      overrides.TAVILY_API_KEY = "openshell:resolve:env:TAVILY_API_KEY";
    else
      throw new MessagingBuildApplierError(
        `Unsupported NEMOCLAW_WEB_SEARCH_PROVIDER: ${provider || "<empty>"}`,
      );
  }
  return overrides;
}
function requireWritableRuntimeInstallCache(runtimeLock, env) {
  let configured = sanitizeOptionalString(env[runtimeLock.installCacheEnvKey]);
  if (!configured)
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must name the sandbox-writable temporary npm cache prepared from ${runtimeLock.cachePath}`,
    );
  if (!isAbsolute2(configured))
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must be an absolute path`,
    );
  let installCache;
  try {
    if (lstatSync2(configured).isSymbolicLink()) throw new Error("symbolic links are not allowed");
    if (((installCache = realpathSync(configured)), !statSync(installCache).isDirectory()))
      throw new Error("path is not a directory");
    accessSync(installCache, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must be a writable, searchable directory: ${formatError(error)}`,
    );
  }
  let trustedCache = existsSync2(runtimeLock.cachePath)
    ? realpathSync(runtimeLock.cachePath)
    : resolve2(runtimeLock.cachePath);
  if (installCache === trustedCache || installCache.startsWith(`${trustedCache}${sep2}`))
    throw new MessagingBuildApplierError(
      `${runtimeLock.installCacheEnvKey} must not make the trusted npm cache writable`,
    );
  return installCache;
}
function runMessagingPostRenderRepair(plan, env) {
  if (!plan) return;
  let repair = effectiveBuildProfile(plan).postRenderRepair;
  repair &&
    runCommand(repair.command, {
      ...env,
      ...messagingRepairEnvOverrides(plan, env),
    });
}
function applyPostAgentInstallBuildFilesToLocalFiles(plan, options = {}) {
  let appliedTargets = [];
  for (let step of enabledBuildStepsForPhase(plan, "post-agent-install"))
    if (step.kind === "build-file") {
      if (step.value === void 0) {
        if (step.required)
          throw new MessagingBuildApplierError(
            `Messaging build-file output ${step.outputId} is missing`,
          );
        continue;
      }
      appliedTargets.push(
        applyBuildFileOutputToLocalAgentRoot(plan, readBuildFileOutput(step.value), options),
      );
    }
  return uniqueStrings(appliedTargets);
}
function applyJsonRenderEntriesToLocalFile(plan, target, renderEntries, options) {
  let targetPath = resolveAgentRenderTarget(plan, target, options),
    config = targetPath.endsWith(".yaml")
      ? parseGeneratedYamlObject(readTextIfExists(targetPath), targetPath)
      : parseJsonObject(readTextIfExists(targetPath), targetPath);
  return (
    applyMessagingRenderEntriesToObject(config, renderEntries, target, plan),
    mkdirSync(dirname(targetPath), { recursive: !0 }),
    writeFileSync(
      targetPath,
      targetPath.endsWith(".yaml")
        ? serializeGeneratedYamlObject(config)
        : `${JSON.stringify(config, null, 2)}
`,
    ),
    chmodSync(targetPath, 384),
    targetPath
  );
}
function applyEnvRenderEntriesToLocalFile(plan, target, renderEntries, options) {
  let targetPath = resolveAgentRenderTarget(plan, target, options),
    envLines =
      readTextIfExists(targetPath)
        ?.split(/\r?\n/)
        .filter((line) => line.length > 0) ?? [],
    rendered = /* @__PURE__ */ new Set();
  for (let render of renderEntries) {
    if (!Array.isArray(render.lines))
      throw new MessagingBuildApplierError(
        `Messaging env render '${render.renderId ?? render.channelId}' is missing lines.`,
      );
    let lines = readEnvRenderLines(render);
    for (let line of lines) {
      let key = readEnvLineKey(line);
      key && rendered.add(key);
    }
    mergeEnvLines(envLines, lines);
  }
  let stale = staleCredentialEnvKeys(plan, rendered),
    keptLines = envLines.filter((line) => {
      let key = readEnvLineKey(line);
      return key === null || !stale.has(key);
    });
  return (
    mkdirSync(dirname(targetPath), { recursive: !0 }),
    writeFileSync(
      targetPath,
      keptLines.length > 0
        ? `${keptLines.join(`
`)}
`
        : "",
    ),
    chmodSync(targetPath, 384),
    targetPath
  );
}
function applyMessagingRenderEntriesToObject(config, renderEntries, target, plan) {
  let rules = credentialPlaceholderRules(plan);
  for (let render of renderEntries) {
    if (render.kind !== "json-fragment" || typeof render.path != "string")
      throw new MessagingBuildApplierError(
        `Messaging render for ${target} must be a JSON fragment with a path.`,
      );
    let value = preserveCredentialPlaceholders(
      requiredSerializableValue(render.value, "render value"),
      getJsonPath(config, render.path),
      rules,
    );
    setJsonPath(config, render.path, value);
  }
  applyDeclaredRenderFinalizers(config, renderEntries, plan);
}
function applyDeclaredRenderFinalizers(config, renderEntries, plan) {
  let finalizers = effectiveBuildProfile(plan).renderFinalizers ?? [];
  (finalizers.includes("allow-rendered-plugins") && allowRenderedPlugins(config, renderEntries),
    finalizers.includes("inherit-api-server-toolsets") && inheritApiServerToolsets(config));
}
function readEnvRenderLines(render) {
  if (!Array.isArray(render.lines))
    throw new MessagingBuildApplierError(
      "Messaging env render '" + (render.renderId ?? render.channelId) + "' is missing lines.",
    );
  for (let line of render.lines)
    if (/[\r\n]/.test(line))
      throw new MessagingBuildApplierError(
        "Messaging env render '" +
          (render.renderId ?? render.channelId) +
          "' must not contain line breaks.",
      );
  return render.lines;
}
function inheritApiServerToolsets(config) {
  let platforms = config.platforms,
    platformToolsets = config.platform_toolsets;
  if (!isObject2(platforms) || !isObject2(platformToolsets)) return;
  let apiServerToolsets = platformToolsets.api_server;
  if (Array.isArray(apiServerToolsets))
    for (let [platform, platformConfig] of Object.entries(platforms))
      platform === "api_server" ||
        !isObject2(platformConfig) ||
        platformConfig.enabled !== !0 ||
        Array.isArray(platformToolsets[platform]) ||
        (platformToolsets[platform] = [...apiServerToolsets]);
}
function resolveAgentRenderTarget(plan, target, options = {}) {
  let home = options.homeDir ?? homedir(),
    configRoot = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home),
    normalizedRoot = resolve2(configRoot);
  if (target.startsWith("~/")) {
    let resolvedTarget2 = resolve2(home, target.slice(2));
    if (
      resolvedTarget2 === normalizedRoot ||
      !resolvedTarget2.startsWith(`${normalizedRoot}${sep2}`)
    )
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
      );
    return resolvedTarget2;
  }
  let relativeTarget = normalizeBuildFilePath(target),
    resolvedTarget = resolve2(configRoot, relativeTarget);
  if (!resolvedTarget.startsWith(`${normalizedRoot}${sep2}`))
    throw new MessagingBuildApplierError(
      `Messaging render target ${target} must stay inside ${effectiveBuildProfile(plan).configRoot}.`,
    );
  return resolvedTarget;
}
function effectiveBuildProfile(plan) {
  if (plan.packageBuild) return validateBuildProfile(plan.packageBuild);
  throw new MessagingBuildApplierError(
    "Receipt-backed messaging plan is missing its package build profile",
  );
}
var legacyBuildProfile = void 0;
function validateBuildProfile(profile, requireInstallers = !1) {
  if (!/^~\/[A-Za-z0-9._-]+$/u.test(profile.configRoot))
    throw new MessagingBuildApplierError("Messaging build profile has an unsafe config root");
  if (
    profile.packageManagers.some(
      (manager) => manager !== "node-package" && manager !== "python-package",
    )
  )
    throw new MessagingBuildApplierError(
      "Messaging build profile has an unsupported package manager",
    );
  for (let manager of requireInstallers ? profile.packageManagers : []) {
    let installer = profile.packageInstallers?.[manager];
    if (!installer)
      throw new MessagingBuildApplierError(
        `Messaging build profile is missing its ${manager} installer`,
      );
    let placeholder = manager === "node-package" ? "{{archive}}" : "{{packages}}";
    if (
      !Array.isArray(installer.command) ||
      installer.command.length < 2 ||
      installer.command.length > 16 ||
      installer.command.filter((argument) => argument === placeholder).length !== 1 ||
      installer.command.some(
        (argument) =>
          typeof argument != "string" ||
          argument.length === 0 ||
          argument.length > 8192 ||
          (/\{\{/u.test(argument) && argument !== placeholder),
      )
    )
      throw new MessagingBuildApplierError(`Messaging ${manager} installer has an invalid command`);
  }
  for (let manager of ["node-package", "python-package"])
    if (profile.packageInstallers?.[manager] && !profile.packageManagers.includes(manager))
      throw new MessagingBuildApplierError(
        `Messaging build profile has an undeclared ${manager} installer`,
      );
  let nodeVersionEnvironment =
    profile.packageInstallers?.["node-package"]?.packageVersionEnvironment;
  if (nodeVersionEnvironment !== void 0 && !/^[A-Z_][A-Z0-9_]*$/u.test(nodeVersionEnvironment))
    throw new MessagingBuildApplierError(
      "Messaging node package installer has an invalid version environment key",
    );
  let pythonEnvironment = profile.packageInstallers?.["python-package"]?.environment ?? {};
  for (let [key, value] of Object.entries(pythonEnvironment))
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\r\n\0]/u.test(value) ||
      /(?:openshell:resolve|\{\{|\}\}|token|secret|password|api[_-]?key)/iu.test(value)
    )
      throw new MessagingBuildApplierError(
        "Messaging Python package installer has an invalid fixed environment",
      );
  let repair = profile.postRenderRepair;
  if (
    repair !== void 0 &&
    (!isObject2(repair) ||
      Object.keys(repair).some((key) => key !== "command") ||
      !Array.isArray(repair.command) ||
      repair.command.length === 0 ||
      repair.command.length > 16 ||
      repair.command.some(
        (argument) =>
          typeof argument != "string" || argument.length === 0 || argument.length > 8192,
      ))
  )
    throw new MessagingBuildApplierError(
      "Messaging build profile has an invalid post-render repair command",
    );
  return profile;
}
function resolveHomeTarget(target, home) {
  if (!target.startsWith("~/"))
    throw new MessagingBuildApplierError(`Messaging config root ${target} must be home-relative`);
  let normalizedHome = resolve2(home),
    resolvedTarget = resolve2(home, target.slice(2));
  if (resolvedTarget === normalizedHome || !resolvedTarget.startsWith(`${normalizedHome}${sep2}`))
    throw new MessagingBuildApplierError(
      `Messaging config root ${target} must stay inside ${home}`,
    );
  return resolvedTarget;
}
function enabledAgentRender(plan) {
  return selectEnabledMessagingAgentRender(plan);
}
function enabledBuildStepsForPhase(plan, phase) {
  return plan
    ? phase === "post-agent-install"
      ? selectEnabledPostAgentInstallBuildFiles(plan)
      : enabledBuildSteps(plan).filter((step) => buildStepMatchesPhase(plan, step, phase))
    : [];
}
function enabledBuildSteps(plan) {
  let active = new Set(activeChannels(plan));
  return plan.buildSteps.filter((step) => active.has(step.channelId));
}
function buildStepMatchesPhase(plan, step, phase) {
  let hookPhase = step.hookId ? findHookPhase(plan, step.channelId, step.hookId) : void 0;
  return hookPhase
    ? hookPhase === phase
    : phase === "agent-install"
      ? step.kind === "package-install"
      : phase === "post-agent-install"
        ? step.kind === "build-file"
        : !1;
}
function findHookPhase(plan, channelId, hookId) {
  return plan.channels
    .find((candidate) => candidate.channelId === channelId)
    ?.hooks?.find((hook) => hook.id === hookId)?.phase;
}
function applyBuildFileOutputToLocalAgentRoot(plan, file, options = {}) {
  let home = options.homeDir ?? homedir(),
    root = resolveHomeTarget(effectiveBuildProfile(plan).configRoot, home),
    relativePath = normalizeBuildFilePath(file.path),
    target = resolve2(root, relativePath),
    normalizedRoot = resolve2(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep2}`))
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${file.path} must stay inside ${root}`,
    );
  let contents =
    file.merge !== void 0
      ? mergeBuildFileContent(readTextIfExists(target), file.merge, target)
      : serializeBuildFileContent(file.content);
  return (
    mkdirSync(dirname(target), { recursive: !0 }),
    writeFileSync(target, contents),
    file.mode && chmodSync(target, parseBuildFileMode(file.path, file.mode)),
    target
  );
}
function mergeBuildFileContent(existing, patch, target) {
  if (!isObject2(patch))
    throw new MessagingBuildApplierError(
      `Messaging build-file merge for ${target} must be an object.`,
    );
  let root = parseJsonObject(existing, target);
  return (
    mergeJsonObjects(root, patch),
    `${JSON.stringify(root, null, 2)}
`
  );
}
function parseJsonObject(existing, target) {
  if (!existing || existing.trim().length === 0) return {};
  let parsed = JSON.parse(existing);
  if (!isObject2(parsed))
    throw new MessagingBuildApplierError(
      `Messaging build-file target ${target} must contain an object.`,
    );
  return parsed;
}
function readTextIfExists(path) {
  return existsSync2(path) ? readFileSync2(path, "utf-8") : void 0;
}
function readBuildFileOutput(value) {
  if (!isObject2(value))
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  let file = value;
  if (typeof file.path != "string" || file.path.trim().length === 0)
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  if (file.content === void 0 && file.merge === void 0)
    throw new MessagingBuildApplierError(
      `Messaging build-file ${file.path} must include content or merge`,
    );
  if (file.mode !== void 0 && typeof file.mode != "string")
    throw new MessagingBuildApplierError(`Messaging build-file ${file.path} mode must be a string`);
  return file;
}
function normalizeBuildFilePath(pathValue) {
  if (pathValue.startsWith("/") || pathValue.includes("\\") || /[\0-\x1F\x7F]/.test(pathValue))
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must be a safe relative path`,
    );
  if (pathValue.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must not traverse directories`,
    );
  return pathValue;
}
function serializeBuildFileContent(value) {
  return value === void 0
    ? ""
    : typeof value == "string"
      ? value.endsWith(`
`)
        ? value
        : `${value}
`
      : `${JSON.stringify(value, null, 2)}
`;
}
function parseBuildFileMode(pathValue, mode) {
  if (!/^[0-7]{3,4}$/.test(mode) || (mode.length === 4 && mode[0] !== "0"))
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must be an octal file mode`,
    );
  let parsed = Number.parseInt(mode, 8);
  if ((parsed & 18) !== 0)
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must not be group/world writable`,
    );
  return parsed;
}
function readMessagingPackageManager(value, outputId) {
  if (!isObject2(value))
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  let install = value;
  if (install.manager === "node-package" || install.manager === "python-package")
    return install.manager;
  throw new MessagingBuildApplierError(
    `Messaging package-install output ${outputId} has an unsupported package manager`,
  );
}
function parseNpmPackageSpec(spec) {
  if (!spec.startsWith("npm:")) return null;
  let packageSpec = spec.slice(4),
    versionAt = packageSpec.startsWith("@")
      ? packageSpec.indexOf("@", 1)
      : packageSpec.lastIndexOf("@");
  return versionAt <= 0 || versionAt === packageSpec.length - 1
    ? { packageSpec }
    : { packageSpec, version: packageSpec.slice(versionAt + 1) };
}
var EXACT_NPM_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function requireExactNpmPackageSpec(spec, manifestId) {
  let parsed = parseNpmPackageSpec(spec);
  if (!parsed)
    throw new MessagingBuildApplierError(
      `Trusted profile entry ${manifestId} declares a non-npm node package: ${spec}`,
    );
  if (!parsed.version || !EXACT_NPM_VERSION_PATTERN.test(parsed.version))
    throw new MessagingBuildApplierError(
      `Trusted profile entry ${manifestId} must use an exact-version node package: ${spec}`,
    );
  return { packageSpec: parsed.packageSpec, version: parsed.version };
}
function runCommand(args, env) {
  console.log(`+ ${args.join(" ")}`);
  let result = spawnSync2(args[0], args.slice(1), {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new MessagingBuildApplierError(
      `${args[0]} exited with status ${String(result.status ?? "unknown")}`,
    );
}
function packVerifiedNodePackageArchive(install, env, enableRemediation, label = "Node package") {
  if (!install.npmPackageSpec)
    throw new MessagingBuildApplierError(
      `${label} spec ${install.spec} must use an npm: package with committed integrity pin`,
    );
  if (!install.integrity)
    throw new MessagingBuildApplierError(
      `${label} ${install.npmPackageSpec} has no committed npm integrity pin`,
    );
  if (!install.tarballUrl)
    throw new MessagingBuildApplierError(
      `${label} ${install.npmPackageSpec} has no committed npm tarball URL`,
    );
  let archive = packReviewedNpmArchive({
      env,
      expectedIntegrity: install.integrity,
      label: `${label} ${install.npmPackageSpec}`,
      packageSpec: install.npmPackageSpec,
      tarballUrl: install.tarballUrl,
    }),
    exactPackage = requireExactNpmPackageSpec(install.spec, install.npmPackageSpec);
  return {
    archivePath: (enableRemediation
      ? runPackageOwnedNodeArchiveRemediation({
          archivePath: archive.archivePath,
          env,
          packageSpec: exactPackage.packageSpec,
          workingDirectory: archive.rootDirectory,
        })
      : { archivePath: archive.archivePath }
    ).archivePath,
    rootDir: archive.rootDirectory,
  };
}
function runPackageOwnedNodeArchiveRemediation(request) {
  let helper = sanitizeOptionalString(request.env.NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER);
  if (!helper) return { archivePath: request.archivePath };
  if (!isAbsolute2(helper))
    throw new MessagingBuildApplierError(
      "NEMOCLAW_NODE_PACKAGE_REMEDIATION_HELPER must be an absolute path",
    );
  let result = spawnSync2(
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
  if (result.status !== 0)
    throw new MessagingBuildApplierError(
      `Node package remediation helper exited with status ${String(result.status ?? "unknown")}: ${String(result.stderr ?? "").trim()}`,
    );
  let output;
  try {
    output = JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned invalid JSON: ${formatError(error)}`,
    );
  }
  if (!isObject2(output) || typeof output.archivePath != "string")
    throw new MessagingBuildApplierError(
      "Node package remediation helper did not return an archivePath",
    );
  let archivePath = resolve2(output.archivePath),
    workingDirectory = realpathSync(request.workingDirectory);
  if (archivePath !== workingDirectory && !archivePath.startsWith(`${workingDirectory}${sep2}`))
    throw new MessagingBuildApplierError(
      "Node package remediation helper returned an archive outside its working directory",
    );
  try {
    if (lstatSync2(archivePath).isSymbolicLink() || !statSync(archivePath).isFile())
      throw new Error("archive is not a regular file");
  } catch (error) {
    throw new MessagingBuildApplierError(
      `Node package remediation helper returned an unreadable archive: ${formatError(error)}`,
    );
  }
  return { archivePath };
}
function credentialPlaceholderRules(plan) {
  if (!plan) return [];
  let active = new Set(activeChannels(plan));
  return plan.credentialBindings.flatMap((binding) =>
    active.has(binding.channelId)
      ? typeof binding.providerEnvKey != "string" || typeof binding.placeholder != "string"
        ? []
        : [{ envKey: binding.providerEnvKey, placeholder: binding.placeholder }]
      : [],
  );
}
function preserveCredentialPlaceholders(desired, existing, rules) {
  if (typeof desired == "string") {
    let rule = rules.find((candidate) => candidate.placeholder === desired);
    return rule &&
      typeof existing == "string" &&
      isProviderPlaceholderForEnvKey(existing, rule.envKey)
      ? existing
      : desired;
  }
  if (Array.isArray(desired))
    return desired.map((entry, index) =>
      preserveCredentialPlaceholders(
        entry,
        Array.isArray(existing) ? existing[index] : void 0,
        rules,
      ),
    );
  if (isObject2(desired)) {
    let existingObject = isObject2(existing) ? existing : {};
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
  for (let segment of pathValue.split(".").filter(Boolean)) {
    if (!isObject2(cursor)) return;
    cursor = cursor[segment];
  }
  return cursor;
}
function isProviderPlaceholderForEnvKey(value, envKey) {
  let openShellPrefix = "openshell:resolve:env:";
  if (value.startsWith(openShellPrefix))
    return placeholderSuffixMatchesEnvKey(value.slice(openShellPrefix.length), envKey);
  let aliasMatch = value.match(/^[A-Za-z0-9]+-OPENSHELL-RESOLVE-ENV-(.+)$/);
  return aliasMatch ? placeholderSuffixMatchesEnvKey(aliasMatch[1], envKey) : !1;
}
function placeholderSuffixMatchesEnvKey(suffix, envKey) {
  return suffix === envKey ? !0 : suffix.match(/^v[0-9]+_(.+)$/)?.[1] === envKey;
}
function setJsonPath(root, pathValue, value) {
  let segments = pathValue.split(".").filter(Boolean);
  if (segments.length === 0)
    throw new MessagingBuildApplierError("Messaging render path must not be empty");
  let cursor = root;
  for (let segment of segments.slice(0, -1))
    (assertSafeObjectKey(segment, "Messaging render path"),
      isObject2(cursor[segment]) || (cursor[segment] = {}),
      (cursor = cursor[segment]));
  let finalSegment = segments[segments.length - 1];
  if (
    (assertSafeObjectKey(finalSegment, "Messaging render path"),
    isObject2(cursor[finalSegment]) && isObject2(value))
  ) {
    mergeJsonObjects(cursor[finalSegment], value);
    return;
  }
  cursor[finalSegment] = value;
}
function mergeJsonObjects(target, patch) {
  for (let [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new MessagingBuildApplierError(
        "Messaging object merge rejected unsafe object key " + key,
      );
    let existing = target[key];
    isObject2(existing) && isObject2(value)
      ? mergeJsonObjects(existing, value)
      : Array.isArray(existing) && Array.isArray(value)
        ? setMergedObjectValue(target, key, [.../* @__PURE__ */ new Set([...existing, ...value])])
        : setMergedObjectValue(target, key, value);
  }
}
function setMergedObjectValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: !0,
    configurable: !0,
    writable: !0,
  });
}
function mergeEnvLines(existingLines, desiredLines) {
  let desired = /* @__PURE__ */ new Map(),
    rawDesiredLines = [];
  for (let line of desiredLines) {
    let key = readEnvLineKey(line);
    key ? desired.set(key, line) : rawDesiredLines.push(line);
  }
  let written = /* @__PURE__ */ new Set();
  for (let [index, line] of existingLines.entries()) {
    let key = readEnvLineKey(line);
    !key || !desired.has(key) || ((existingLines[index] = desired.get(key)), written.add(key));
  }
  for (let [key, line] of desired) written.has(key) || existingLines.push(line);
  existingLines.push(...rawDesiredLines);
}
function parseGeneratedYamlObject(existing, target) {
  if (!existing || existing.trim().length === 0) return {};
  let lines = existing
    .split(/\r?\n/)
    .map((line, index) => {
      if (isIgnorableGeneratedYamlLine(line)) return null;
      let indent = line.match(/^ */)?.[0].length ?? 0;
      return { indent, text: line.slice(indent), lineNumber: index + 1 };
    })
    .filter((line) => line !== null);
  if (lines.length === 0) return {};
  let [parsed, nextIndex] = parseGeneratedYamlBlock(lines, 0, lines[0]?.indent ?? 0, target);
  if (nextIndex !== lines.length || !isObject2(parsed))
    throw new MessagingBuildApplierError(`Messaging YAML target ${target} must contain an object.`);
  return parsed;
}
function isIgnorableGeneratedYamlLine(line) {
  let trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...";
}
function parseGeneratedYamlBlock(lines, startIndex, indent, target) {
  let first = lines[startIndex];
  if (!first || first.indent < indent) return [{}, startIndex];
  if (first.indent !== indent)
    throw new MessagingBuildApplierError(
      `Messaging YAML target ${target} has unsupported indentation at line ${first.lineNumber}.`,
    );
  return first.text.startsWith("-")
    ? parseGeneratedYamlArray(lines, startIndex, indent, target)
    : parseGeneratedYamlMap(lines, startIndex, indent, target);
}
function parseGeneratedYamlMap(lines, startIndex, indent, target) {
  let parsed = {},
    index = startIndex;
  for (; index < lines.length;) {
    let line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent)
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported indentation at line ${line.lineNumber}.`,
      );
    if (line.text.startsWith("-")) break;
    let colonIndex = line.text.indexOf(":");
    if (colonIndex <= 0)
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported mapping syntax at line ${line.lineNumber}.`,
      );
    let key = line.text.slice(0, colonIndex).trim();
    assertSafeObjectKey(key, "Messaging YAML render path");
    let rest = line.text.slice(colonIndex + 1).trim();
    if (rest.length > 0) {
      ((parsed[key] = parseGeneratedYamlScalar(rest, target, line.lineNumber)), (index += 1));
      continue;
    }
    let next = lines[index + 1];
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith("-"))) {
      ((parsed[key] = {}), (index += 1));
      continue;
    }
    let childIndent = next.text.startsWith("-") && next.indent === indent ? indent : indent + 2,
      [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, childIndent, target);
    ((parsed[key] = value), (index = nextIndex));
  }
  return [parsed, index];
}
function parseGeneratedYamlArray(lines, startIndex, indent, target) {
  let parsed = [],
    index = startIndex;
  for (; index < lines.length;) {
    let line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith("-"))
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported array syntax at line ${line.lineNumber}.`,
      );
    let rest = line.text.slice(1).trim();
    if (rest.length > 0) {
      (parsed.push(parseGeneratedYamlScalar(rest, target, line.lineNumber)), (index += 1));
      continue;
    }
    let next = lines[index + 1];
    if (!next || next.indent <= indent) {
      (parsed.push({}), (index += 1));
      continue;
    }
    let [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, indent + 2, target);
    (parsed.push(value), (index = nextIndex));
  }
  return [parsed, index];
}
function parseGeneratedYamlScalar(value, target, lineNumber) {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "null") return null;
  if (value === "true") return !0;
  if (value === "false") return !1;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"'))
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has invalid quoted scalar at line ${lineNumber}: ${formatError(error)}`,
      );
    }
  return value;
}
function serializeGeneratedYamlObject(value) {
  return serializeGeneratedYamlValue(value);
}
function serializeGeneratedYamlValue(value, indent = 0) {
  let pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0)
      return `${pad}[]
`;
    let out = "";
    for (let item of value)
      isObject2(item)
        ? ((out += `${pad}-
`),
          (out += serializeGeneratedYamlValue(item, indent + 1)))
        : Array.isArray(item)
          ? ((out += `${pad}-
`),
            (out += serializeGeneratedYamlValue(item, indent + 1)))
          : (out += `${pad}- ${formatGeneratedYamlScalar(item)}
`);
    return out;
  }
  if (isObject2(value)) {
    let out = "";
    for (let [key, item] of Object.entries(value))
      if ((assertSafeObjectKey(key, "Messaging YAML object"), Array.isArray(item)))
        out +=
          item.length === 0
            ? `${pad}${key}: []
`
            : `${pad}${key}:
${serializeGeneratedYamlValue(item, indent + 1)}`;
      else if (isObject2(item)) {
        let entries = Object.entries(item);
        out +=
          entries.length === 0
            ? `${pad}${key}: {}
`
            : `${pad}${key}:
${serializeGeneratedYamlValue(item, indent + 1)}`;
      } else
        out += `${pad}${key}: ${formatGeneratedYamlScalar(item)}
`;
    return out;
  }
  return `${pad}${formatGeneratedYamlScalar(value)}
`;
}
function formatGeneratedYamlScalar(value) {
  return value == null
    ? "null"
    : typeof value == "number" || typeof value == "boolean"
      ? String(value)
      : typeof value != "string" ||
          value === "" ||
          /[:{}\[\],&*?|>!%@`#'\"]/.test(value) ||
          value.includes(`
`) ||
          value.trim() !== value
        ? JSON.stringify(value)
        : value;
}
function isTruthyEnv(value) {
  return !value || value.trim() === ""
    ? !1
    : !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
function requiredSerializableValue(value, label) {
  if (value === void 0) throw new MessagingBuildApplierError(`Messaging ${label} is missing`);
  return value;
}
function assertSafeObjectKey(key, context) {
  if (key === "__proto__" || key === "prototype" || key === "constructor")
    throw new MessagingBuildApplierError(`${context} rejected unsafe object key ${key}`);
}
function isObject2(value) {
  return typeof value == "object" && value !== null && !Array.isArray(value);
}
function uniqueStrings(values) {
  return [...new Set(values)];
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function applyPackageMessagingBuildPhase(plan, phase, env, options) {
  if ((options.mode ?? "apply") === "clear") {
    if (plan !== null)
      throw new MessagingBuildApplierError("Messaging clear mode requires an absent plan");
    return [];
  }
  if (options.managedStartupRuntime && plan === null)
    throw new MessagingBuildApplierError("Managed startup apply mode requires a messaging plan");
  if (phase === "runtime-setup") {
    let target = writeMessagingRuntimePlanArtifact(plan, messagingRuntimePlanPath(env));
    return target ? [target] : [];
  }
  if (phase === "agent-install") {
    if (!options.runtimeProfile)
      throw new MessagingBuildApplierError("Messaging package installation requires --profile");
    return (installMessagingPackagesFromProfile(plan, options.runtimeProfile, env), []);
  }
  let applyOutputs = () => [
      ...applyMessagingAgentRenderToLocalFiles(plan),
      ...applyPostAgentInstallBuildFilesToLocalFiles(plan),
    ],
    applied = applyOutputs();
  return plan && effectiveBuildProfile(plan).postRenderRepair && !options.managedStartupRuntime
    ? (runMessagingPostRenderRepair(plan, env), uniqueStrings([...applied, ...applyOutputs()]))
    : uniqueStrings(applied);
}
function renderInstallerCommand(command, placeholder, values) {
  if (command.flatMap((value, index) => (value === placeholder ? [index] : [])).length !== 1)
    throw new MessagingBuildApplierError(
      `Messaging package installer command must contain exactly one ${placeholder} argument`,
    );
  return command.flatMap((value) => (value === placeholder ? values : [value]));
}
function installRuntimeNodePackages(installs, profile, env) {
  let installer = profile.build.packageInstallers?.["node-package"];
  if (!installer || installer.kind !== "verified-archive-command")
    throw new MessagingBuildApplierError(
      "Messaging build profile is missing its node package installer",
    );
  for (let install of installs) {
    let installCache = install.runtimeLock
        ? requireWritableRuntimeInstallCache(install.runtimeLock, env)
        : void 0,
      installEnv = {
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
      },
      packed = packVerifiedNodePackageArchive(
        install,
        installEnv,
        profile.build.nodeArchiveRemediation === "package-helper",
      );
    try {
      let archiveArgument = `${installer.archiveArgumentPrefix ?? ""}${packed.archivePath}`;
      if (
        (runCommand(
          renderInstallerCommand(installer.command, "{{archive}}", [archiveArgument]),
          installEnv,
        ),
        install.runtimeLock)
      ) {
        let versionEnvironment = installer.packageVersionEnvironment,
          packageVersion = versionEnvironment
            ? sanitizeOptionalString(env[versionEnvironment])
            : "";
        if (!packageVersion)
          throw new MessagingBuildApplierError(
            `${versionEnvironment ?? "Package version environment"} is required to verify the runtime lock`,
          );
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
      rmSync2(packed.rootDir, { recursive: !0, force: !0 });
    }
  }
}
function installRuntimePythonPackages(installs, profile, env) {
  if (installs.length === 0) return;
  let installer = profile.build.packageInstallers?.["python-package"];
  if (!installer || installer.kind !== "batched-command")
    throw new MessagingBuildApplierError(
      "Messaging build profile is missing its Python package installer",
    );
  runCommand(
    renderInstallerCommand(
      installer.command,
      "{{packages}}",
      installs.map(({ spec }) => spec),
    ),
    { ...env, ...(installer.environment ?? {}) },
  );
}
function installMessagingPackagesFromProfile(plan, profile, env, allChannels = !1) {
  if (!plan && !allChannels) return;
  let managers = profile.build.packageManagers;
  (managers.includes("node-package") &&
    installRuntimeNodePackages(
      collectRuntimeNodePackages(plan, profile, env, allChannels),
      profile,
      env,
    ),
    managers.includes("python-package") &&
      installRuntimePythonPackages(
        collectRuntimePythonPackages(plan, profile, allChannels),
        profile,
        env,
      ));
}
function describePackageMessagingBuildPhase(plan, phase, env, runtimeProfile) {
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
      plan && runtimeProfile && effectiveBuildProfile(plan).packageManagers.includes("node-package")
        ? collectRuntimeNodePackages(plan, runtimeProfile, env).map(({ spec }) => spec)
        : [],
    pythonPackages:
      plan &&
      runtimeProfile &&
      effectiveBuildProfile(plan).packageManagers.includes("python-package")
        ? collectRuntimePythonPackages(plan, runtimeProfile).map(({ spec }) => spec)
        : [],
    packageVersion: runtimeProfile?.build.packageInstallers?.["node-package"]
      ?.packageVersionEnvironment
      ? (env[runtimeProfile.build.packageInstallers["node-package"].packageVersionEnvironment] ??
        "")
      : "",
  };
}
function packageRuntimeMain(argv = process.argv.slice(2)) {
  let parsed = parseMessagingBuildArgs(argv);
  if (!parsed.profilePath)
    throw new MessagingBuildApplierError("Package messaging runtime requires --profile");
  runMessagingBuildCommand(
    parsed,
    applyPackageMessagingBuildPhase,
    describePackageMessagingBuildPhase,
  );
}
function runMessagingBuildCommand(
  { agent, phase, dryRun, managedStartupRuntime, mode, profilePath },
  applyPhase,
  describePhase,
) {
  let plan = readMessagingBuildPlanFromEnv(process.env, agent),
    runtimeProfile = profilePath ? readMessagingRuntimeProfile(profilePath, agent) : void 0;
  if (phase === "managed-image-capability-union") {
    if (plan)
      throw new MessagingBuildApplierError(
        "Managed-image capability union must be built without a serialized messaging plan",
      );
    if (!runtimeProfile)
      throw new MessagingBuildApplierError("Managed-image capability union requires --profile");
    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            agent,
            phase,
            channels: [],
            runtimePlanPath: "",
            doctorEnv: {},
            installSpecs: collectRuntimeNodePackages(null, runtimeProfile, process.env, !0).map(
              ({ spec }) => spec,
            ),
            pythonPackages: collectRuntimePythonPackages(null, runtimeProfile, !0).map(
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
    if (process.env.NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION !== "1")
      throw new MessagingBuildApplierError(
        "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      );
    installMessagingPackagesFromProfile(null, runtimeProfile, process.env, !0);
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify(describePhase(plan, phase, process.env, runtimeProfile), null, 2));
    return;
  }
  applyPhase(plan, phase, process.env, {
    managedStartupRuntime,
    mode,
    ...(runtimeProfile ? { runtimeProfile } : {}),
  });
}
function parseMessagingBuildArgs(argv) {
  let agent,
    phase,
    dryRun = !1,
    managedStartupRuntime = !1,
    mode = "apply",
    profilePath;
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = !0;
      continue;
    }
    if (arg === "--managed-startup-runtime") {
      managedStartupRuntime = !0;
      continue;
    }
    if (arg === "--profile") {
      ((profilePath = readProfilePathArg(argv[index + 1])), (index += 1));
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profilePath = readProfilePathArg(arg.slice(10));
      continue;
    }
    if (arg === "--mode") {
      ((mode = readApplyModeArg(argv[index + 1])), (index += 1));
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = readApplyModeArg(arg.slice(7));
      continue;
    }
    if (arg === "--agent") {
      ((agent = readAgentArg(argv[index + 1])), (index += 1));
      continue;
    }
    if (arg.startsWith("--agent=")) {
      agent = readAgentArg(arg.slice(8));
      continue;
    }
    if (arg === "--phase") {
      ((phase = readPhaseArg(argv[index + 1])), (index += 1));
      continue;
    }
    if (arg.startsWith("--phase=")) {
      phase = readPhaseArg(arg.slice(8));
      continue;
    }
    if (!arg.startsWith("-") && !phase) {
      phase = readPhaseArg(arg);
      continue;
    }
    throw new MessagingBuildApplierError(`Unknown messaging build applier argument: ${arg}`);
  }
  let resolvedPhase = phase ?? "post-agent-install";
  if (managedStartupRuntime && resolvedPhase !== "post-agent-install")
    throw new MessagingBuildApplierError(
      "--managed-startup-runtime requires --phase post-agent-install",
    );
  return {
    agent:
      agent ??
      (() => {
        throw new MessagingBuildApplierError("Package messaging runtime requires --agent");
      })(),
    phase: resolvedPhase,
    dryRun,
    managedStartupRuntime,
    mode,
    ...(profilePath ? { profilePath } : {}),
  };
}
function readProfilePathArg(value) {
  let profilePath = sanitizeOptionalString(value);
  if (profilePath && isAbsolute2(profilePath)) return profilePath;
  throw new MessagingBuildApplierError("--profile must be an absolute path");
}
function readApplyModeArg(value) {
  if (value === "apply" || value === "clear") return value;
  throw new MessagingBuildApplierError("--mode must be 'apply' or 'clear'");
}
function readAgentArg(value) {
  let agent = sanitizeOptionalString(value);
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(agent)) return agent;
  throw new MessagingBuildApplierError("--agent must be a canonical package id");
}
function readPhaseArg(value) {
  if (
    value === "runtime-setup" ||
    value === "agent-install" ||
    value === "post-agent-install" ||
    value === "managed-image-capability-union"
  )
    return value;
  throw new MessagingBuildApplierError(
    "--phase must be 'runtime-setup', 'agent-install', 'post-agent-install', or 'managed-image-capability-union'",
  );
}

// src/lib/messaging/applier/build/runtime-entry.mts
packageRuntimeMain();
