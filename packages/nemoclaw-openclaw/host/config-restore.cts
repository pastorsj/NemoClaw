// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OPENCLAW_CONFIG_RESTORE_OWNERSHIP = {
  runtimeSections: ["gateway", "proxy", "diagnostics"],
  currentGeneratedEntryMaps: ["plugins.entries"],
  managedWebSearchPluginEntries: ["brave", "tavily"],
  managedWebSearchConfigPaths: ["tools.web.search"],
  providerRuntimeOwnedFields: ["baseUrl", "api", "apiKey"],
  modelRuntimeOwnedFields: ["id", "name"],
  backupDurableSections: ["mcp", "mcpServers", "customAgents", "agents"],
  agentPrimaryModelPath: ["agents", "defaults", "model", "primary"],
  currentGeneratedToolFields: ["toolSearch"],
};

const MANAGED_WEB_SEARCH_PLUGIN_ENTRIES = new Set(
  OPENCLAW_CONFIG_RESTORE_OWNERSHIP.managedWebSearchPluginEntries,
);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function mergeJsonObjects(base, overlay) {
  const merged = cloneJson(base);
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeJsonObjects(existing, value);
    } else {
      merged[key] = cloneJson(value);
    }
  }
  return merged;
}

function mergeOpenClawChannels(
  backupChannels,
  currentChannels,
  managedChannels,
  previousImagePluginIds,
) {
  if (!isPlainObject(backupChannels)) return cloneJson(currentChannels);
  const merged = isPlainObject(currentChannels) ? cloneJson(currentChannels) : {};

  for (const [key, value] of Object.entries(backupChannels)) {
    if (key === "defaults") {
      merged[key] =
        isPlainObject(value) && isPlainObject(merged[key])
          ? mergeJsonObjects(merged[key], value)
          : cloneJson(value);
      continue;
    }
    if (managedChannels.has(key) || previousImagePluginIds?.has(key)) continue;
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeJsonObjects(existing, value)
        : cloneJson(value);
  }
  return merged;
}

function mergeOpenClawEntryMap(backupEntries, currentEntries, previousImagePluginIds) {
  if (!isPlainObject(backupEntries) && !isPlainObject(currentEntries)) return undefined;
  const merged = {};
  if (isPlainObject(backupEntries)) {
    for (const [key, value] of Object.entries(backupEntries)) {
      if (previousImagePluginIds?.has(key)) continue;
      if (MANAGED_WEB_SEARCH_PLUGIN_ENTRIES.has(key)) continue;
      merged[key] = cloneJson(value);
    }
  }
  if (isPlainObject(currentEntries)) Object.assign(merged, cloneJson(currentEntries));
  return merged;
}

function mergeOpenClawPluginLoad(backupLoad, currentLoad, previousImagePluginLoadPaths) {
  const backup = isPlainObject(backupLoad) ? backupLoad : {};
  const current = isPlainObject(currentLoad) ? currentLoad : {};
  const merged = mergeJsonObjects(current, backup);
  const currentPaths = Array.isArray(current.paths)
    ? current.paths.filter((entry) => typeof entry === "string")
    : [];
  const backupPaths = Array.isArray(backup.paths)
    ? backup.paths.filter(
        (entry) => typeof entry === "string" && !previousImagePluginLoadPaths?.has(entry),
      )
    : [];
  const paths = [...new Set([...currentPaths, ...backupPaths])];
  if (Array.isArray(current.paths) || Array.isArray(backup.paths)) merged.paths = paths;
  else delete merged.paths;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
}

function mergeOpenClawPluginIdList(
  backupValue,
  currentValue,
  previousImagePluginIds,
  currentOppositeIds = new Set(),
) {
  const backup = stringArray(backupValue);
  const current = stringArray(currentValue);
  if (!backup && !current) return undefined;
  return [
    ...new Set([
      ...(current ?? []),
      ...(backup ?? []).filter(
        (id) => !previousImagePluginIds?.has(id) && !currentOppositeIds.has(id),
      ),
    ]),
  ];
}

function mergeOpenClawPluginSlots(backupSlots, currentSlots, previousImagePluginIds) {
  if (!isPlainObject(backupSlots) && !isPlainObject(currentSlots)) return undefined;
  const merged = {};
  if (isPlainObject(backupSlots)) {
    for (const [key, value] of Object.entries(backupSlots)) {
      if (typeof value === "string" && previousImagePluginIds?.has(value)) continue;
      merged[key] = cloneJson(value);
    }
  }
  if (isPlainObject(currentSlots)) Object.assign(merged, cloneJson(currentSlots));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function imagePluginOwnership(installs) {
  if (installs === undefined) return {};
  const ids = new Set();
  const loadPaths = new Set();
  for (const install of installs) {
    if (!Array.isArray(install.loadPaths)) {
      throw new Error("OpenClaw image plugin provenance is missing explicit load paths");
    }
    ids.add(install.id);
    for (const loadPath of install.loadPaths) loadPaths.add(loadPath);
  }
  return { ids, loadPaths };
}

function removedImagePluginIds(previous, fresh) {
  if (!previous.ids) return undefined;
  return new Set([...previous.ids].filter((id) => !fresh.ids?.has(id)));
}

function mergeOpenClawTools(backupTools, currentTools) {
  if (!isPlainObject(backupTools)) return cloneJson(currentTools);
  if (!isPlainObject(currentTools) && currentTools !== undefined && currentTools !== null) {
    return cloneJson(currentTools);
  }
  const current = isPlainObject(currentTools) ? currentTools : {};
  const merged = mergeJsonObjects(current, backupTools);
  const backupWeb = isPlainObject(backupTools.web) ? backupTools.web : {};
  const currentWeb = isPlainObject(current.web) ? current.web : {};
  const mergedWeb = mergeJsonObjects(currentWeb, backupWeb);

  if ("search" in currentWeb) mergedWeb.search = cloneJson(currentWeb.search);
  else delete mergedWeb.search;
  if (Object.keys(mergedWeb).length > 0) merged.web = mergedWeb;
  else delete merged.web;
  for (const field of OPENCLAW_CONFIG_RESTORE_OWNERSHIP.currentGeneratedToolFields) {
    if (field in current) merged[field] = cloneJson(current[field]);
    else delete merged[field];
  }
  return merged;
}

function modelEntryId(entry) {
  return isPlainObject(entry) && typeof entry.id === "string" ? entry.id : null;
}

function restoreRuntimeOwnedFields(merged, current, ownedFields) {
  for (const field of ownedFields) {
    if (field in current) merged[field] = cloneJson(current[field]);
    else delete merged[field];
  }
}

function mergeOpenClawModelEntry(backupModel, currentModel) {
  const merged = mergeJsonObjects(currentModel, backupModel);
  restoreRuntimeOwnedFields(
    merged,
    currentModel,
    OPENCLAW_CONFIG_RESTORE_OWNERSHIP.modelRuntimeOwnedFields,
  );
  return merged;
}

function mergeOpenClawModelArray(backupModels, currentModels) {
  if (!Array.isArray(currentModels)) return cloneJson(backupModels ?? currentModels);
  const backupById = new Map();
  if (Array.isArray(backupModels)) {
    for (const entry of backupModels) {
      const id = modelEntryId(entry);
      if (id && isPlainObject(entry) && !backupById.has(id)) backupById.set(id, entry);
    }
  }
  return currentModels.map((entry) => {
    const id = modelEntryId(entry);
    const backupMatch = id ? backupById.get(id) : undefined;
    return backupMatch && isPlainObject(entry)
      ? mergeOpenClawModelEntry(backupMatch, entry)
      : cloneJson(entry);
  });
}

function mergeOpenClawProviderEntry(backupProvider, currentProvider) {
  const merged = mergeJsonObjects(currentProvider, backupProvider);
  restoreRuntimeOwnedFields(
    merged,
    currentProvider,
    OPENCLAW_CONFIG_RESTORE_OWNERSHIP.providerRuntimeOwnedFields,
  );
  if ("models" in currentProvider || "models" in backupProvider) {
    merged.models = mergeOpenClawModelArray(backupProvider.models, currentProvider.models);
  }
  return merged;
}

function mergeOpenClawProviderMap(backupProviders, currentProviders) {
  if (!isPlainObject(backupProviders) && !isPlainObject(currentProviders)) return undefined;
  const backup = isPlainObject(backupProviders) ? backupProviders : {};
  const current = isPlainObject(currentProviders) ? currentProviders : {};
  const merged = {};
  for (const [key, value] of Object.entries(backup)) merged[key] = cloneJson(value);
  for (const [key, value] of Object.entries(current)) {
    const backupEntry = backup[key];
    merged[key] =
      isPlainObject(backupEntry) && isPlainObject(value)
        ? mergeOpenClawProviderEntry(backupEntry, value)
        : cloneJson(value);
  }
  return merged;
}

function mergeOpenClawModels(backupModels, currentModels) {
  if (!isPlainObject(backupModels)) return cloneJson(currentModels);
  if (!isPlainObject(currentModels)) return cloneJson(backupModels);
  const merged = mergeJsonObjects(currentModels, backupModels);
  const providers = mergeOpenClawProviderMap(backupModels.providers, currentModels.providers);
  if (providers) merged.providers = providers;
  return merged;
}

function mergeOpenClawPlugins(backupPlugins, currentPlugins, previousOwnership, freshOwnership) {
  if (!isPlainObject(backupPlugins) && !isPlainObject(currentPlugins)) return undefined;
  const backup = isPlainObject(backupPlugins) ? backupPlugins : {};
  const current = isPlainObject(currentPlugins) ? currentPlugins : {};
  const merged = mergeJsonObjects(current, backup);
  delete merged.installs;

  const entries = mergeOpenClawEntryMap(backup.entries, current.entries, previousOwnership.ids);
  if (entries) merged.entries = entries;
  else delete merged.entries;

  const currentAllow = stringArray(current.allow);
  const currentDeny = stringArray(current.deny);
  const removedIds = removedImagePluginIds(previousOwnership, freshOwnership);
  const backupAllowOwnedIds = currentAllow ? previousOwnership.ids : removedIds;
  const backupDenyOwnedIds = currentDeny ? previousOwnership.ids : removedIds;
  const allow = mergeOpenClawPluginIdList(
    backup.allow,
    current.allow,
    backupAllowOwnedIds,
    new Set(currentDeny ?? []),
  );
  if (allow && allow.length > 0) merged.allow = allow;
  else delete merged.allow;
  const deny = mergeOpenClawPluginIdList(
    backup.deny,
    current.deny,
    backupDenyOwnedIds,
    new Set(currentAllow ?? []),
  );
  if (deny && deny.length > 0) merged.deny = deny;
  else delete merged.deny;

  const slots = mergeOpenClawPluginSlots(backup.slots, current.slots, previousOwnership.ids);
  if (slots) merged.slots = slots;
  else delete merged.slots;
  const load = mergeOpenClawPluginLoad(backup.load, current.load, previousOwnership.loadPaths);
  if (load) merged.load = load;
  else delete merged.load;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function ensureMergedObject(record, key) {
  const existing = record[key];
  if (isPlainObject(existing)) return existing;
  const created = {};
  record[key] = created;
  return created;
}

function readAgentPrimaryModelRef(config) {
  const agents = config.agents;
  if (!isPlainObject(agents)) return undefined;
  const defaults = agents.defaults;
  if (!isPlainObject(defaults)) return undefined;
  const model = defaults.model;
  if (!isPlainObject(model)) return undefined;
  return typeof model.primary === "string" ? model.primary : undefined;
}

function updateMainAgentListModel(agents, primaryModelRef) {
  const list = agents.list;
  if (!Array.isArray(list)) return;
  let defaultAgent;
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    if (entry.id === "main") {
      if (typeof entry.model === "string") entry.model = primaryModelRef;
      return;
    }
    if (!defaultAgent && entry.default === true && typeof entry.model === "string") {
      defaultAgent = entry;
    }
  }
  if (defaultAgent) defaultAgent.model = primaryModelRef;
}

function reconcileAgentPrimaryModel(merged, currentConfig) {
  const freshPrimary = readAgentPrimaryModelRef(currentConfig);
  if (freshPrimary === undefined) return;
  const agents = ensureMergedObject(merged, "agents");
  const defaults = ensureMergedObject(agents, "defaults");
  const model = ensureMergedObject(defaults, "model");
  model.primary = freshPrimary;
  updateMainAgentListModel(agents, freshPrimary);
}

function configRestoreOwnership(managedChannelNames) {
  // Rebuild starts from a fresh generated config, while the sanitized backup
  // can contain durable user state and stale managed values. These rules keep
  // current runtime routing, channels, and image plugins authoritative while
  // restoring only the durable portions owned by the backup.
  return {
    ...OPENCLAW_CONFIG_RESTORE_OWNERSHIP,
    managedChannels: [...managedChannelNames],
  };
}

function mergeOpenClawRestoredConfig(
  backedUpConfig,
  currentConfig,
  options = {},
  managedChannelNames = [],
) {
  if (!isPlainObject(backedUpConfig) || !isPlainObject(currentConfig)) {
    throw new Error("OpenClaw selective config merge requires JSON objects");
  }
  if (
    (options.previousImagePluginInstalls === undefined) !==
    (options.freshImagePluginInstalls === undefined)
  ) {
    throw new Error("Complete previous and fresh OpenClaw image plugin provenance is required");
  }
  const previousOwnership = imagePluginOwnership(options.previousImagePluginInstalls);
  const freshOwnership = imagePluginOwnership(options.freshImagePluginInstalls);
  const merged = mergeJsonObjects(currentConfig, backedUpConfig);
  for (const key of OPENCLAW_CONFIG_RESTORE_OWNERSHIP.runtimeSections) {
    if (key in currentConfig) merged[key] = cloneJson(currentConfig[key]);
    else delete merged[key];
  }
  merged.channels = mergeOpenClawChannels(
    backedUpConfig.channels,
    currentConfig.channels,
    new Set(managedChannelNames),
    previousOwnership.ids,
  );
  merged.models = mergeOpenClawModels(backedUpConfig.models, currentConfig.models);
  merged.plugins = mergeOpenClawPlugins(
    backedUpConfig.plugins,
    currentConfig.plugins,
    previousOwnership,
    freshOwnership,
  );
  merged.tools = mergeOpenClawTools(backedUpConfig.tools, currentConfig.tools);
  reconcileAgentPrimaryModel(merged, currentConfig);
  return merged;
}

module.exports = {
  configRestoreOwnership,
  mergeOpenClawRestoredConfig,
};
