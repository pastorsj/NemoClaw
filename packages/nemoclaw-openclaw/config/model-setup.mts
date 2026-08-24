// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;

const KNOWN_MODEL_SETUP_AGENTS = new Set(["openclaw", "hermes"]);
const MODEL_SETUP_EFFECT_KEYS: Record<string, Set<string>> = {
  openclaw: new Set(["openclawCompat", "openclawPlugins", "openclawTools"]),
  hermes: new Set(["hermesCompat"]),
};
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function registryRoots(env: Env): string[] {
  const roots: string[] = [];
  const explicit = env.NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR;
  if (explicit) {
    roots.push(explicit);
  }
  roots.push(
    "/opt/nemoclaw-blueprint/model-specific-setup",
    "/sandbox/.nemoclaw/blueprints/0.1.0/model-specific-setup",
    join(dirname(SCRIPT_DIR), "model-specific-setup"),
    join(dirname(SCRIPT_DIR), "nemoclaw-blueprint", "model-specific-setup"),
    join(process.cwd(), "nemoclaw-blueprint", "model-specific-setup"),
  );
  return unique(roots);
}

function isDirectory(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function findRegistryRoot(env: Env): string | null {
  const explicit = env.NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR;
  if (explicit) {
    if (!isDirectory(explicit)) {
      throw new Error(
        "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory: " + explicit,
      );
    }
    return explicit;
  }

  for (const root of registryRoots(env)) {
    if (isDirectory(root)) {
      return root;
    }
  }
  return null;
}

function validateManifestPayload(payload: unknown, manifestPath: string): JsonObject {
  if (!isObject(payload)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }

  const setupId = payload.id;
  if (typeof setupId !== "string" || !setupId.trim()) {
    throw new Error(`${manifestPath}: field 'id' must be a non-empty string`);
  }

  const agent = payload.agent;
  if (typeof agent !== "string" || !agent.trim()) {
    throw new Error(`${manifestPath}: field 'agent' is required`);
  }
  if (!KNOWN_MODEL_SETUP_AGENTS.has(agent)) {
    throw new Error(`${manifestPath}: unknown agent '${agent}'`);
  }

  const description = payload.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`${manifestPath}: field 'description' must be a non-empty string`);
  }

  const match = payload.match;
  if (!isObject(match)) {
    throw new Error(`${manifestPath}: field 'match' must be an object`);
  }
  if (Object.keys(match).length === 0) {
    throw new Error(`${manifestPath}: field 'match' must be a non-empty object`);
  }
  const allowedMatchKeys = new Set([
    "modelIds",
    "modelIdPrefixes",
    "providerKey",
    "inferenceApi",
    "baseUrl",
  ]);
  const unknownMatchKeys = Object.keys(match)
    .filter((key) => !allowedMatchKeys.has(key))
    .sort();
  if (unknownMatchKeys.length > 0) {
    throw new Error(`${manifestPath}: unknown match keys: ${unknownMatchKeys.join(", ")}`);
  }

  const modelIds = match.modelIds;
  if (
    modelIds !== undefined &&
    (!Array.isArray(modelIds) ||
      modelIds.length === 0 ||
      !modelIds.every((modelId) => typeof modelId === "string" && modelId.trim()))
  ) {
    throw new Error(`${manifestPath}: match.modelIds must be a non-empty string array`);
  }
  const modelIdPrefixes = match.modelIdPrefixes;
  if (
    modelIdPrefixes !== undefined &&
    (!Array.isArray(modelIdPrefixes) ||
      modelIdPrefixes.length === 0 ||
      !modelIdPrefixes.every((prefix) => typeof prefix === "string" && prefix.trim()))
  ) {
    throw new Error(`${manifestPath}: match.modelIdPrefixes must be a non-empty string array`);
  }
  if (
    Array.isArray(modelIdPrefixes) &&
    modelIdPrefixes.some((prefix) => String(prefix).includes("/"))
  ) {
    throw new Error(
      `${manifestPath}: match.modelIdPrefixes must contain bare model ids without namespaces`,
    );
  }
  if (modelIds !== undefined && modelIdPrefixes !== undefined) {
    throw new Error(
      `${manifestPath}: match.modelIds and match.modelIdPrefixes are mutually exclusive`,
    );
  }
  for (const key of ["providerKey", "inferenceApi", "baseUrl"]) {
    const value = match[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${manifestPath}: match.${key} must be a non-empty string`);
    }
  }

  const effects = payload.effects;
  if (!isObject(effects) || Object.keys(effects).length === 0) {
    throw new Error(`${manifestPath}: field 'effects' must be a non-empty object`);
  }

  return payload;
}

function validateSelectedAgentEffects(
  payload: JsonObject,
  manifestPath: string,
  registryRoot: string,
): void {
  const agent = payload.agent;
  const effects = payload.effects;
  const allowedEffectKeys = MODEL_SETUP_EFFECT_KEYS[agent];
  const unknownEffectKeys = Object.keys(effects)
    .filter((key) => !allowedEffectKeys.has(key))
    .sort();
  if (unknownEffectKeys.length > 0) {
    throw new Error(
      `${manifestPath}: unknown effects for agent '${agent}': ${unknownEffectKeys.join(", ")}`,
    );
  }

  if (agent === "openclaw") {
    const compat = effects.openclawCompat;
    if (compat !== undefined && !isObject(compat)) {
      throw new Error(`${manifestPath}: effects.openclawCompat must be an object`);
    }

    const tools = effects.openclawTools;
    if (tools !== undefined) {
      if (!isObject(tools)) {
        throw new Error(`${manifestPath}: effects.openclawTools must be an object`);
      }
      const unknownToolKeys = Object.keys(tools)
        .filter((key) => key !== "toolSearch")
        .sort();
      if (unknownToolKeys.length > 0) {
        throw new Error(
          `${manifestPath}: unknown effects.openclawTools keys: ${unknownToolKeys.join(", ")}`,
        );
      }
      // Source: openclaw@2026.5.27 ToolSearchSchema and resolveToolSearchConfig
      // (`src/config/zod-schema.agent-runtime.ts`, `src/agents/tool-search.ts`).
      // Keep the registry override narrower than the runtime config: false
      // disables Tool Search, while true selects its default code bridge.
      if ("toolSearch" in tools && typeof tools.toolSearch !== "boolean") {
        throw new Error(
          `${manifestPath}: effects.openclawTools.toolSearch must be a boolean override`,
        );
      }
    }

    const plugins = effects.openclawPlugins || [];
    if (!Array.isArray(plugins)) {
      throw new Error(`${manifestPath}: effects.openclawPlugins must be an array`);
    }
    plugins.forEach((plugin, index) => {
      if (!isObject(plugin)) {
        throw new Error(`${manifestPath}: effects.openclawPlugins[${index}] must be an object`);
      }
      for (const key of ["id", "path", "loadPath"]) {
        const value = plugin[key];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(
            `${manifestPath}: effects.openclawPlugins[${index}].${key} ` +
              "must be a non-empty string",
          );
        }
      }
      const sourcePath = plugin.path as string;
      const sourceParts = sourcePath.split(/[\\/]+/);
      if (isAbsolute(sourcePath) || sourceParts.includes("..")) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].path ` +
            "must be relative to nemoclaw-blueprint",
        );
      }
      if (!existsSync(join(dirname(registryRoot), sourcePath))) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].path does not exist: ` + sourcePath,
        );
      }
      const strippedPath = sourcePath.replace(/^\/+/, "").replace(/\/+$/, "");
      const expectedLoadPath = `/usr/local/share/nemoclaw/${strippedPath}`;
      if ((plugin.loadPath as string).replace(/\/+$/, "") !== expectedLoadPath) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].loadPath ` +
            `must be '${expectedLoadPath}'`,
        );
      }
    });
  }

  if (agent === "hermes") {
    const compat = effects.hermesCompat;
    if (compat !== undefined && !isObject(compat)) {
      throw new Error(`${manifestPath}: effects.hermesCompat must be an object`);
    }
  }
}

function modelSetupMatches(payload: JsonObject, context: JsonObject): boolean {
  const match = payload.match;
  const normalizedModel = String(context.model).trim().toLowerCase();
  const modelIds = match.modelIds;
  if (
    Array.isArray(modelIds) &&
    modelIds.length > 0 &&
    !new Set(modelIds.map((modelId) => String(modelId).trim().toLowerCase())).has(normalizedModel)
  ) {
    return false;
  }

  const modelIdPrefixes = match.modelIdPrefixes;
  const bareModel = normalizedModel.includes("/")
    ? normalizedModel.slice(normalizedModel.lastIndexOf("/") + 1)
    : normalizedModel;
  if (
    Array.isArray(modelIdPrefixes) &&
    modelIdPrefixes.length > 0 &&
    !modelIdPrefixes.some((value) => {
      const prefix = String(value).trim().toLowerCase();
      return (
        bareModel === prefix ||
        bareModel.startsWith(`${prefix}.`) ||
        bareModel.startsWith(`${prefix}-`)
      );
    })
  ) {
    return false;
  }

  const providerKey = match.providerKey;
  if (providerKey && context.providerKey !== providerKey) {
    return false;
  }

  const inferenceApi = match.inferenceApi;
  if (inferenceApi && context.inferenceApi !== inferenceApi) {
    return false;
  }

  const baseUrl = match.baseUrl;
  if (
    baseUrl &&
    String(context.baseUrl).replace(/\/+$/, "") !== String(baseUrl).replace(/\/+$/, "")
  ) {
    return false;
  }

  return true;
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const pathValue = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(pathValue);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(pathValue);
      }
    }
  }
  visit(root);
  return files.sort();
}

/** Discover the validated model setup manifests that match this inference route. */
export function findMatchingModelSetups(
  agent: string,
  context: JsonObject,
  env: Env,
): JsonObject[] {
  const registryRoot = findRegistryRoot(env);
  if (registryRoot === null) {
    return [];
  }

  const manifests: JsonObject[] = [];
  for (const manifestPath of listJsonFiles(registryRoot)) {
    if (manifestPath.split(sep).at(-1) === "schema.json") {
      continue;
    }
    const payload = validateManifestPayload(
      JSON.parse(readFileSync(manifestPath, "utf-8")),
      manifestPath,
    );
    if (payload.agent !== agent) {
      continue;
    }
    validateSelectedAgentEffects(payload, manifestPath, registryRoot);
    if (modelSetupMatches(payload, context)) {
      manifests.push(payload);
    }
  }
  return manifests;
}

/** Merge one validated model setup into the OpenClaw configuration inputs. */
export function applyOpenClawSetupEffects(
  setup: JsonObject,
  inferenceCompat: JsonObject,
  openclawPlugins: JsonObject[],
  pluginIds: Set<string>,
  openclawTools: JsonObject,
): void {
  const effects = setup.effects;
  for (const [key, value] of Object.entries(effects.openclawCompat || {})) {
    if (key in inferenceCompat && inferenceCompat[key] !== value) {
      throw new Error(
        `model-specific setup '${setup.id}' conflicts with inference compat key '${key}'`,
      );
    }
    inferenceCompat[key] = value;
  }

  for (const [key, value] of Object.entries(effects.openclawTools || {})) {
    if (key in openclawTools && openclawTools[key] !== value) {
      throw new Error(
        `model-specific setup '${setup.id}' conflicts with OpenClaw tools key '${key}'`,
      );
    }
    openclawTools[key] = value;
  }

  for (const plugin of effects.openclawPlugins || []) {
    const pluginId = plugin.id;
    if (pluginIds.has(pluginId)) {
      throw new Error(
        `model-specific setup '${setup.id}' declares duplicate OpenClaw plugin '${pluginId}'`,
      );
    }
    pluginIds.add(pluginId);
    openclawPlugins.push(plugin);
  }
}
