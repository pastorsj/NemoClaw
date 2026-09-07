// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../src/lib/agent-runtime/package/types";
import type { SandboxEntry } from "../../src/lib/state/registry";
import { installHomeMcpHarnessPackageFixture } from "./harness-packages";

const preparedAuthorities = new Map<string, McpHarnessPackageAuthority>();

export interface McpHarnessPackageAuthority {
  readonly home: string;
  readonly registryAuthority: Pick<
    SandboxEntry,
    "agent" | "harnessPackage" | "harnessPackageMigration"
  >;
  readonly journalAuthority: {
    readonly harnessPackage: HarnessPackageIdentity;
    readonly harnessPackageMigration: HarnessPackageMigration;
  };
}

/** Install and return the exact migrated package authority owned by one MCP test HOME. */
export function prepareMcpHarnessPackageAuthority(home: string): McpHarnessPackageAuthority {
  if (fs.existsSync(home)) {
    const canonicalHome = fs.realpathSync(home);
    const existing = preparedAuthorities.get(canonicalHome);
    if (existing) return existing;
  }

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const canonicalHome = fs.realpathSync(home);
  fs.chmodSync(canonicalHome, 0o700);
  const installed = installHomeMcpHarnessPackageFixture(canonicalHome, "openclaw");
  const harnessPackageMigration = Object.freeze({
    schemaVersion: 1 as const,
    source: "legacy-current-bundle" as const,
    legacyAgent: "openclaw",
    migratedAt: "2026-08-30T00:00:00.000Z",
  });
  const authority = Object.freeze({
    home: canonicalHome,
    registryAuthority: Object.freeze({
      agent: "openclaw",
      harnessPackage: installed.identity,
      harnessPackageMigration,
    }),
    journalAuthority: Object.freeze({
      harnessPackage: installed.identity,
      harnessPackageMigration,
    }),
  });
  preparedAuthorities.set(canonicalHome, authority);
  return authority;
}

/** Preload a child process with the installed package receipt before it registers MCP state. */
export function authorizeMcpHarnessScript(
  home: string,
  script: string,
  options: { readonly delegateExecToProcessRecovery?: boolean } = {},
): string {
  const authority = prepareMcpHarnessPackageAuthority(home);
  const registryAuthority = JSON.stringify(authority.registryAuthority);
  const canonicalScript = script.replaceAll(JSON.stringify(home), JSON.stringify(authority.home));
  return `
process.env.HOME = ${JSON.stringify(authority.home)};
const __mcpHarnessRegistry = require("./src/lib/state/registry.js");
const __registerMcpHarnessSandbox = __mcpHarnessRegistry.registerSandbox;
__mcpHarnessRegistry.registerSandbox = (entry) =>
  __registerMcpHarnessSandbox({ ...entry, ...${registryAuthority} });
const __mcpHarnessGatewayRuntime = require("./src/lib/gateway-runtime-action.js");
__mcpHarnessGatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
const __mcpHarnessTransport = require("./src/lib/actions/sandbox/transport/command-execution.js");
const __mcpHarnessProcessRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
__mcpHarnessTransport.executeSandboxCommand = (...args) =>
  __mcpHarnessProcessRecovery.executeSandboxCommand(...args);
${
  options.delegateExecToProcessRecovery === false
    ? ""
    : `__mcpHarnessTransport.executeSandboxExecCommand = (...args) =>
  __mcpHarnessProcessRecovery.executeSandboxExecCommand(...args);`
}
${canonicalScript}
`;
}
