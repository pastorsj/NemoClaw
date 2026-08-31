// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";

function pythonJsonLiteral(value) {
  return JSON.stringify(JSON.stringify(value));
}

function managedServerConfig(entry) {
  return {
    url: entry.url,
    enabled: true,
    timeout: 120,
    connect_timeout: 60,
    tools: { resources: true, prompts: true },
    ...(Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {}),
  };
}

function buildIntentPayload(entries, managedServerNames) {
  const sortedEntries = [...entries].sort((left, right) => left.server.localeCompare(right.server));
  const present = Object.fromEntries(
    sortedEntries.map((entry) => [entry.server, managedServerConfig(entry)]),
  );
  const presentNames = new Set(Object.keys(present));
  const absent = [...new Set(managedServerNames)].filter((name) => !presentNames.has(name)).sort();
  return { present, absent };
}

function buildRegisterCommand(entry, replaceExisting = false) {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entry.headers,
    replace_existing: replaceExisting,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "add", "--payload", JSON.stringify(payload)];
}

function buildRemoveCommand(entry, force = false) {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entry.headers,
    force,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "remove", "--payload", JSON.stringify(payload)];
}

function buildProbeCommand() {
  return [HERMES_MCP_TRANSACTION_HELPER, "probe"];
}

function buildInspectCommand(payload) {
  return [HERMES_MCP_TRANSACTION_HELPER, "inspect", "--payload", payload];
}

function buildStatusCommand(entry) {
  const payload = { server: entry.server, expected: managedServerConfig(entry) };
  return [
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import json, pathlib, yaml",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    'config_path = pathlib.Path("/sandbox/.hermes/config.yaml")',
    "data = yaml.safe_load(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}",
    "servers = data.get('mcp_servers') if isinstance(data, dict) else None",
    "present = isinstance(servers, dict) and payload['server'] in servers",
    "server = servers.get(payload['server']) if present else None",
    "ok = server == payload['expected']",
    "print('registered' if ok else ('mismatch' if present else 'absent'))",
    "PY",
  ].join("\n");
}

function buildMcpRegistrationCommand(request) {
  return buildRegisterCommand(request.entry, request.replaceExisting);
}

function buildMcpRemovalCommand(request) {
  return buildRemoveCommand(request.entry, request.force);
}

module.exports = {
  HERMES_MCP_TRANSACTION_HELPER,
  buildInspectCommand,
  buildIntentPayload,
  buildMcpRegistrationCommand,
  buildMcpRemovalCommand,
  buildProbeCommand,
  buildRegisterCommand,
  buildRemoveCommand,
  buildStatusCommand,
  managedServerConfig,
};
