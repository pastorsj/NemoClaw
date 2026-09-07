// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  OpenClawSemanticTurn,
  runOpenClawSemanticTurnCommand,
} from "../../runtime/semantic-turn.mts";
import type { HarnessSemanticTurnEvent } from "@nvidia/nemoclaw-harness-contract";

type SemanticTurnEvent =
  | { readonly type: "started" }
  | { readonly type: "text"; readonly text: string };

interface SentRequest {
  readonly type: string;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Handler = (request: SentRequest, socket: FakeWebSocket) => void;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: SentRequest[] = [];
  closed = false;

  constructor(private readonly handlers: Record<string, Handler>) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const request = JSON.parse(data) as SentRequest;
    this.sent.push(request);
    queueMicrotask(() => this.handlers[request.method]?.(request, this));
  }

  close(): void {
    this.closed = true;
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  respond(id: string, payload: Record<string, unknown>): void {
    this.receive({ type: "res", id, ok: true, payload });
  }

  chat(payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "chat",
        payload: { ...payload, nativeSecret: "must-not-cross" },
      }),
    });
  }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1_786_032_000_000,
  };
}

function helloPayload(): Record<string, unknown> {
  return { type: "hello-ok", protocol: 4 };
}

function chatSendPayload(runId = "expected-run"): Record<string, unknown> {
  return { runId, status: "started" };
}

type DeliverReply = (emit: () => void, respond: () => void) => void;

function replyHandlersWithDelivery(
  frames: ReadonlyArray<Record<string, unknown>>,
  deliver: DeliverReply,
): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.respond(request.id, helloPayload()),
    "chat.send": (request, socket) => {
      const sessionKey = String(request.params.sessionKey);
      const emit = () => {
        for (const frame of frames) socket.chat({ sessionKey, runId: "expected-run", ...frame });
      };
      const respond = () => socket.respond(request.id, chatSendPayload());
      deliver(emit, respond);
    },
  };
}

function replyHandlers(frames: ReadonlyArray<Record<string, unknown>>): Record<string, Handler> {
  return replyHandlersWithDelivery(frames, (emit, respond) => {
    respond();
    queueMicrotask(emit);
  });
}

function replyBeforeResponseHandlers(
  frames: ReadonlyArray<Record<string, unknown>>,
): Record<string, Handler> {
  return replyHandlersWithDelivery(frames, (emit, respond) => {
    emit();
    respond();
  });
}

function activeTurnHandlers(): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.respond(request.id, helloPayload()),
    "chat.send": (request, socket) => socket.respond(request.id, chatSendPayload()),
  };
}

function oversizedFrameHandlers(): Record<string, Handler> {
  return {
    connect: (request, socket) => {
      socket.respond(request.id, helloPayload());
      socket.onmessage?.({ data: `{"padding":"${"x".repeat(3 * 1024 * 1024)}"}` });
    },
  };
}

function aggregateOversizedFrameHandlers(): Record<string, Handler> {
  const padding = "x".repeat(256 * 1024);
  return {
    connect: (request, socket) => {
      socket.respond(request.id, helloPayload());
      for (let sequence = 0; sequence < 40 && !socket.closed; sequence += 1) {
        socket.chat({
          sessionKey: "other-session",
          runId: "other-run",
          seq: sequence,
          state: "delta",
          deltaText: "ignored",
          padding,
        });
      }
    },
  };
}

type NativeResponseFactory = (id: string) => Record<string, unknown>;

function connectResponseHandlers(createResponse: NativeResponseFactory): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.receive(createResponse(request.id)),
  };
}

function chatSendResponseHandlers(createResponse: NativeResponseFactory): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.respond(request.id, helloPayload()),
    "chat.send": (request, socket) => socket.receive(createResponse(request.id)),
  };
}

async function runTurn(handlers: Record<string, Handler>): Promise<{
  readonly result: Awaited<ReturnType<OpenClawSemanticTurn["runTurn"]>>;
  readonly events: SemanticTurnEvent[];
  readonly socket: FakeWebSocket;
}> {
  const socket = new FakeWebSocket(handlers);
  const events: SemanticTurnEvent[] = [];
  const client = new OpenClawSemanticTurn({
    gatewayUrl: "ws://127.0.0.1:18789/ws",
    credential: "openclaw-credential-must-not-cross",
    webSocketFactory: () => socket,
  });
  const result = await client.runTurn({
    sessionKey: "agent:main:nemoclaw-voice:session",
    idempotencyKey: "generated-turn-id",
    message: "repository status",
    onEvent: (event) => events.push(event),
  });
  return { result, events, socket };
}

describe("OpenClaw package semantic-turn adapter", () => {
  it("accepts the managed startup environment in both supported ownership modes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-semantic-env-"));
    const environmentPath = path.join(root, "proxy-env.sh");
    const wrapperPath = fileURLToPath(new URL("../../runtime/semantic-turn.sh", import.meta.url));
    try {
      fs.writeFileSync(environmentPath, "export OPENCLAW_GATEWAY_PORT=18789\n", { mode: 0o444 });
      const accepted = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; validate_semantic_turn_environment "$2"',
          "semantic-turn-check",
          wrapperPath,
          environmentPath,
        ],
        { encoding: "utf8" },
      );
      expect(accepted.status).toBe(0);

      fs.chmodSync(environmentPath, 0o644);
      const writable = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; validate_semantic_turn_environment "$2"',
          "semantic-turn-check",
          wrapperPath,
          environmentPath,
        ],
        { encoding: "utf8" },
      );
      expect(writable.status).toBe(126);
      expect(writable.stderr).toContain("runtime environment is unsafe");

      const symlinkPath = path.join(root, "proxy-env-link.sh");
      fs.symlinkSync(environmentPath, symlinkPath);
      const symlink = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; validate_semantic_turn_environment "$2"',
          "semantic-turn-check",
          wrapperPath,
          symlinkPath,
        ],
        { encoding: "utf8" },
      );
      expect(symlink.status).toBe(126);
      expect(symlink.stderr).toContain("runtime environment is unavailable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("translates the fixed command request into finite semantic-turn events", async () => {
    let socket: FakeWebSocket | undefined;
    const events: HarnessSemanticTurnEvent[] = [];

    await runOpenClawSemanticTurnCommand({
      env: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "openclaw-credential-must-not-cross",
      },
      input: Readable.from([
        `${JSON.stringify({
          type: "turn",
          message: "repository status",
          conversationKey: "nemoclaw-voice:session",
          runtimeTarget: "main",
          idempotencyKey: "generated-turn-id",
        })}\n`,
      ]),
      writeEvent: (event) => events.push(event),
      webSocketFactory: () => {
        socket = new FakeWebSocket(
          replyHandlers([
            { seq: 0, state: "delta", deltaText: "hello" },
            { seq: 1, state: "final" },
          ]),
        );
        return socket;
      },
    });

    expect(events).toEqual([
      { type: "started" },
      { type: "text", text: "hello" },
      { type: "completed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("openclaw-credential");
    expect(JSON.stringify(events)).not.toContain("expected-run");
    expect(socket?.sent.find((request) => request.method === "chat.send")?.params.sessionKey).toBe(
      "agent:main:nemoclaw-voice:session",
    );
    expect(socket?.closed).toBe(true);
  });

  it("rejects a runtime target that cannot form an OpenClaw session key", async () => {
    const events: HarnessSemanticTurnEvent[] = [];
    const webSocketFactory = vi.fn();

    await runOpenClawSemanticTurnCommand({
      env: { OPENCLAW_GATEWAY_TOKEN: "openclaw-credential-must-not-cross" },
      input: Readable.from([
        `${JSON.stringify({
          type: "turn",
          message: "repository status",
          conversationKey: "nemoclaw-voice:session",
          runtimeTarget: "agent:secondary",
          idempotencyKey: "generated-turn-id",
        })}\n`,
      ]),
      writeEvent: (event) => events.push(event),
      webSocketFactory,
    });

    expect(events).toEqual([{ type: "failed", reason: "agent_protocol_error" }]);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("rejects command requests outside the exact semantic-turn schema", async () => {
    const events: HarnessSemanticTurnEvent[] = [];
    const webSocketFactory = vi.fn();

    await runOpenClawSemanticTurnCommand({
      env: { OPENCLAW_GATEWAY_TOKEN: "openclaw-credential-must-not-cross" },
      input: Readable.from([
        `${JSON.stringify({
          type: "turn",
          message: "repository status",
          conversationKey: "nemoclaw-voice:session",
          runtimeTarget: "main",
          idempotencyKey: "generated-turn-id",
          nativeOption: true,
        })}\n`,
      ]),
      writeEvent: (event) => events.push(event),
      webSocketFactory,
    });

    expect(events).toEqual([{ type: "failed", reason: "agent_protocol_error" }]);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("reports an unavailable gateway when its protected runtime token is absent", async () => {
    const events: HarnessSemanticTurnEvent[] = [];

    await runOpenClawSemanticTurnCommand({
      env: {},
      input: Readable.from([
        `${JSON.stringify({
          type: "turn",
          message: "repository status",
          conversationKey: "nemoclaw-voice:session",
          runtimeTarget: "main",
          idempotencyKey: "generated-turn-id",
        })}\n`,
      ]),
      writeEvent: (event) => events.push(event),
    });

    expect(events).toEqual([{ type: "failed", reason: "agent_gateway_unavailable" }]);
  });

  it("uses bounded operator scopes and returns only the expected session and run projection (#8482)", async () => {
    const handlers = replyHandlers([
      {
        sessionKey: "other-session",
        seq: 50,
        state: "delta",
        deltaText: "discarded session",
        message: assistantMessage("discarded session"),
      },
      {
        runId: "other-run",
        seq: 50,
        state: "delta",
        deltaText: "discarded run",
        message: assistantMessage("discarded run"),
      },
      { seq: 0, state: "delta", deltaText: "hel", message: assistantMessage("hel") },
      { seq: 1, state: "final", message: assistantMessage("hello") },
    ]);

    const { result, events, socket } = await runTurn(handlers);

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
    const connect = socket.sent.find((request) => request.method === "connect");
    expect(connect?.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      scopes: ["operator.read", "operator.write"],
      auth: { token: "openclaw-credential-must-not-cross" },
    });
    const send = socket.sent.find((request) => request.method === "chat.send");
    expect(send?.params).toMatchObject({
      sessionKey: "agent:main:nemoclaw-voice:session",
      message: "repository status",
      idempotencyKey: "generated-turn-id",
      deliver: false,
    });
    expect(JSON.stringify(events)).not.toContain("openclaw-credential");
    expect(JSON.stringify(events)).not.toContain("expected-run");
    expect(JSON.stringify(events)).not.toContain("must-not-cross");
  });

  it.each([
    ["a missing ok field", (id: string) => ({ type: "res", id, payload: helloPayload() })],
    [
      "a non-boolean ok field",
      (id: string) => ({ type: "res", id, ok: "true", payload: helloPayload() }),
    ],
    [
      "an error alongside ok",
      (id: string) => ({
        type: "res",
        id,
        ok: true,
        payload: helloPayload(),
        error: { code: "unexpected", message: "must not coexist with success" },
      }),
    ],
    ["a missing payload", (id: string) => ({ type: "res", id, ok: true })],
    ["a non-record payload", (id: string) => ({ type: "res", id, ok: true, payload: "hello-ok" })],
  ] satisfies ReadonlyArray<readonly [string, NativeResponseFactory]>)(
    "rejects a successful native response with %s",
    async (_name, createResponse) => {
      const { result, events, socket } = await runTurn(connectResponseHandlers(createResponse));

      expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
      expect(events).toEqual([]);
      expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
      expect(socket.closed).toBe(true);
    },
  );

  it.each([
    ["the wrong discriminator", { type: "welcome", protocol: 4 }],
    ["the wrong protocol", { type: "hello-ok", protocol: 3 }],
  ])("rejects a connect response payload with %s", async (_name, payload) => {
    const { result, events, socket } = await runTurn(
      connectResponseHandlers((id) => ({ type: "res", id, ok: true, payload })),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([]);
    expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
  });

  it.each([
    ["a missing run ID", { status: "started" }],
    ["a non-started status", { runId: "expected-run", status: "completed" }],
    ["an oversized run ID", chatSendPayload("x".repeat(257))],
  ])("rejects a chat.send response payload with %s before starting", async (_name, payload) => {
    const { result, events, socket } = await runTurn(
      chatSendResponseHandlers((id) => ({ type: "res", id, ok: true, payload })),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it("rejects a chat.send run ID outside the exact response payload", async () => {
    const { result, events, socket } = await runTurn(
      chatSendResponseHandlers((id) => ({
        type: "res",
        id,
        ok: true,
        payload: chatSendPayload(),
        runId: "top-level-run",
      })),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it("recovers an omitted earlier delta from a later cumulative message (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        {
          seq: 2,
          state: "delta",
          deltaText: "world",
          message: assistantMessage("Hello world"),
        },
        { seq: 3, state: "final", message: assistantMessage("Hello world") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world" }]);
  });

  it("reconciles a recognized final message before completion (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "Hello" },
        { seq: 1, state: "final", message: assistantMessage("Hello world") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world" }]);
  });

  it("accepts a final response that repeats the last sequence and contains assistant text (#9243)", async () => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 2, state: "delta", deltaText: "world", message: assistantMessage("Hello world") },
        { seq: 7, state: "delta", deltaText: "", message: assistantMessage("Hello world") },
        {
          sessionKey: "other-session",
          seq: 7,
          state: "final",
          message: assistantMessage("discarded session"),
        },
        {
          runId: "other-run",
          seq: 7,
          state: "final",
          message: assistantMessage("discarded run"),
        },
        { seq: 7, state: "final", message: assistantMessage("Hello world!") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world!" }]);
    expect(socket.closed).toBe(true);
  });

  it("accepts schema-minimum deltas without optional messages (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "hel" },
        { seq: 1, state: "delta", deltaText: "lo" },
        { seq: 2, state: "final" },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
  });

  it("returns the replacement projection without exposing superseded text (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "superseded" },
        { seq: 1, state: "delta", deltaText: "final", replace: true },
        { seq: 2, state: "final", message: assistantMessage("final") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "final" }]);
  });

  it("falls back to canonical deltas when optional messages are unrecognized (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        {
          seq: 0,
          state: "delta",
          deltaText: "hel",
          message: { role: "user", content: [{ type: "text", text: "untrusted" }] },
        },
        {
          seq: 1,
          state: "delta",
          deltaText: "lo",
          message: { role: "assistant", content: [{ type: "text", text: 7 }] },
        },
        { seq: 2, state: "final", message: { role: "assistant", content: "unrecognized" } },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
  });

  it.each([
    ["seq field", { state: "delta", deltaText: "message-only", message: assistantMessage("text") }],
    ["deltaText field", { seq: 0, state: "delta", message: assistantMessage("text") }],
    ["replace field", { seq: 0, state: "delta", deltaText: "text", replace: "yes" }],
  ])("rejects a delta with an invalid %s (#8482)", async (_name, frame) => {
    const { result, events } = await runTurn(replyHandlers([frame]));

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
  });

  it.each([
    ["duplicate", 1],
    ["decreasing", 0],
  ])("rejects a %s sequence before returning response text (#8482)", async (_name, sequence) => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 1, state: "delta", deltaText: "first" },
        { seq: sequence, state: "delta", deltaText: "second" },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("rejects a final response with a lower sequence (#9243)", async () => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "first" },
        { seq: 6, state: "final", message: assistantMessage("complete") },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it.each([
    ["no message", undefined],
    ["a user message", { role: "user", content: [{ type: "text", text: "untrusted" }] }],
    ["non-text assistant content", { role: "assistant", content: [{ type: "image" }] }],
  ])("rejects an equal-sequence final response with %s (#9243)", async (_name, message) => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "partial" },
        { seq: 7, state: "final", message },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("discards malformed frames for another session or run before projection checks (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { sessionKey: "other-session", state: "delta", message: assistantMessage("discarded") },
        { runId: "other-run", state: "delta", message: assistantMessage("discarded") },
        { seq: 0, state: "delta", deltaText: "kept" },
        { seq: 1, state: "final" },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "kept" }]);
  });

  it("rejects a reconciled projection that exceeds the response bound (#8482)", async () => {
    const chunk = "x".repeat(VOICE_CHUNK_BYTES);
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: chunk },
        {
          seq: 1,
          state: "delta",
          deltaText: "x",
          message: assistantMessage(`${chunk}${chunk}`),
        },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "response_too_large" });
    expect(events).toEqual([{ type: "started" }]);
  });

  it("rejects an oversized equal-sequence final response (#9243)", async () => {
    const chunk = "x".repeat(VOICE_CHUNK_BYTES);
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "partial" },
        { seq: 7, state: "final", message: assistantMessage(`${chunk}${chunk}`) },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "response_too_large" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("rejects too many queued chat events before the run ID is admitted (#8482)", async () => {
    const frames = Array.from({ length: 129 }, (_, seq) => ({
      seq,
      state: "delta",
      deltaText: "x",
    }));
    const { result, events } = await runTurn(replyBeforeResponseHandlers(frames));

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([]);
  });

  it("closes the direct WebSocket connection when the session owner revokes it (#8378)", async () => {
    const socket = new FakeWebSocket(activeTurnHandlers());
    const client = new OpenClawSemanticTurn({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });
    const turn = client.runTurn({
      sessionKey: "agent:main:nemoclaw-voice:session",
      idempotencyKey: "generated-turn-id",
      message: "repository status",
      onEvent: () => {},
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((request) => request.method === "chat.send")).toBe(true),
    );

    client.close();

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
    expect(socket.closed).toBe(true);
  });

  it("refuses concurrent native turns", async () => {
    const socket = new FakeWebSocket(activeTurnHandlers());
    const client = new OpenClawSemanticTurn({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });
    const first = client.runTurn({
      sessionKey: "agent:main:nemoclaw-voice:session",
      idempotencyKey: "first-turn",
      message: "repository status",
      onEvent: () => {},
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((request) => request.method === "chat.send")).toBe(true),
    );

    await expect(
      client.runTurn({
        sessionKey: "agent:main:nemoclaw-voice:session",
        idempotencyKey: "second-turn",
        message: "another status",
        onEvent: () => {},
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });

    client.close();
    await first;
  });

  it("rejects an oversized native frame before sending agent work (#8378)", async () => {
    const { result, socket } = await runTurn(oversizedFrameHandlers());

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("rejects a native turn whose individually bounded frames exceed the aggregate budget", async () => {
    const { result, socket } = await runTurn(aggregateOversizedFrameHandlers());

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
    expect(socket.closed).toBe(true);
  });
});

const VOICE_CHUNK_BYTES = 1024 * 1024 + 1;
