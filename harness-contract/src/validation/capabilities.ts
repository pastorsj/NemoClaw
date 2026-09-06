// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CONTROL_CHARACTER_PATTERN,
  DISPLAY_CONTROL_PATTERN,
  fail,
  isCanonicalRelativePath,
  type ManifestRecord,
  requireCanonicalId,
  requireExactFields,
  requireKnownFields,
  requireRecord,
  requireString,
  SAFE_PATH_SEGMENT_PATTERN,
  utf8ByteLength,
} from "./shared.js";

function validateMcp(manifest: ManifestRecord): void {
  if (manifest.mcp === undefined) return;
  const mcp = requireRecord(manifest.mcp, "mcp");
  if (mcp.support !== "bridge" && mcp.support !== "disabled") {
    fail("mcp.support", "must be bridge or disabled");
  }
  if (mcp.support === "disabled") {
    requireKnownFields(mcp, new Set(["reason", "support"]), new Set(["support"]), "mcp");
    if (mcp.reason !== undefined && typeof mcp.reason !== "string") {
      fail("mcp.reason", "must be a string");
    }
    return;
  }

  requireKnownFields(
    mcp,
    new Set(["adapter", "policy_binaries", "policy_presets", "reason", "support"]),
    new Set(["adapter", "support"]),
    "mcp",
  );
  requireCanonicalId(mcp.adapter, "mcp.adapter");
  if (!Array.isArray(mcp.policy_binaries) || mcp.policy_binaries.length === 0) {
    fail("mcp.policy_binaries", "must be a non-empty array when mcp.support is bridge");
  }
  const pathPattern = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\*?$/u;
  const seen = new Set<string>();
  mcp.policy_binaries.forEach((entry, index) => {
    const field = `mcp.policy_binaries[${String(index)}]`;
    if (
      typeof entry !== "string" ||
      CONTROL_CHARACTER_PATTERN.test(entry) ||
      entry.includes("\\") ||
      !pathPattern.test(entry) ||
      seen.has(entry)
    ) {
      fail(field, "must be a unique canonical absolute binary path with only a trailing wildcard");
    }
    seen.add(entry);
  });
  if (mcp.policy_presets !== undefined) {
    if (
      !Array.isArray(mcp.policy_presets) ||
      mcp.policy_presets.length > 64 ||
      new Set(mcp.policy_presets).size !== mcp.policy_presets.length ||
      mcp.policy_presets.some(
        (entry) => typeof entry !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entry),
      )
    ) {
      fail("mcp.policy_presets", "must contain unique canonical policy preset names");
    }
  }
  if (mcp.reason !== undefined && typeof mcp.reason !== "string") {
    fail("mcp.reason", "must be a string");
  }
}

function validateSessions(manifest: ManifestRecord): void {
  if (manifest.sessions === undefined) return;
  const sessions = requireRecord(manifest.sessions, "sessions");
  requireExactFields(sessions, new Set(["operations"]), "sessions");
  if (!Array.isArray(sessions.operations) || sessions.operations.length > 4) {
    fail("sessions.operations", "must be an array with at most four operations");
  }
  const allowed = new Set(["list", "delete", "reset", "export"]);
  if (
    new Set(sessions.operations).size !== sessions.operations.length ||
    sessions.operations.some((entry) => !allowed.has(entry as string))
  ) {
    fail("sessions.operations", "must contain unique list, delete, reset, or export operations");
  }
}

function validateMessaging(manifest: ManifestRecord): void {
  const messaging = requireRecord(manifest.messaging, "messaging");
  if (messaging.support === "disabled") {
    requireExactFields(messaging, new Set(["support"]), "messaging");
    return;
  }
  if (messaging.support !== "channels") fail("messaging.support", "must be channels or disabled");
  requireExactFields(messaging, new Set(["support", "channels"]), "messaging");
  if (
    !Array.isArray(messaging.channels) ||
    messaging.channels.length === 0 ||
    messaging.channels.length > 32 ||
    new Set(messaging.channels).size !== messaging.channels.length
  ) {
    fail("messaging.channels", "must be a unique list containing 1 through 32 channel identifiers");
  }
  messaging.channels.forEach((entry, index) => {
    requireCanonicalId(entry, `messaging.channels[${String(index)}]`);
  });
}

function validateWebSearch(manifest: ManifestRecord): void {
  if (manifest.web_search === undefined) return;
  const webSearch = requireRecord(manifest.web_search, "web_search");
  if (webSearch.support === "disabled") {
    requireExactFields(webSearch, new Set(["reason", "support"]), "web_search");
    const reason = requireString(webSearch.reason, "web_search.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("web_search.reason", "must be non-empty single-line text of at most 512 bytes");
    }
    return;
  }
  if (webSearch.support !== "providers") {
    fail("web_search.support", "must be providers or disabled");
  }
  requireKnownFields(
    webSearch,
    new Set(["providers", "support", "tool_gateway_conflicts"]),
    new Set(["providers", "support"]),
    "web_search",
  );
  if (
    !Array.isArray(webSearch.providers) ||
    webSearch.providers.length === 0 ||
    webSearch.providers.length > 2 ||
    new Set(webSearch.providers).size !== webSearch.providers.length ||
    webSearch.providers.some((provider) => provider !== "brave" && provider !== "tavily")
  ) {
    fail("web_search.providers", "must contain unique brave or tavily entries");
  }
  if (webSearch.tool_gateway_conflicts === undefined) return;
  if (
    !Array.isArray(webSearch.tool_gateway_conflicts) ||
    webSearch.tool_gateway_conflicts.length === 0 ||
    webSearch.tool_gateway_conflicts.length > 16
  ) {
    fail("web_search.tool_gateway_conflicts", "must contain 1 through 16 conflicts");
  }
  const seen = new Set<string>();
  webSearch.tool_gateway_conflicts.forEach((entry, index) => {
    const field = `web_search.tool_gateway_conflicts[${String(index)}]`;
    const conflict = requireRecord(entry, field);
    requireExactFields(conflict, new Set(["provider", "tool_gateway"]), field);
    if (conflict.provider !== "brave" && conflict.provider !== "tavily") {
      fail(`${field}.provider`, "must be brave or tavily");
    }
    requireCanonicalId(conflict.tool_gateway, `${field}.tool_gateway`);
    const key = `${String(conflict.provider)}\0${String(conflict.tool_gateway)}`;
    if (seen.has(key)) fail(field, "must not duplicate another conflict");
    if (!(webSearch.providers as unknown[]).includes(conflict.provider)) {
      fail(`${field}.provider`, "must also appear in web_search.providers");
    }
    seen.add(key);
  });
}

function validateProviderBroker(manifest: ManifestRecord): void {
  if (manifest.provider_broker === undefined) return;
  const broker = requireRecord(manifest.provider_broker, "provider_broker");
  if (broker.support === "disabled") {
    requireExactFields(broker, new Set(["reason", "support"]), "provider_broker");
    const reason = requireString(broker.reason, "provider_broker.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("provider_broker.reason", "must be non-empty single-line text of at most 512 bytes");
    }
    return;
  }
  if (broker.support !== "managed") {
    fail("provider_broker.support", "must be managed or disabled");
  }
  requireExactFields(broker, new Set(["adapter", "operations", "support"]), "provider_broker");
  if (broker.adapter !== "provider-broker") {
    fail("provider_broker.adapter", "must be provider-broker");
  }
  const expected = ["describe-provider", "register-refresh-provider", "ensure-broker"];
  const operations = broker.operations;
  if (
    !Array.isArray(operations) ||
    operations.length !== expected.length ||
    new Set(operations).size !== operations.length ||
    expected.some((operation) => !operations.includes(operation))
  ) {
    fail("provider_broker.operations", "must contain the three provider-broker operations");
  }
}

function hasCanonicalSegments(value: string): boolean {
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        SAFE_PATH_SEGMENT_PATTERN.test(segment),
    );
}

function validateSandboxPath(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value) > 1024 ||
    !value.startsWith("/sandbox/") ||
    !isCanonicalRelativePath(value.slice("/sandbox/".length)) ||
    !hasCanonicalSegments(value.slice("/sandbox/".length))
  ) {
    fail(field, "must be a canonical path below /sandbox");
  }
}

function validateSkills(manifest: ManifestRecord): void {
  if (manifest.skills === undefined) return;
  const skills = requireRecord(manifest.skills, "skills");
  if (skills.support === "disabled") {
    requireExactFields(skills, new Set(["support", "reason"]), "skills");
    const reason = requireString(skills.reason, "skills.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("skills.reason", "must be a non-empty single-line string of at most 512 bytes");
    }
    return;
  }
  if (skills.support !== "managed") fail("skills.support", "must be managed or disabled");
  requireKnownFields(
    skills,
    new Set(["activation", "collision", "install_root", "mirror_root", "removal", "support"]),
    new Set(["activation", "collision", "install_root", "removal", "support"]),
    "skills",
  );
  validateSandboxPath(skills.install_root, "skills.install_root");
  if (skills.collision !== "replace" && skills.collision !== "refuse") {
    fail("skills.collision", "must be replace or refuse");
  }
  if (skills.removal !== "remove" && skills.removal !== "refuse") {
    fail("skills.removal", "must be remove or refuse");
  }
  if (skills.mirror_root !== undefined) {
    const mirror = requireString(skills.mirror_root, "skills.mirror_root");
    const relative = mirror.startsWith("$HOME/") ? mirror.slice("$HOME/".length) : "";
    if (
      utf8ByteLength(mirror) > 1024 ||
      !isCanonicalRelativePath(relative) ||
      !hasCanonicalSegments(relative)
    ) {
      fail("skills.mirror_root", "must be a canonical path below $HOME");
    }
    if (skills.collision !== "replace") fail("skills.mirror_root", "requires collision: replace");
  }
  if (skills.collision === "refuse" && skills.removal !== "refuse") {
    fail("skills.removal", "must be refuse when collision is refuse");
  }

  const activation = requireRecord(skills.activation, "skills.activation");
  if (activation.kind === "reset-session-index") {
    requireExactFields(activation, new Set(["kind", "path"]), "skills.activation");
    validateSandboxPath(activation.path, "skills.activation.path");
    return;
  }
  requireExactFields(activation, new Set(["kind"]), "skills.activation");
  if (activation.kind !== "new-session" && activation.kind !== "gateway-restart-required") {
    fail(
      "skills.activation.kind",
      "must be new-session, gateway-restart-required, or reset-session-index",
    );
  }
}

/** Validate independently consumable MCP, session, messaging, and skill declarations. */
export function validateHarnessCapabilities(manifest: ManifestRecord): void {
  validateMcp(manifest);
  validateSessions(manifest);
  validateMessaging(manifest);
  validateWebSearch(manifest);
  validateSkills(manifest);
  validateProviderBroker(manifest);
}
