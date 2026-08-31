// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * Declare NemoClaw lifecycle authority without consulting host service state.
 * Process-spawning tests use this fixture so they cannot detect or stop a real
 * OpenShell gateway service installed on the test machine.
 */
export function writeManagedGatewayDeclaration(directory: string): string {
  const declarationPath = path.join(directory, "gateway-management.json");
  fs.writeFileSync(
    declarationPath,
    JSON.stringify({
      version: 1,
      mode: "nemoclaw-managed",
      requiredCapabilities: [],
    }),
    { mode: 0o600 },
  );
  return declarationPath;
}
