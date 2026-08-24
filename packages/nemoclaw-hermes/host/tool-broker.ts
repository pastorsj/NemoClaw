#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side Hermes managed-tool gateway broker.
 *
 * This entry point reads runtime configuration, starts the public proxy and
 * private clone-control socket, schedules inference-key refresh, and owns
 * process shutdown. Credential, control, and request policy live beside it.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  AGENT_KEY_REFRESH_INTERVAL_MS,
  errorCode,
  refreshManagedInferenceForRuntimeCredentials,
  registerInitialRuntimeRefreshCredential,
} = require("./broker-credentials.ts");
const { startCloneControlServer } = require("./clone-control.ts");
const {
  handleManagedToolRequest,
  loadManagedToolMatrix,
  resolveManagedToolRoute,
  sendJson,
  sendText,
} = require("./request-proxy.ts");

const PORT = parseInt(process.env.HERMES_TOOL_GATEWAY_PORT || "11436", 10);
const MATRIX_PATH =
  process.env.HERMES_TOOL_GATEWAY_MATRIX_PATH || path.join(__dirname, "tool-matrix.json");
const CONTROL_SOCKET_PATH = process.env.HERMES_TOOL_GATEWAY_CONTROL_SOCKET || "";
const PREFLIGHT_PROBE = process.env.HERMES_TOOL_GATEWAY_PREFLIGHT_PROBE === "1";
const BROKER_SHUTDOWN_TIMEOUT_MS = 1_000;

const MATRIX = loadManagedToolMatrix(MATRIX_PATH);
registerInitialRuntimeRefreshCredential();

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(async () => {
      if (req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          services: Object.keys(MATRIX).sort(),
        });
        return;
      }
      if (req.url === "/internal/refresh-inference") {
        const remote = req.socket?.remoteAddress || "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
          sendText(res, 404, "unknown Hermes managed-tool gateway route");
          return;
        }
        await refreshManagedInferenceForRuntimeCredentials({ force: true });
        sendJson(res, 200, { ok: true });
        return;
      }
      const route = resolveManagedToolRoute(req.url, MATRIX);
      if (!route) {
        sendText(res, 404, "unknown Hermes managed-tool gateway route");
        return;
      }
      await handleManagedToolRequest(req, res, route);
    })
    .catch((err) => {
      console.error(`Hermes tool gateway internal error: ${err?.message || err}`);
      if (!res.headersSent) {
        sendText(res, 500, "Hermes tool gateway internal error");
      } else {
        res.end();
      }
    });
});

let controlServer = null;
let preflightPublicReady = false;
let preflightControlReady = !CONTROL_SOCKET_PATH;
let preflightRunning = false;

function finishPreflightProbe(status) {
  if (!PREFLIGHT_PROBE) return;
  if (CONTROL_SOCKET_PATH) {
    try {
      fs.unlinkSync(CONTROL_SOCKET_PATH);
    } catch {
      /* ignore */
    }
  }
  process.exit(status);
}

function maybeRunPreflightProbe() {
  if (!PREFLIGHT_PROBE || preflightRunning || !preflightPublicReady || !preflightControlReady) {
    return;
  }
  preflightRunning = true;
  const body = "{}";
  const request = http.request(
    {
      socketPath: CONTROL_SOCKET_PATH,
      path: "/preflight",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (response) => {
      response.resume();
      response.on("end", () => finishPreflightProbe(response.statusCode === 200 ? 0 : 3));
    },
  );
  request.on("error", () => finishPreflightProbe(3));
  request.end(body);
}

controlServer = startCloneControlServer({
  socketPath: CONTROL_SOCKET_PATH,
  preflightProbe: PREFLIGHT_PROBE,
  onReady: () => {
    preflightControlReady = true;
    maybeRunPreflightProbe();
  },
  onProbeFailure: () => finishPreflightProbe(2),
});

server.listen(PORT, "0.0.0.0", () => {
  if (PREFLIGHT_PROBE) {
    preflightPublicReady = true;
    maybeRunPreflightProbe();
    return;
  }
  console.error(`Hermes managed-tool gateway broker listening on :${PORT}`);
  refreshManagedInferenceForRuntimeCredentials().catch((err) => {
    const code = errorCode(err) || "agent_key_refresh_failed";
    console.error(`Hermes inference provider refresh failed: ${code}`);
  });
});
if (PREFLIGHT_PROBE) {
  server.on("error", () => finishPreflightProbe(2));
  setTimeout(() => finishPreflightProbe(4), 5000);
}

if (!PREFLIGHT_PROBE) {
  const refreshTimer = setInterval(() => {
    refreshManagedInferenceForRuntimeCredentials().catch((err) => {
      const code = errorCode(err) || "agent_key_refresh_failed";
      console.error(`Hermes inference provider refresh failed: ${code}`);
    });
  }, AGENT_KEY_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

let brokerClosing = false;

function closeToolBroker() {
  if (brokerClosing) return;
  brokerClosing = true;
  let exited = false;
  let shutdownTimer;
  const exit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(shutdownTimer);
    if (CONTROL_SOCKET_PATH) {
      try {
        fs.unlinkSync(CONTROL_SOCKET_PATH);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  shutdownTimer = setTimeout(() => {
    controlServer?.closeAllConnections();
    server.closeAllConnections();
    exit();
  }, BROKER_SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref?.();
  const closePublicServer = () => server.close(exit);
  if (controlServer) controlServer.close(closePublicServer);
  else closePublicServer();
}

process.on("SIGTERM", closeToolBroker);
process.on("SIGINT", closeToolBroker);
