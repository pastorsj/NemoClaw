// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from "node:http";

import { createVoiceGatewayServer } from "../../adapters/http/voice-gateway-server";
import {
  DEFAULT_VOICE_GATEWAY_LISTEN_PORT,
  VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD,
  VOICE_GATEWAY_FEATURE_ENV,
  VOICE_GATEWAY_LISTEN_ADDRESS,
  type AgentTurnClient,
  type VoiceGatewayDiagnostic,
} from "../../voice-gateway/contracts";
import { readPrivateBearerDescriptor } from "../../voice-gateway/credential-file";
import { createSandboxSemanticTurnClient } from "../../voice-gateway/semantic-turn";
import type { SandboxSemanticTurnBinding } from "../../voice-gateway/sandbox-authority";
import { VoiceSessionService } from "../../voice-gateway/session-service";

const MIN_SERVICE_PORT = 1024;
const MAX_SERVICE_PORT = 65_535;

type ServiceSignal = "SIGINT" | "SIGTERM";

interface ProcessEvents {
  once(event: ServiceSignal, listener: () => void): unknown;
  removeListener(event: ServiceSignal, listener: () => void): unknown;
}

export interface VoiceGatewayServeOptions {
  readonly runtimeIdentity: string;
  readonly runtimeProfile: string;
  readonly sandbox: string;
  readonly sandboxAuthority: SandboxSemanticTurnBinding;
  readonly agent: string;
  readonly turnTimeoutMs: number;
  readonly listenPort?: number;
}

export interface VoiceGatewayServeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly readBearerDescriptor?: typeof readPrivateBearerDescriptor;
  readonly createAgentTurnClient?: (sandboxName: string) => AgentTurnClient;
  readonly createServer?: typeof createVoiceGatewayServer;
  readonly processEvents?: ProcessEvents;
  readonly log?: (entry: VoiceGatewayDiagnostic) => void;
}

export function assertVoiceGatewayEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[VOICE_GATEWAY_FEATURE_ENV] !== "1") {
    throw new Error(
      `Experimental voice gateway is disabled; set ${VOICE_GATEWAY_FEATURE_ENV}=1 to enable this command.`,
    );
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < MIN_SERVICE_PORT || port > MAX_SERVICE_PORT) {
    throw new Error(
      `Voice gateway listen port must be an integer between ${MIN_SERVICE_PORT} and ${MAX_SERVICE_PORT}.`,
    );
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, VOICE_GATEWAY_LISTEN_ADDRESS, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Runs the experimental loopback voice gateway until interrupted. */
export async function runVoiceGatewayServe(
  options: VoiceGatewayServeOptions,
  deps: VoiceGatewayServeDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  assertVoiceGatewayEnabled(env);
  const listenPort = options.listenPort ?? DEFAULT_VOICE_GATEWAY_LISTEN_PORT;
  validatePort(listenPort);

  const readBearerDescriptor = deps.readBearerDescriptor ?? readPrivateBearerDescriptor;
  const deploymentCredential = readBearerDescriptor(VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD);
  const log =
    deps.log ??
    ((entry: VoiceGatewayDiagnostic) => {
      console.log(JSON.stringify(entry));
    });
  const service = new VoiceSessionService({
    runtimeIdentity: options.runtimeIdentity,
    runtimeProfile: options.runtimeProfile,
    sandbox: options.sandbox,
    agent: options.agent,
    createClient: () =>
      deps.createAgentTurnClient
        ? deps.createAgentTurnClient(options.sandbox)
        : createSandboxSemanticTurnClient(options.sandbox, {
            expectedAuthority: options.sandboxAuthority,
          }),
    diagnostic: log,
    turnTimeoutMs: options.turnTimeoutMs,
  });
  const createServer = deps.createServer ?? createVoiceGatewayServer;
  const server = createServer({ deploymentCredential, service });
  const processEvents = deps.processEvents ?? process;

  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: Error) => void = () => {};
  const shutdown = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const onSigint = () => resolveShutdown();
  const onSigterm = () => resolveShutdown();
  const onClose = () => resolveShutdown();
  const onError = (_error: Error) => rejectShutdown(new Error("Voice gateway listener failed."));
  processEvents.once("SIGINT", onSigint);
  processEvents.once("SIGTERM", onSigterm);

  try {
    await listen(server, listenPort);
    server.once("close", onClose);
    server.once("error", onError);
    log({
      event: "voice_gateway",
      state: "listening",
      runtimeIdentity: options.runtimeIdentity,
      runtimeProfile: options.runtimeProfile,
      sandbox: options.sandbox,
      agent: options.agent,
    });
    await shutdown;
  } finally {
    processEvents.removeListener("SIGINT", onSigint);
    processEvents.removeListener("SIGTERM", onSigterm);
    server.removeListener("close", onClose);
    server.removeListener("error", onError);
    service.closeAll();
    await closeServer(server);
    log({
      event: "voice_gateway",
      state: "stopped",
      runtimeIdentity: options.runtimeIdentity,
      runtimeProfile: options.runtimeProfile,
      sandbox: options.sandbox,
      agent: options.agent,
    });
  }
}
