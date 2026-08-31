// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * Provides the narrow GatewayConfig surface used by package-owned guard tests.
 * The production guard imports Hermes' bundled gateway.config module.
 */
function writeGatewayConfigStub(root: string): void {
  const pythonRoot = path.join(root, "python");
  const gatewayDir = path.join(pythonRoot, "gateway");
  fs.mkdirSync(gatewayDir, { recursive: true });
  fs.writeFileSync(path.join(gatewayDir, "__init__.py"), "", { mode: 0o600 });
  fs.writeFileSync(
    path.join(gatewayDir, "config.py"),
    [
      "class GatewayConfig:",
      "    @classmethod",
      "    def from_dict(cls, value):",
      "        if not isinstance(value, dict):",
      "            raise TypeError('Hermes configuration must be a mapping')",
      "        platforms = value.get('platforms')",
      "        if not isinstance(platforms, dict):",
      "            return cls()",
      "        teams = platforms.get('teams')",
      "        if not isinstance(teams, dict):",
      "            return cls()",
      "        home_channel = teams.get('home_channel')",
      "        if isinstance(home_channel, dict) and 'platform' not in home_channel:",
      "            raise KeyError('platform')",
      "        return cls()",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

export function gatewayConfigStubRoot(root: string): string {
  writeGatewayConfigStub(root);
  return path.join(root, "python");
}
