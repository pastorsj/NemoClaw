// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function buildSecretAbsenceProbe(paths: string[], secrets: string[]): string {
  return [
    "set -eu",
    ...secrets.map(
      (secret) => `! grep -R ${JSON.stringify(secret)} ${paths.join(" ")} 2>/dev/null`,
    ),
  ].join("\n");
}

export function buildMcpAddArgs(
  sandboxName: string,
  serverName: string,
  mcpUrl: string,
  deniedTool?: string,
): string[] {
  return [
    sandboxName,
    "mcp",
    "add",
    serverName,
    "--url",
    mcpUrl,
    "--env",
    "FAKE_MCP_SECRET",
    ...(deniedTool ? ["--deny-tool", deniedTool] : []),
  ];
}

export function buildDeepAgentsConfigProbe(
  serverName: string,
  mcpUrl: string,
  authorizationPattern: string,
  hostSecret: string,
): string {
  return [
    "set -eu",
    "python3 - <<'PY'",
    "import json, pathlib, re",
    "path = pathlib.Path('/sandbox/.deepagents/.nemoclaw-mcp.json')",
    "text = path.read_text(encoding='utf-8')",
    "data = json.loads(text)",
    `entry = data['mcpServers'][${JSON.stringify(serverName)}]`,
    "assert entry['type'] == 'http'",
    `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
    `assert re.fullmatch(${JSON.stringify(authorizationPattern)}, entry['headers']['Authorization'])`,
    `assert ${JSON.stringify(hostSecret)} not in text`,
    "PY",
  ].join("\n");
}
