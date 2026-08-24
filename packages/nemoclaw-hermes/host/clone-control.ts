// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Private clone-control boundary for the Hermes managed-tool broker.
 *
 * The bounded request parser and socket ownership stay with route dispatch so
 * callers cannot separate credential mutation from the private transport.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  activateStagedCloneBinding,
  cloneBindingStatus,
  discardStagedCloneBinding,
  registerRuntimeRefreshCredential,
  stageCloneBinding,
  stagedCloneBinding,
  unregisterRuntimeRefreshCredential,
} = require("./broker-credentials.ts");
const {
  boundedControlDeadline,
  isValidActivationToken,
  isValidName,
} = require("./tool-contract.ts");

const CONTROL_REQUEST_TIMEOUT_MS = 1_000;
function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBoundedControlRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => {
      reject(new Error("control_request_timeout"));
      req.destroy();
    }, CONTROL_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        clearTimeout(timeout);
        reject(new Error("control_request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("control_request_invalid"));
      }
    });
    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function handleBrokerControlRequest(req, res, preflightProbe) {
  if (req.method !== "POST") {
    sendText(res, 405, "method not allowed");
    return;
  }
  const payload = await readBoundedControlRequest(req);
  const sandbox = String(payload?.sandbox || "").trim();
  if (preflightProbe && req.url === "/preflight") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url === "/credentials/stage") {
    const refreshToken = String(payload?.refresh_token || "").trim();
    const inferenceProviderName = String(payload?.inference_provider_name || "").trim();
    const requestId = String(payload?.request_id || "").trim();
    if (!refreshToken) {
      sendText(res, 409, "staged credential is empty");
      return;
    }
    const staged = await stageCloneBinding(
      sandbox,
      refreshToken,
      inferenceProviderName,
      requestId,
      payload?.deadline_at_ms,
    );
    sendJson(res, 200, {
      ok: true,
      activation_token: staged.activationToken,
      broker_token: staged.brokerToken,
      state: staged.state,
    });
    return;
  }
  if (req.url === "/credentials/activate") {
    const activationToken = String(payload?.activation_token || "").trim();
    if (!isValidName(sandbox) || !isValidActivationToken(activationToken)) {
      sendText(res, 409, "invalid staged destination identity");
      return;
    }
    const deadlineAtMs = boundedControlDeadline(payload?.deadline_at_ms);
    if (deadlineAtMs === null) {
      sendText(res, 409, "invalid activation deadline");
      return;
    }
    activateStagedCloneBinding(sandbox, activationToken, deadlineAtMs);
    sendJson(res, 200, { ok: true, state: "activated" });
    return;
  }
  if (req.url === "/credentials/discard") {
    const activationToken = String(payload?.activation_token || "").trim();
    const staged = stagedCloneBinding(activationToken, sandbox);
    if (staged) discardStagedCloneBinding(activationToken);
    const status = cloneBindingStatus("", activationToken);
    sendJson(res, 200, { ok: true, state: status?.state ?? "absent" });
    return;
  }
  if (req.url === "/credentials/status") {
    const status = cloneBindingStatus(
      String(payload?.request_id || "").trim(),
      String(payload?.activation_token || "").trim(),
    );
    if (!status) {
      sendText(res, 404, "unknown clone broker request");
      return;
    }
    sendJson(res, 200, { ok: true, ...status });
    return;
  }
  if (req.url === "/credentials/register") {
    const refreshToken = String(payload?.refresh_token || "").trim();
    if (!(await registerRuntimeRefreshCredential(sandbox, refreshToken))) {
      sendText(res, 409, "credential does not match destination broker state");
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url === "/credentials/unregister") {
    unregisterRuntimeRefreshCredential(sandbox);
    sendJson(res, 200, { ok: true });
    return;
  }
  sendText(res, 404, "unknown broker control route");
}

function startCloneControlServer(options) {
  const { onProbeFailure, onReady, preflightProbe, socketPath } = options;
  if (!socketPath) return null;
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const controlSocketDirectory = path.dirname(socketPath);
  fs.mkdirSync(controlSocketDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(controlSocketDirectory, 0o700);
  const server = http.createServer((req, res) => {
    handleBrokerControlRequest(req, res, preflightProbe).catch((error) => {
      console.error(`Hermes tool gateway control error: ${error?.message || error}`);
      if (!res.headersSent) sendText(res, 400, "invalid broker control request");
      else res.end();
    });
  });
  server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  const previousUmask = process.umask(0o177);
  try {
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      onReady();
    });
  } finally {
    process.umask(previousUmask);
  }
  if (preflightProbe) server.on("error", onProbeFailure);
  return server;
}

module.exports = { startCloneControlServer };
