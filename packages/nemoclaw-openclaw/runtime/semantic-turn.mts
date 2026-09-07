// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import type {
  HarnessSemanticTurnEvent,
  HarnessSemanticTurnFailureReason,
  HarnessSemanticTurnRequest,
} from "@nvidia/nemoclaw-harness-contract";

const OPENCLAW_PROTOCOL_VERSION = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_FRAME_BYTES = MAX_RESPONSE_BYTES + 64 * 1024;
const MAX_NATIVE_TURN_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_RUN_ID_BYTES = 256;
const MAX_QUEUED_CHAT_EVENTS = 128;
const MAX_REQUEST_BYTES = 64 * 1024;
const SUCCESS_RESPONSE_KEYS = ["id", "ok", "payload", "type"].join("\0");

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type OpenClawWebSocketFactory = (url: string) => WebSocketLike;

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: () => void;
  readonly timer: NodeJS.Timeout;
}

interface NativeChatEvent {
  readonly payload: Record<string, unknown>;
}

type OpenClawTurnEvent =
  | { readonly type: "started" }
  | { readonly type: "text"; readonly text: string };

type OpenClawTurnResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed"; readonly reason: HarnessSemanticTurnFailureReason };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactSuccessfulResponsePayload(
  frame: Record<string, unknown>,
): Record<string, unknown> | null {
  if (frame.ok !== true || Object.keys(frame).sort().join("\0") !== SUCCESS_RESPONSE_KEYS) {
    return null;
  }
  return record(frame.payload);
}

function isConnectResponsePayload(payload: Record<string, unknown>): boolean {
  return payload.type === "hello-ok" && payload.protocol === OPENCLAW_PROTOCOL_VERSION;
}

function chatSendRunId(payload: Record<string, unknown>): string | null {
  if (payload.status !== "started" && payload.status !== "in_flight") return null;
  const runId = payload.runId;
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    Buffer.byteLength(runId) > MAX_NATIVE_RUN_ID_BYTES ||
    /[\0\r\n]/u.test(runId)
  ) {
    return null;
  }
  return runId;
}

function openClawSessionKey(request: HarnessSemanticTurnRequest): string | null {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(request.runtimeTarget)) {
    return null;
  }
  return `agent:${request.runtimeTarget}:${request.conversationKey}`;
}

function textFromAssistantMessage(message: unknown): string | null {
  const value = record(message);
  if (value?.role !== "assistant" || !Array.isArray(value.content)) return null;
  const text: string[] = [];
  for (const part of value.content) {
    const item = record(part);
    if (item?.type !== "text") continue;
    if (typeof item.text !== "string") return null;
    text.push(item.text);
  }
  return text.length > 0 ? text.join("\n") : null;
}

function parseNativeChatEvent(frame: Record<string, unknown>): NativeChatEvent | null {
  if (frame.type !== "event" || frame.event !== "chat") return null;
  const payload = record(frame.payload);
  return payload ? { payload } : null;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("WebSocket support is unavailable.");
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

export interface OpenClawSemanticTurnOptions {
  readonly gatewayUrl: string;
  readonly credential: string;
  readonly webSocketFactory?: OpenClawWebSocketFactory;
}

/** Confine OpenClaw authentication, native frames, and run IDs to this package. */
export class OpenClawSemanticTurn {
  private readonly gatewayUrl: string;
  private readonly credential: string;
  private readonly webSocketFactory: OpenClawWebSocketFactory;
  private socket: WebSocketLike | null = null;
  private closed = false;
  private active = false;
  private cancelCurrent: (() => void) | null = null;

  constructor(options: OpenClawSemanticTurnOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.credential = options.credential;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  close(): void {
    this.closed = true;
    this.cancelCurrent?.();
    this.socket?.close();
    this.socket = null;
  }

  async runTurn(options: {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: OpenClawTurnEvent) => void;
    readonly sessionKey: string;
  }): Promise<OpenClawTurnResult> {
    if (this.closed || this.active) {
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }
    this.active = true;

    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(this.gatewayUrl);
      this.socket = socket;
    } catch {
      this.active = false;
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }

    const pending = new Map<string, PendingRequest>();
    const queuedChatEvents: NativeChatEvent[] = [];
    let requestCounter = 0;
    let activeRunId: string | null = null;
    let lastSequence: number | null = null;
    let nativeTurnBytes = 0;
    let projectedText = "";
    let terminal = false;

    const clearPending = () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject();
      }
      pending.clear();
    };
    const request = (method: string, params: Record<string, unknown>) => {
      const id = `voice-${++requestCounter}`;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("request timeout"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject: () => reject(new Error("request failed")), timer });
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      });
    };

    let resolveTerminal: (value: OpenClawTurnResult) => void = () => {};
    const terminalPromise = new Promise<OpenClawTurnResult>((resolve) => {
      resolveTerminal = resolve;
    });
    let settleOpen: (() => void) | null = null;
    const finish = (value: OpenClawTurnResult) => {
      if (terminal) return;
      terminal = true;
      this.active = false;
      this.cancelCurrent = null;
      clearPending();
      settleOpen?.();
      socket.close();
      resolveTerminal(value);
    };
    this.cancelCurrent = () => finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    const handleChat = (event: NativeChatEvent) => {
      const payload = event.payload;
      if (terminal || activeRunId === null) return;
      if (payload.sessionKey !== options.sessionKey || payload.runId !== activeRunId) return;

      const sequence = payload.seq;
      const state = payload.state;
      const finalSnapshot = state === "final" ? textFromAssistantMessage(payload.message) : null;
      const repeatsLastSequence = lastSequence !== null && sequence === lastSequence;
      if (
        typeof sequence !== "number" ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        (lastSequence !== null && sequence < lastSequence) ||
        (repeatsLastSequence && finalSnapshot === null)
      ) {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
        return;
      }
      lastSequence = sequence;

      if (state === "delta") {
        if (
          typeof payload.deltaText !== "string" ||
          (payload.replace !== undefined && typeof payload.replace !== "boolean")
        ) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        const deltaProjection =
          payload.replace === true ? payload.deltaText : `${projectedText}${payload.deltaText}`;
        const snapshot = textFromAssistantMessage(payload.message);
        const nextProjection = snapshot ?? deltaProjection;
        if (Buffer.byteLength(nextProjection) > MAX_RESPONSE_BYTES) {
          finish({ outcome: "failed", reason: "response_too_large" });
          return;
        }
        projectedText = nextProjection;
        return;
      }

      if (state === "final") {
        if (finalSnapshot !== null) projectedText = finalSnapshot;
        if (Buffer.byteLength(projectedText) > MAX_RESPONSE_BYTES) {
          finish({ outcome: "failed", reason: "response_too_large" });
          return;
        }
        if (projectedText.length > 0) options.onEvent({ type: "text", text: projectedText });
        finish({ outcome: "completed" });
      } else if (state === "error" || state === "aborted") {
        finish({ outcome: "failed", reason: "agent_failed" });
      } else {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
      }
    };

    socket.onmessage = (event) => {
      let frame: Record<string, unknown> | null = null;
      try {
        const raw = String(event.data);
        const frameBytes = Buffer.byteLength(raw);
        nativeTurnBytes += frameBytes;
        if (frameBytes > MAX_NATIVE_FRAME_BYTES || nativeTurnBytes > MAX_NATIVE_TURN_BYTES) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        frame = record(JSON.parse(raw));
      } catch {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
        return;
      }
      if (!frame) return;
      if (frame.type === "res" && typeof frame.id === "string") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (typeof frame.ok !== "boolean" || (frame.ok === true && frame.error !== undefined)) {
          entry.reject();
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        if (frame.ok === false) {
          entry.reject();
          return;
        }
        const payload = exactSuccessfulResponsePayload(frame);
        if (!payload) {
          entry.reject();
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        entry.resolve(payload);
        return;
      }
      const chat = parseNativeChatEvent(frame);
      if (!chat) return;
      if (activeRunId === null) {
        if (chat.payload.sessionKey !== options.sessionKey) return;
        if (queuedChatEvents.length >= MAX_QUEUED_CHAT_EVENTS) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        queuedChatEvents.push(chat);
      } else handleChat(chat);
    };
    let rejectOpen: (() => void) | null = null;
    socket.onerror = () => {
      rejectOpen?.();
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    };
    socket.onclose = () => {
      rejectOpen?.();
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("open timeout")), REQUEST_TIMEOUT_MS);
        settleOpen = () => {
          clearTimeout(timer);
          reject(new Error("turn terminal"));
        };
        rejectOpen = () => {
          clearTimeout(timer);
          reject(new Error("open failed"));
        };
        socket.onopen = () => {
          clearTimeout(timer);
          rejectOpen = null;
          settleOpen = null;
          resolve();
        };
      });
      const connected = await request("connect", {
        minProtocol: OPENCLAW_PROTOCOL_VERSION,
        maxProtocol: OPENCLAW_PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "NemoClaw semantic turn",
          version: "1",
          platform: process.platform,
          mode: "backend",
          instanceId: randomUUID(),
        },
        caps: [],
        scopes: ["operator.read", "operator.write"],
        auth: { token: this.credential },
      });
      if (terminal) return terminalPromise;
      if (!isConnectResponsePayload(connected)) {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
        return terminalPromise;
      }
      const sent = await request("chat.send", {
        sessionKey: options.sessionKey,
        message: options.message,
        deliver: false,
        timeoutMs: 90_000,
        idempotencyKey: options.idempotencyKey,
      });
      activeRunId = chatSendRunId(sent);
      if (!activeRunId) {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
      } else {
        options.onEvent({ type: "started" });
        for (const event of queuedChatEvents.splice(0)) handleChat(event);
      }
    } catch {
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    }

    return terminalPromise;
  }
}

function exactRequest(value: unknown): HarnessSemanticTurnRequest | null {
  const request = record(value);
  if (!request) return null;
  const keys = Object.keys(request).sort();
  if (
    keys.join("\0") !==
      ["conversationKey", "idempotencyKey", "message", "runtimeTarget", "type"].join("\0") ||
    request.type !== "turn" ||
    typeof request.message !== "string" ||
    request.message.length === 0 ||
    Buffer.byteLength(request.message) > 48 * 1024 ||
    request.message.includes("\0") ||
    typeof request.conversationKey !== "string" ||
    request.conversationKey.length === 0 ||
    request.conversationKey.length > 512 ||
    /[\0\r\n]/u.test(request.conversationKey) ||
    typeof request.runtimeTarget !== "string" ||
    request.runtimeTarget.length === 0 ||
    request.runtimeTarget.length > 128 ||
    /[\0\r\n]/u.test(request.runtimeTarget) ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length === 0 ||
    request.idempotencyKey.length > 256 ||
    /[\0\r\n]/u.test(request.idempotencyKey)
  ) {
    return null;
  }
  return request as unknown as HarnessSemanticTurnRequest;
}

async function readSemanticTurnRequest(
  input: NodeJS.ReadableStream,
): Promise<HarnessSemanticTurnRequest | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += data.byteLength;
    if (bytes > MAX_REQUEST_BYTES) return null;
    chunks.push(data);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) return null;
  try {
    return exactRequest(JSON.parse(raw.slice(0, -1)) as unknown);
  } catch {
    return null;
  }
}

function runtimeConnection(
  env: NodeJS.ProcessEnv,
): { gatewayUrl: string; credential: string } | null {
  const rawPort = env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const port = Number(rawPort);
  const credential = env.OPENCLAW_GATEWAY_TOKEN;
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    !credential ||
    Buffer.byteLength(credential) > 4096 ||
    !/^[\x21-\x7e]+$/u.test(credential)
  ) {
    return null;
  }
  return { gatewayUrl: `ws://127.0.0.1:${String(port)}/ws`, credential };
}

export async function runOpenClawSemanticTurnCommand(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: NodeJS.ReadableStream;
    readonly writeEvent?: (event: HarnessSemanticTurnEvent) => void;
    readonly webSocketFactory?: OpenClawWebSocketFactory;
  } = {},
): Promise<void> {
  const emit =
    options.writeEvent ??
    ((event: HarnessSemanticTurnEvent) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const request = await readSemanticTurnRequest(options.input ?? process.stdin);
  const connection = runtimeConnection(options.env ?? process.env);
  if (!request) {
    emit({ type: "failed", reason: "agent_protocol_error" });
    return;
  }
  if (!connection) {
    emit({ type: "failed", reason: "agent_gateway_unavailable" });
    return;
  }
  const sessionKey = openClawSessionKey(request);
  if (!sessionKey) {
    emit({ type: "failed", reason: "agent_protocol_error" });
    return;
  }

  const turn = new OpenClawSemanticTurn({
    ...connection,
    ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
  });
  const close = () => turn.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const result = await turn.runTurn({
      idempotencyKey: request.idempotencyKey,
      message: request.message,
      sessionKey,
      onEvent(event) {
        emit(event.type === "started" ? { type: "started" } : { type: "text", text: event.text });
      },
    });
    emit(
      result.outcome === "completed"
        ? { type: "completed" }
        : { type: "failed", reason: result.reason },
    );
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    turn.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOpenClawSemanticTurnCommand();
}
