// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generic TLS certificate material for core tests. This helper has no agent-runtime paths.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export interface CaMaterial {
  ok: true;
  dir: string;
  corporateCaCert: string;
  openshellCaCert: string;
  serverKey: string;
  serverCert: string;
  openshellServerKey: string;
  openshellServerCert: string;
}

export type CaSetup = CaMaterial | { ok: false; reason: string };

function createRootCertificate(dir: string, commonName: string, key: string, cert: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      path.join(dir, key),
      "-out",
      path.join(dir, cert),
      "-days",
      "7",
      "-nodes",
      "-subj",
      `/CN=${commonName}`,
    ],
    { stdio: "pipe" },
  );
}

function createSignedLeaf(
  dir: string,
  caCert: string,
  caKey: string,
  key: string,
  cert: string,
): void {
  const request = path.join(dir, `${key}.csr`);
  const extensions = path.join(dir, `${key}.ext`);
  fs.writeFileSync(extensions, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-keyout",
      path.join(dir, key),
      "-out",
      request,
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      path.join(dir, caCert),
      "-CAkey",
      path.join(dir, caKey),
      "-CAcreateserial",
      "-out",
      path.join(dir, cert),
      "-days",
      "7",
      "-extfile",
      extensions,
    ],
    { stdio: "pipe" },
  );
}

function setupCaMaterial(): CaSetup {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
  } catch (error) {
    return { ok: false, reason: `openssl missing: ${(error as Error).message}` };
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tls-ca-"));
    createRootCertificate(dir, "Corp MITM Root CA", "corp-ca-key.pem", "corp-ca-cert.pem");
    createSignedLeaf(
      dir,
      "corp-ca-cert.pem",
      "corp-ca-key.pem",
      "server-key.pem",
      "server-cert.pem",
    );
    createRootCertificate(
      dir,
      "OpenShell Root CA",
      "openshell-ca-key.pem",
      "openshell-ca-cert.pem",
    );
    createSignedLeaf(
      dir,
      "openshell-ca-cert.pem",
      "openshell-ca-key.pem",
      "openshell-server-key.pem",
      "openshell-server-cert.pem",
    );
    return {
      ok: true,
      dir,
      corporateCaCert: path.join(dir, "corp-ca-cert.pem"),
      openshellCaCert: path.join(dir, "openshell-ca-cert.pem"),
      serverKey: path.join(dir, "server-key.pem"),
      serverCert: path.join(dir, "server-cert.pem"),
      openshellServerKey: path.join(dir, "openshell-server-key.pem"),
      openshellServerCert: path.join(dir, "openshell-server-cert.pem"),
    };
  } catch (error) {
    return { ok: false, reason: `cert generation failed: ${(error as Error).message}` };
  }
}

export function resolveCaSetup(context: string): CaSetup {
  const setup = setupCaMaterial();
  if (!setup.ok) {
    if (process.env.CI === "true") {
      throw new Error(
        `[${context}] CI=true but openssl unavailable: ${setup.reason}. ` +
          "This test must not silently skip in CI — install openssl on the runner.",
      );
    }
    console.warn(`[${context}] skipping locally: ${setup.reason}`);
  }
  return setup;
}

export function cleanupCaSetup(setup: CaSetup): void {
  if (setup.ok) fs.rmSync(setup.dir, { recursive: true, force: true });
}

export function startTlsServer(
  key: string,
  cert: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    );
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (!port) {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}
