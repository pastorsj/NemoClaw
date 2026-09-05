// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

function buildMcpRegistrationPlan(request) {
  const server = request.entry.server;
  return {
    execution: {
      command: buildMcpRegistrationCommand(request),
      timeoutSeconds: 620,
      success: {
        kind: "lifecycle-json",
        requireReload: true,
        invalidResponseMessage: `Hermes MCP lifecycle command returned an invalid response for '${server}'.`,
        reloadRequiredMessage: `Hermes gateway was not running, so MCP server '${server}' was not loaded.`,
      },
      failureMessage: `Hermes MCP config registration failed for '${server}'.`,
    },
    verification: {
      kind: "inspection",
      failureMessage: `hermes-config config verification failed after adding '${server}'`,
    },
    credentialConvergence: {
      // Reloading Hermes can expose a later OpenShell credential revision.
      kind: "after-runtime-reload",
      unavailableMessage: `Hermes MCP credential revision was unavailable after reloading '${server}'.`,
      unstableMessage: `Hermes MCP credential revision did not converge after reloading '${server}'.`,
    },
  };
}

function buildMcpRemovalCommand(request) {
  return buildRemoveCommand(request.entry, request.force);
}

function buildMcpRemovalPlan(request) {
  const server = request.entry.server;
  return {
    execution: {
      command: buildMcpRemovalCommand(request),
      timeoutSeconds: 620,
      success: {
        kind: "lifecycle-json",
        requireReload: false,
        invalidResponseMessage: `Hermes MCP lifecycle command returned an invalid response for '${server}'.`,
        reloadRequiredMessage: `Hermes gateway was not running, so MCP server '${server}' was not removed from the running process.`,
      },
      failureMessage: `Hermes MCP config removal failed for '${server}'.`,
    },
    outcome: { kind: "removed" },
  };
}

function buildMcpInspectionCommand(request) {
  return buildStatusCommand(request.entry);
}

function describeMcpMutationCapability(request) {
  return {
    kind: "command",
    command: buildProbeCommand(),
    success: { kind: "last-json-line-ok" },
    timeoutSeconds: 30,
    failureMessage: `Hermes sandbox '${request.sandboxName}' cannot invoke the managed MCP transaction helper. Rebuild the sandbox before changing authenticated MCP state.`,
    retry: {
      outputExact: "Hermes gateway is not running for managed MCP reload",
      initialAttempts: 3,
      intervalMilliseconds: 1000,
    },
  };
}

function describeMcpTeardownCapability(request) {
  return describeMcpMutationCapability(request);
}

function describeMcpRuntimeIntentVerification(request) {
  const payload = buildIntentPayload(request.entries, request.managedServerNames);
  return {
    kind: "command",
    command: buildInspectCommand(JSON.stringify(payload)),
    success: { kind: "last-json-line-ok" },
    timeoutSeconds: 45,
    failureMessage: "Hermes MCP runtime does not match the persisted managed intent.",
    retry: {
      outputExact: "refusing raced Hermes MCP integrity snapshot",
      initialAttempts: 6,
      intervalMilliseconds: 500,
    },
  };
}

function buildMcpRuntimeCommand(request) {
  const runner =
    "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
  return ["/opt/hermes/.venv/bin/python", "-I", "-c", runner, ...request.command];
}

function buildMcpSnapshotRestorePlan() {
  return { kind: "not-required" };
}

module.exports = {
  HERMES_MCP_TRANSACTION_HELPER,
  buildInspectCommand,
  buildIntentPayload,
  buildMcpInspectionCommand,
  buildMcpRegistrationCommand,
  buildMcpRegistrationPlan,
  buildMcpRemovalCommand,
  buildMcpRemovalPlan,
  buildMcpRuntimeCommand,
  buildMcpSnapshotRestorePlan,
  buildProbeCommand,
  buildRegisterCommand,
  buildRemoveCommand,
  buildStatusCommand,
  describeMcpMutationCapability,
  describeMcpRuntimeIntentVerification,
  describeMcpTeardownCapability,
  managedServerConfig,
};
