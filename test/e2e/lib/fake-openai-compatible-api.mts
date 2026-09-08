#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

const host = process.env.NEMOCLAW_FAKE_OPENAI_HOST || "127.0.0.1";
const port = Number(process.env.NEMOCLAW_FAKE_OPENAI_PORT || "0");
const portFile = process.env.NEMOCLAW_FAKE_OPENAI_PORT_FILE || "";
const logFile = process.env.NEMOCLAW_FAKE_OPENAI_LOG_FILE || "";
const requestsFile = process.env.NEMOCLAW_FAKE_OPENAI_REQUESTS_FILE || "";
const environmentFile = process.env.NEMOCLAW_FAKE_OPENAI_ENVIRONMENT_FILE || "";
const model = process.env.NEMOCLAW_FAKE_OPENAI_MODEL || "test-model";
// Optional runtime context window advertised on /v1/models, mirroring vLLM's
// max_model_len so onboarding can probe a real endpoint's context (#6177).
const maxModelLen = (() => {
  const raw = (process.env.NEMOCLAW_FAKE_OPENAI_MAX_MODEL_LEN || "").trim();
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
})();
const apiKey = process.env.NEMOCLAW_FAKE_OPENAI_API_KEY || "";
const requireAuth = process.env.NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH === "1";
// Opt-in auth enforcement on GET /v1/models specifically (real vLLM launched
// with --api-key gates it). Separate from requireAuth so existing tests, whose
// readiness probe hits /v1/models unauthenticated, keep working. See #6177.
const requireAuthModels = process.env.NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH_MODELS === "1";
const chatContent = process.env.NEMOCLAW_FAKE_OPENAI_CHAT_CONTENT || "ok";
const chatUsage = (() => {
  try {
    const parsed = JSON.parse(process.env.NEMOCLAW_FAKE_OPENAI_CHAT_USAGE || "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger(parsed.inputTokens) &&
      parsed.inputTokens >= 0 &&
      Number.isInteger(parsed.outputTokens) &&
      parsed.outputTokens >= 0 &&
      Number.isInteger(parsed.totalTokens) &&
      parsed.totalTokens === parsed.inputTokens + parsed.outputTokens
    ) {
      return {
        prompt_tokens: parsed.inputTokens,
        completion_tokens: parsed.outputTokens,
        total_tokens: parsed.totalTokens,
      };
    }
  } catch {
    // Invalid optional fixture configuration leaves usage absent.
  }
  return null;
})();
const responseText = process.env.NEMOCLAW_FAKE_OPENAI_RESPONSE_TEXT || chatContent;
const workspaceWrite = (() => {
  try {
    const parsed = JSON.parse(process.env.NEMOCLAW_FAKE_OPENAI_WORKSPACE_WRITE || "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.prompt === "string" &&
      typeof parsed.filePath === "string" &&
      typeof parsed.content === "string" &&
      typeof parsed.finalResponse === "string"
    ) {
      return {
        prompt: parsed.prompt,
        filePath: parsed.filePath,
        content: parsed.content,
        finalResponse: parsed.finalResponse,
      };
    }
  } catch {
    // Invalid optional fixture configuration leaves workspace writes disabled.
  }
  return null;
})();
const replyFromPrompt = process.env.NEMOCLAW_FAKE_OPENAI_REPLY_FROM_PROMPT === "1";
const requestCanaryMarker = process.env.NEMOCLAW_FAKE_OPENAI_REQUEST_CANARY_MARKER || "";
const forbiddenMarkers = (() => {
  try {
    const parsed = JSON.parse(process.env.NEMOCLAW_FAKE_OPENAI_FORBIDDEN_MARKERS || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
})();

if (environmentFile) {
  writeFileSync(environmentFile, JSON.stringify(Object.keys(process.env).sort()));
}

function log(message: string): void {
  if (logFile) {
    appendFileSync(logFile, `${message}\n`);
    return;
  }
  console.log(message);
}

function recordRequest(entry: JsonObject): void {
  if (!requestsFile) return;
  appendFileSync(requestsFile, `${JSON.stringify(entry)}\n`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendChatSse(res: ServerResponse, content: string): void {
  const chunk = JSON.stringify({
    id: "chatcmpl-fake-openai-compatible",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  const doneChunk = JSON.stringify({
    id: "chatcmpl-fake-openai-compatible",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const usageChunk = chatUsage
    ? `data: ${JSON.stringify({
        id: "chatcmpl-fake-openai-compatible",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [],
        usage: chatUsage,
      })}\n\n`
    : "";
  const body = `data: ${chunk}\n\ndata: ${doneChunk}\n\n${usageChunk}data: [DONE]\n\n`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendResponseSse(res: ServerResponse, text: string): void {
  const body = [
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ delta: text })}`,
    "",
    "event: response.completed",
    "data: {}",
    "",
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isAuthOk(req: IncomingMessage): boolean {
  if (!requireAuth) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url || "/", "http://fake-openai-compatible.local").pathname;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseJsonBody(raw: Buffer): JsonObject {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function forbiddenMarkerMatches(req: IncomingMessage, raw: Buffer): number {
  const headerValues = Object.values(req.headers).flatMap((value) => value ?? []);
  const requestMaterial = [req.url ?? "", ...headerValues, raw.toString("utf8")].join("\n");
  return forbiddenMarkers.filter((marker) => requestMaterial.includes(marker)).length;
}

function requestCanaryPresent(req: IncomingMessage, raw: Buffer): boolean | undefined {
  if (!requestCanaryMarker) return undefined;
  const headerValues = Object.values(req.headers).flatMap((value) => value ?? []);
  const requestMaterial = [req.url ?? "", ...headerValues, raw.toString("utf8")].join("\n");
  return requestMaterial.includes(requestCanaryMarker);
}

function latestUserPrompt(payload: JsonObject): string | null {
  const entries = Array.isArray(payload.messages) ? payload.messages : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const message = entry as JsonObject;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
  }
  return null;
}

function requestedPromptReply(payload: JsonObject): string | null {
  if (!replyFromPrompt) return null;
  const embeddedReplies = new Set(
    [...JSON.stringify(payload).matchAll(/NEMOCLAW_E2E_FAKE_RESPONSE=([A-Z0-9_]{1,64})/gu)].map(
      (match) => match[1],
    ),
  );
  if (embeddedReplies.size === 1) return [...embeddedReplies][0] ?? null;
  const prompt = latestUserPrompt(payload);
  const launchMatch = prompt?.match(
    /^Join these four fragments with underscores and put only the result on its own line: NEMOCLAW, ([0-9A-F]{12}), (FIRST|SECOND), OK\. Do not use tools\.(?:\n\n[\s\S]+)?$/u,
  );
  if (launchMatch) return `NEMOCLAW_${launchMatch[1]}_${launchMatch[2]}_OK`;
  if (
    /^Remember this exact token: NEMOCLAW_5254_[0-9]+\. Reply with acknowledged\.(?:\n\n[\s\S]+)?$/u.test(
      prompt ?? "",
    )
  ) {
    return "acknowledged";
  }
  if (
    /^(?:What is seven multiplied by eight\?|Multiply seven by eight\.) Reply with only the integer\.(?:\n\n[\s\S]+)?$/u.test(
      prompt ?? "",
    )
  ) {
    return "56";
  }
  const profileMarker = prompt?.match(
    /^(N8011_[0-9a-z]{8,10}_PROFILE_(?:SEED|CONTINUE))(?:\n\n[\s\S]+)?$/u,
  );
  if (profileMarker) return profileMarker[1];
  return null;
}

const WORKSPACE_WRITE_TOOL_CALL_ID = "call-nemoclaw-workspace-write";

function workspaceWritePhase(payload: JsonObject): "request" | "result" | null {
  if (!workspaceWrite || latestUserPrompt(payload) !== workspaceWrite.prompt) return null;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as JsonObject).role === "tool" &&
      (entry as JsonObject).tool_call_id === WORKSPACE_WRITE_TOOL_CALL_ID,
  )
    ? "result"
    : "request";
}

function sendWorkspaceWriteResponse(res: ServerResponse, phase: "request" | "result"): void {
  if (!workspaceWrite) throw new Error("workspace write fixture is unavailable");
  const message =
    phase === "request"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: WORKSPACE_WRITE_TOOL_CALL_ID,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  file_path: workspaceWrite.filePath,
                  content: workspaceWrite.content,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: workspaceWrite.finalResponse };
  sendJson(res, 200, {
    id: "chatcmpl-fake-openai-compatible-workspace",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: phase === "request" ? "tool_calls" : "stop",
      },
    ],
    ...(chatUsage ? { usage: chatUsage } : {}),
  });
}

const server = createServer(async (req, res) => {
  const path = requestPath(req);

  if (req.method === "GET" && ["/v1/models", "/models"].includes(path)) {
    const modelsAuthOk = !requireAuthModels || req.headers.authorization === `Bearer ${apiKey}`;
    log(`GET ${path} auth=${modelsAuthOk ? "ok" : "missing"}`);
    recordRequest({
      method: "GET",
      path,
      hostHeader: req.headers.host,
      bodyBytes: 0,
      auth: modelsAuthOk ? "ok" : "missing",
      // Presence only (never the token) so callers can prove a probe sent its
      // credential without leaking it into the requests log (#6177).
      authorizationSent: Boolean(req.headers.authorization),
      forbiddenMarkerMatches: forbiddenMarkerMatches(req, Buffer.alloc(0)),
      requestCanaryPresent: requestCanaryPresent(req, Buffer.alloc(0)),
    });
    if (!modelsAuthOk) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    const modelEntry: JsonObject = { id: model, object: "model" };
    if (maxModelLen !== null) modelEntry.max_model_len = maxModelLen;
    sendJson(res, 200, { object: "list", data: [modelEntry] });
    return;
  }

  const raw = await readBody(req);
  const payload = parseJsonBody(raw);
  const auth = isAuthOk(req) ? "ok" : "missing";
  const requestedWorkspaceWritePhase = workspaceWritePhase(payload);
  recordRequest({
    method: req.method || "GET",
    path,
    hostHeader: req.headers.host,
    bodyBytes: raw.length,
    auth,
    // Presence only (never the token), matching the models request record.
    authorizationSent: Boolean(req.headers.authorization),
    model: payload.model,
    stream: Boolean(payload.stream),
    forbiddenMarkerMatches: forbiddenMarkerMatches(req, raw),
    requestCanaryPresent: requestCanaryPresent(req, raw),
    ...(requestedWorkspaceWritePhase ? { workspaceWritePhase: requestedWorkspaceWritePhase } : {}),
  });

  if (req.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(path)) {
    log(
      `POST ${path} auth=${auth} model=${String(payload.model || "")} stream=${Boolean(payload.stream)}`,
    );
    if (!isAuthOk(req)) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    if (requestedWorkspaceWritePhase) {
      if (payload.stream) {
        sendJson(res, 400, {
          error: { message: "workspace write fixture requires non-streaming chat" },
        });
        return;
      }
      sendWorkspaceWriteResponse(res, requestedWorkspaceWritePhase);
      return;
    }
    const content = requestedPromptReply(payload) ?? chatContent;
    if (payload.stream) {
      sendChatSse(res, content);
      return;
    }
    sendJson(res, 200, {
      id: "chatcmpl-fake-openai-compatible",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      ...(chatUsage ? { usage: chatUsage } : {}),
    });
    return;
  }

  if (req.method === "POST" && ["/v1/responses", "/responses"].includes(path)) {
    log(`POST ${path} auth=${auth} stream=${Boolean(payload.stream)}`);
    if (!isAuthOk(req)) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    const content = requestedPromptReply(payload) ?? responseText;
    if (payload.stream) {
      sendResponseSse(res, content);
      return;
    }
    sendJson(res, 200, {
      id: "resp-fake-openai-compatible",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
        },
      ],
    });
    return;
  }

  sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(port, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake OpenAI-compatible server did not bind to a TCP port");
  }
  if (portFile) writeFileSync(portFile, String(address.port));
  log(`READY host=${host} port=${address.port} model=${model}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
