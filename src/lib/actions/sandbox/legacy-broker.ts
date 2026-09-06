// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { legacyHasManagedToolGateways } from "../../messaging/legacy-package";
import type { SandboxEntry } from "../../state/registry";

interface HermesToolGatewayBroker {
  ensureHermesToolGatewayBrokerForSandboxEntry(entry: SandboxEntry): unknown;
}

type LoadHermesToolGatewayBroker = () => HermesToolGatewayBroker;

function loadHermesToolGatewayBroker(): HermesToolGatewayBroker {
  return require("./legacy-hermes-tool-gateway-broker") as HermesToolGatewayBroker;
}

/**
 * Preserve the historical managed-tool broker only for sandboxes created
 * before package receipts. Receipt-backed packages must declare and own any
 * host lifecycle work through the typed package contract.
 */
export function ensureLegacyHermesToolBroker(
  sandbox: SandboxEntry | null,
  loadBroker: LoadHermesToolGatewayBroker = loadHermesToolGatewayBroker,
): void {
  if (!sandbox || !legacyHasManagedToolGateways(sandbox)) return;
  try {
    loadBroker().ensureHermesToolGatewayBrokerForSandboxEntry(sandbox);
  } catch {
    /* non-fatal — managed-tool calls will surface broker guidance if needed */
  }
}
