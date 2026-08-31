// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const CORPORATE_CA_HELPER = path.resolve(PACKAGE_ROOT, "../../scripts/lib/corporate-ca-runtime.sh");

export function sliceBlock(scriptPath: string, startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(scriptPath, "utf-8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to extract block [${startMarker} .. ${endMarker}] from ${scriptPath}`);
  }
  const block = source.slice(start, end);
  const sourceCommand = 'source "$_NEMOCLAW_CORPORATE_CA_HELPER"';
  if (!block.includes(sourceCommand)) return block;

  const helperSource = fs.readFileSync(CORPORATE_CA_HELPER, "utf-8");
  return block
    .replaceAll("/usr/local/lib/nemoclaw/corporate-ca-runtime.sh", CORPORATE_CA_HELPER)
    .replace(sourceCommand, helperSource);
}

export function runShellLines(dir: string, lines: string[]): string {
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  return execFileSync("bash", [script], { encoding: "utf-8" });
}

/** Execute the package's shipped helper guard with an unavailable fallback. */
export function runCorporateCaHelperGuard(
  scriptPath: string,
  dir: string,
  deployedMode: "missing" | "symlink",
  endMarker: string,
): { status: number; stderr: string; mergedPath: string; secret: string } {
  const source = fs.readFileSync(scriptPath, "utf-8");
  const startMarker =
    '_NEMOCLAW_CORPORATE_CA_HELPER="/usr/local/lib/nemoclaw/corporate-ca-runtime.sh"';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to extract corporate CA helper guard from ${scriptPath}`);
  }

  const deployedPath = path.join(dir, "deployed-corporate-ca-runtime.sh");
  const mergedPath = path.join(dir, "merged-ca.pem");
  const secret = "CA-MATERIAL-MUST-NOT-LEAK";
  if (deployedMode === "symlink") {
    const sentinelHelper = path.join(dir, "sentinel-helper.sh");
    fs.writeFileSync(
      sentinelHelper,
      [
        `printf '%s\\n' ${JSON.stringify(secret)} >&2`,
        `printf 'sourced\\n' >${JSON.stringify(mergedPath)}`,
        `merge_corporate_proxy_ca() { printf 'merged\\n' >${JSON.stringify(mergedPath)}; }`,
      ].join("\n"),
      { mode: 0o600 },
    );
    fs.symlinkSync(sentinelHelper, deployedPath);
  }

  const block = source
    .slice(start, end)
    .replaceAll("/usr/local/lib/nemoclaw/corporate-ca-runtime.sh", deployedPath);
  const wrapper = path.join(dir, "helper-guard.sh");
  fs.writeFileSync(wrapper, ["#!/usr/bin/env bash", "set -euo pipefail", block].join("\n"), {
    mode: 0o700,
  });
  const result = spawnSync("bash", [wrapper], { encoding: "utf-8" });
  return { status: result.status ?? -1, stderr: result.stderr ?? "", mergedPath, secret };
}

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-corp-ca-tls-"));
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

export function runMergeBlock(
  scriptPath: string,
  openshellBundle: string,
  corporateCa: string,
  outDir: string,
  endMarker: string,
): string {
  const block = sliceBlock(scriptPath, "# Corporate proxy CA merge (NemoClaw#6210).", endMarker)
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corporateCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", path.join(outDir, "merged-ca.pem"));
  const wrapper = path.join(outDir, "merge.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export SSL_CERT_FILE=${JSON.stringify(openshellBundle)}`,
      block,
    ].join("\n"),
    { mode: 0o700 },
  );
  execFileSync("bash", [wrapper], { encoding: "utf-8" });
  return path.join(outDir, "merged-ca.pem");
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

export function httpsGetStatus(port: number, caBundlePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      { host: "127.0.0.1", port, path: "/", ca: fs.readFileSync(caBundlePath) },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
  });
}
