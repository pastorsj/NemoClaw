// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import {
  assertVoiceGatewayEnabled,
  runVoiceGatewayServe,
} from "../../../lib/actions/voice-gateway/serve";
import { DEFAULT_VOICE_GATEWAY_LISTEN_PORT } from "../../../lib/voice-gateway/contracts";
import { parseSemanticTurnBinding } from "../../../lib/voice-gateway/sandbox-authority";
import { NemoClawInternalCommand } from "../../../lib/cli/internal-command";

export default class InternalVoiceGatewayServeCommand extends NemoClawInternalCommand {
  static strict = true;
  static summary = "Internal: serve the experimental voice gateway";
  static description =
    "Serve one authenticated runtime session through a private loopback HTTP and package-declared semantic-turn adapter. Reads the deployment credential from descriptor 3.";
  static usage = [
    "internal voice-gateway serve --runtime-identity <id> --runtime-profile <id> --sandbox <name> --sandbox-authority <binding> --agent <id> --turn-timeout-ms <milliseconds> [--listen-port <port>]",
  ];
  static flags = {
    "runtime-identity": Flags.string({
      description: "Trusted local runtime deployment identity",
      required: true,
    }),
    "runtime-profile": Flags.string({
      description: "Operator-selected runtime profile",
      required: true,
    }),
    sandbox: Flags.string({
      description: "Operator-selected sandbox",
      required: true,
    }),
    "sandbox-authority": Flags.string({
      description: "Trusted secret-free sandbox generation authority",
      required: true,
    }),
    agent: Flags.string({
      description: "Operator-selected package agent",
      required: true,
    }),
    "listen-port": Flags.integer({
      default: DEFAULT_VOICE_GATEWAY_LISTEN_PORT,
      description: "Loopback port for the private runtime adapter",
      min: 1024,
      max: 65_535,
    }),
    "turn-timeout-ms": Flags.integer({
      description: "Package-declared semantic-turn timeout in milliseconds",
      required: true,
      min: 1_000,
      max: 300_000,
    }),
  };

  public async run(): Promise<void> {
    assertVoiceGatewayEnabled();
    const { flags } = await this.parse(InternalVoiceGatewayServeCommand);
    const sandboxAuthority = parseSemanticTurnBinding(flags["sandbox-authority"]);
    if (sandboxAuthority.sandboxName !== flags.sandbox) {
      throw new Error("Voice gateway sandbox authority does not match the requested sandbox.");
    }
    await runVoiceGatewayServe({
      runtimeIdentity: flags["runtime-identity"],
      runtimeProfile: flags["runtime-profile"],
      sandbox: flags.sandbox,
      sandboxAuthority,
      agent: flags.agent,
      turnTimeoutMs: flags["turn-timeout-ms"],
      listenPort: flags["listen-port"],
    });
  }
}
