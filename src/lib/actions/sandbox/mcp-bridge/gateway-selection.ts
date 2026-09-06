// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../../adapters/openshell/runtime-selection";
import {
  recoverNamedGatewayRuntime,
  replaceOpenShellRuntimeSelectionEnv,
} from "../../../gateway-runtime-action";
import { getSandboxTargetGatewayName } from "../gateway-target";
import { McpBridgeError } from "./error";

/** Select the sandbox's recorded healthy gateway before mutating MCP resources. */
export async function ensureSandboxGatewaySelected(
  sandboxName: string,
  runtimeSelection: OpenShellRuntimeSelection,
): Promise<void> {
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const recovery = await recoverNamedGatewayRuntime({ gatewayName, runtimeSelection });
  if (!recovery.recovered || recovery.after.state !== "healthy_named") {
    throw new McpBridgeError(
      `Could not select healthy OpenShell gateway '${gatewayName}' for sandbox '${sandboxName}' (before: ${recovery.before.state}, after: ${recovery.after.state}). Refusing to mutate MCP resources on another gateway.`,
    );
  }
  // Pin every subsequent OpenShell subprocess in this lifecycle operation to
  // the sandbox's recorded gateway. The globally selected gateway is mutable
  // shared metadata and another NemoClaw process may select a sibling between
  // this health check and the provider/policy mutation.
  replaceOpenShellRuntimeSelectionEnv(process.env, runtimeSelection);
}
