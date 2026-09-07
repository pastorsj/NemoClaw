// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http, { type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createVoiceGatewayServer } from "../../../src/lib/adapters/http/voice-gateway-server";
import type { AgentTurnClient, AgentTurnEvent } from "../../../src/lib/voice-gateway/contracts";
import { VoiceSessionService } from "../../../src/lib/voice-gateway/session-service";
import { PinnedVoiceRuntimeAdapter } from "../../fixtures/voice-gateway/pinned-runtime-adapter";

const DEPLOYMENT_BEARER = "deployment-bearer-for-voice-gateway-tests";
const NATIVE_AUTHORITY_SENTINEL = "package-native-authority-must-not-cross";
const servers = new Set<Server>();

class FakeSemanticTurnClient implements AgentTurnClient {
  readonly calls: Array<{
    conversationKey: string;
    idempotencyKey: string;
    message: string;
    runtimeTarget: string;
  }> = [];
  closed = false;

  close(): void {
    this.closed = true;
  }

  async runTurn(options: {
    readonly conversationKey: string;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly runtimeTarget: string;
  }): ReturnType<AgentTurnClient["runTurn"]> {
    this.calls.push({
      conversationKey: options.conversationKey,
      idempotencyKey: options.idempotencyKey,
      message: options.message,
      runtimeTarget: options.runtimeTarget,
    });
    options.onEvent({ type: "started" });
    options.onEvent({ type: "text", text: "working tree " });
    options.onEvent({ type: "text", text: "is clean" });
    return { outcome: "completed" };
  }
}

async function listen(server: Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  expect(address).toBeTruthy();
  expect(typeof address).not.toBe("string");
  return (address as { readonly port: number }).port;
}

async function requestJson(options: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly bearer?: string;
  readonly body?: object;
}): Promise<{ readonly status: number; readonly body: string }> {
  const body = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...(body
            ? {
                "content-length": String(Buffer.byteLength(body)),
                "content-type": "application/json",
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          servers.delete(server);
          server.listening ? server.close(() => resolve()) : resolve();
        }),
    ),
  );
});

describe("experimental voice gateway composed boundary", () => {
  it("routes one committed turn through the runtime-neutral client (#8378)", async () => {
    const client = new FakeSemanticTurnClient();
    const ids = ["voice-session", "turn", "response"];
    const service = new VoiceSessionService({
      runtimeIdentity: "voice-runtime-local",
      runtimeProfile: "voice-runtime-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () => client,
      randomId: () => ids.shift() ?? "extra",
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const port = await listen(
      createVoiceGatewayServer({ deploymentCredential: DEPLOYMENT_BEARER, service }),
    );
    const output: string[] = [];
    const runtime = new PinnedVoiceRuntimeAdapter(port, DEPLOYMENT_BEARER, (text) =>
      output.push(text),
    );

    const session = await runtime.createSession("runtime-conversation");
    const events = await runtime.commitTurn(session, "runtime-commit", "repository status");
    await runtime.closeSession(session);

    expect(output.join("")).toBe("working tree is clean");
    expect(client.calls).toEqual([
      {
        conversationKey: expect.stringMatching(/^nemoclaw-voice:.+$/u),
        idempotencyKey: "turn",
        message: "repository status",
        runtimeTarget: "main",
      },
    ]);
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.completed",
    ]);
    expect(JSON.stringify({ session, events, output })).not.toContain(NATIVE_AUTHORITY_SENTINEL);
    expect(client.closed).toBe(true);
  });

  it("authenticates before admission parsing or client construction (#9411)", async () => {
    let clientsCreated = 0;
    const service = new VoiceSessionService({
      runtimeIdentity: "voice-runtime-local",
      runtimeProfile: "voice-runtime-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () => {
        clientsCreated += 1;
        return new FakeSemanticTurnClient();
      },
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const port = await listen(
      createVoiceGatewayServer({ deploymentCredential: DEPLOYMENT_BEARER, service }),
    );

    expect(
      await requestJson({
        port,
        method: "POST",
        path: "/v1/voice/sessions",
        body: { runtimeConversationId: "runtime-conversation" },
      }),
    ).toEqual({ status: 401, body: '{"error":"authentication_failed"}' });
    expect(
      await requestJson({
        port,
        method: "POST",
        path: "/v1/voice/sessions",
        bearer: DEPLOYMENT_BEARER,
        body: { runtimeConversationId: "../namespace-escape" },
      }),
    ).toEqual({ status: 400, body: '{"error":"invalid_request"}' });
    expect(clientsCreated).toBe(0);
  });
});
