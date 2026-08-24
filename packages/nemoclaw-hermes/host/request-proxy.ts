// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global AbortSignal, fetch */

/**
 * Public request boundary for the Hermes managed-tool broker.
 *
 * This module removes sandbox-provided secrets, adds host-managed upstream
 * authorization, blocks redirects, and sanitizes the response headers.
 */

const fs = require("fs");
const {
  UPSTREAM_REQUEST_TIMEOUT_MS,
  ensureInferenceAgentKey,
  errorCode,
  findCredentialState,
  refreshAccessToken,
  resolveRuntimeRefreshToken,
} = require("./broker-credentials.ts");

function loadManagedToolMatrix(matrixPath) {
  try {
    const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
    return Object.fromEntries(
      Object.values(matrix)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => [entry.service, entry])
        .filter(([service, entry]) => {
          return typeof service === "string" && typeof entry.upstream === "string";
        }),
    );
  } catch (error) {
    console.error(`failed to load Hermes tool gateway matrix: ${error.message || error}`);
    process.exit(1);
  }
}
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "content-md5"]);
const STRIPPED_SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
]);
const TOKEN_HEADERS = [
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
];
function extractRefreshToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const trimmed = auth.trim();
    const separator = trimmed.indexOf(" ");
    if (separator > 0) {
      const scheme = trimmed.slice(0, separator).toLowerCase();
      const token = trimmed.slice(separator + 1).trim();
      if ((scheme === "bearer" || scheme === "key") && token) return token;
    }
  }
  for (const headerName of TOKEN_HEADERS) {
    const value = req.headers[headerName];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return String(value[0]).trim();
  }
  return null;
}
function resolveManagedToolRoute(reqUrl, matrix) {
  const url = new URL(reqUrl || "/", "http://broker.local");
  const parts = url.pathname.split("/").filter(Boolean);
  const service = parts[0] || "";
  const entry = matrix[service];
  if (!entry) return null;
  const upstreamBase = String(entry.upstream).replace(/\/+$/, "");
  const suffix = "/" + parts.slice(1).join("/");
  return {
    service,
    entry,
    upstreamUrl: upstreamBase + (suffix === "/" ? "/" : suffix) + (url.search || ""),
  };
}
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildForwardHeaders(req, route, accessToken) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_SECRET_HEADERS.has(lower)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  headers["accept-encoding"] = "identity";
  switch (route.service) {
    case "browser-use":
      headers["X-Browser-Use-API-Key"] = accessToken;
      break;
    case "fal-queue":
      headers.authorization = `Key ${accessToken}`;
      break;
    default:
      headers.authorization = `Bearer ${accessToken}`;
      break;
  }
  return headers;
}

function forwardResponseHeaders(upstreamResp) {
  const headers = {};
  upstreamResp.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      DECODED_RESPONSE_HEADERS.has(lower) ||
      lower === "set-cookie"
    ) {
      return;
    }
    headers[name] = value;
  });
  return headers;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
function isAbortError(err) {
  return (
    err &&
    typeof err === "object" &&
    (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "ABORT_ERR")
  );
}

async function handleManagedToolRequest(req, res, route) {
  const presentedToken = extractRefreshToken(req);
  if (!presentedToken) {
    sendText(
      res,
      401,
      "Hermes managed tools require Nous Portal OAuth. Re-run nemohermes onboard --resume.",
    );
    return;
  }

  const credentialState = findCredentialState(presentedToken);
  if (!credentialState) {
    sendText(
      res,
      401,
      "Unknown Hermes tool-gateway credential. Re-run nemohermes onboard --resume.",
    );
    return;
  }
  const { loaded } = credentialState;
  const refreshToken =
    credentialState.kind === "refresh" ? presentedToken : resolveRuntimeRefreshToken(loaded);
  if (!refreshToken) {
    sendText(
      res,
      401,
      "Hermes managed-tool broker needs fresh host OAuth. Re-run nemohermes onboard --resume.",
    );
    return;
  }

  let accessToken;
  try {
    accessToken = await refreshAccessToken(refreshToken, loaded);
    ensureInferenceAgentKey(loaded, refreshToken).catch((err) => {
      const code = errorCode(err) || "agent_key_refresh_failed";
      console.error(`Hermes inference provider refresh failed: ${code}`);
    });
  } catch (err) {
    const code = errorCode(err);
    if (code === "reauth_required") {
      sendText(
        res,
        401,
        "Nous OAuth refresh failed. Re-run nemohermes onboard --resume to re-authorize managed tools.",
      );
      return;
    }
    console.error(`Hermes tool gateway refresh failed: ${code || "refresh_failed"}`);
    sendText(res, 502, "Hermes tool gateway could not refresh host-side OAuth.");
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    sendText(res, 400, "failed to read request body");
    return;
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(route.upstreamUrl, {
      method: req.method,
      headers: buildForwardHeaders(req, route, accessToken),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      sendText(res, 504, "upstream gateway request timed out");
      return;
    }
    sendText(res, 502, "upstream gateway request failed");
    return;
  }

  const buffer = Buffer.from(await upstreamResp.arrayBuffer());
  res.writeHead(upstreamResp.status, forwardResponseHeaders(upstreamResp));
  res.end(buffer);
}

module.exports = {
  handleManagedToolRequest,
  loadManagedToolMatrix,
  resolveManagedToolRoute,
  sendJson,
  sendText,
};
