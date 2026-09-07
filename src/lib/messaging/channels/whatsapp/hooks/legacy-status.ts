// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessWhatsappStatusProbe } from "@nvidia/nemoclaw-harness-contract";

/** Compatibility data for sandboxes created before package receipts owned messaging profiles. */
export interface LegacyWhatsappStatusProfile {
  readonly configRoot: string;
  readonly probe: HarnessWhatsappStatusProbe;
}

const LEGACY_STATUS_PROFILES: Readonly<Record<string, LegacyWhatsappStatusProfile>> = Object.freeze(
  {
    openclaw: {
      configRoot: "~/.openclaw",
      probe: {
        kind: "channel-status-json",
        command: {
          argv: ["openclaw", "channels", "status", "--channel", "whatsapp", "--json"],
        },
        timeoutOption: "--timeout",
        pairingCommand: {
          argv: ["openclaw", "channels", "login", "--channel", "whatsapp"],
        },
      },
    },
    hermes: {
      configRoot: "~/.hermes",
      probe: {
        kind: "session-files",
        primaryCredentialPath: "platforms/whatsapp/session/creds.json",
        alternateCredentialPath: "profiles/dashboard-home/platforms/whatsapp/session/creds.json",
        primaryLabel: "Hermes gateway",
        alternateLabel: "dashboard-home",
        pairingCommand: { argv: ["hermes", "whatsapp"] },
        configuredSessionPath: {
          configPath: "config.yaml",
          valuePath: ["platforms", "whatsapp", "extra", "session_path"],
        },
      },
    },
  },
);

/** Resolve exact historical behavior only when no receipt-backed profile exists. */
export function resolveLegacyWhatsappStatusProfile(
  agent: string,
): LegacyWhatsappStatusProfile | null {
  return LEGACY_STATUS_PROFILES[agent] ?? null;
}
