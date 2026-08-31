// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
//
// Runtime behavior of the corporate-proxy CA merge (#6210) in the OpenClaw entrypoint.

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorporateCaHelperGuard, runShellLines, sliceBlock } from "../helpers/corporate-ca";

const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const OPENCLAW_STARTUP_ENV = join(PACKAGE_ROOT, "runtime", "startup-env.sh");
const OPENSHELL_PEM = "-----BEGIN CERTIFICATE-----\nOPENSHELL-ROOT\n-----END CERTIFICATE-----\n";
const CORPORATE_PEM = "-----BEGIN CERTIFICATE-----\nCORPORATE-ROOT\n-----END CERTIFICATE-----\n";
const MERGE_START = "# Corporate proxy CA merge (NemoClaw#6210).";
const MERGE_END = "# Git TLS CA bundle fix (NemoClaw#2270).";

const tmpRoots: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mergeBlock(scriptPath: string, endMarker: string, corpCa: string, merged: string): string {
  return sliceBlock(scriptPath, MERGE_START, endMarker)
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corpCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", merged);
}

function mergeDiagnostic(dir: string, block: string, lines: string[] = []): string {
  const errFile = join(dir, "merge-stderr.txt");
  expect(() =>
    runShellLines(dir, [`exec 2>${JSON.stringify(errFile)}`, ...lines, block]),
  ).toThrow();
  return readFileSync(errFile, "utf-8");
}

describe("corporate proxy CA runtime helper guard (#8292)", () => {
  it.each(["missing", "symlink"] as const)(
    "exits OpenClaw before sourcing or merging when the deployed helper is %s and fallback is unavailable",
    (mode) => {
      const dir = tmpDir(`nemoclaw-openclaw-helper-${mode}-`);
      const result = runCorporateCaHelperGuard(OPENCLAW_STARTUP_ENV, dir, mode, MERGE_END);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("required corporate CA runtime helper is missing or unsafe");
      expect(result.stderr).not.toContain(result.secret);
      expect(existsSync(result.mergedPath)).toBe(false);
    },
  );
});

describe("corporate proxy CA trust-anchor rejection (#8650)", () => {
  it("rejects a symlinked corporate CA before reading it for OpenClaw (#8650)", () => {
    const dir = tmpDir("nemoclaw-openclaw-corp-symlink-");
    const openshell = join(dir, "openshell-ca.pem");
    const corporate = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    const planted = join(dir, "not-a-certificate");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(planted, "PLANTED-NOT-A-CERTIFICATE\n");
    symlinkSync(planted, corporate);

    const diagnostic = mergeDiagnostic(
      dir,
      mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corporate, merged),
      [`export SSL_CERT_FILE=${JSON.stringify(openshell)}`],
    );

    expect(diagnostic).toContain("corporate CA");
    expect(diagnostic).not.toContain("PLANTED-NOT-A-CERTIFICATE");
    expect(existsSync(merged)).toBe(false);
  });

  it("rejects a corporate CA swapped to a symlink after the path check for OpenClaw (#8650)", () => {
    const dir = tmpDir("nemoclaw-openclaw-corp-swap-");
    const openshell = join(dir, "openshell-ca.pem");
    const corporate = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    const planted = join(dir, "not-a-certificate");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(planted, "PLANTED-NOT-A-CERTIFICATE\n");
    writeFileSync(corporate, CORPORATE_PEM);

    const swap = [
      `rm -f ${JSON.stringify(corporate)}`,
      `ln -s ${JSON.stringify(planted)} ${JSON.stringify(corporate)}`,
    ].join("\n");
    const raced = mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corporate, merged).replace(
      `[ -s "$_NEMOCLAW_CORPORATE_CA_FILE" ] || return 0`,
      `[ -s "$_NEMOCLAW_CORPORATE_CA_FILE" ] || return 0\n${swap}`,
    );
    const diagnostic = mergeDiagnostic(dir, raced, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
    ]);

    expect(diagnostic).toContain("corporate CA");
    expect(diagnostic).not.toContain("PLANTED-NOT-A-CERTIFICATE");
    expect(existsSync(merged)).toBe(false);
  });
});

describe("corporate proxy CA runtime merge (#6210)", () => {
  it.each([
    "SSL_CERT_FILE",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "NODE_EXTRA_CA_CERTS",
  ])(
    "appends the corporate CA to the OpenShell bundle for OpenClaw and repoints all CA env [%s] (#6210)",
    (name) => {
      const dir = tmpDir("nemoclaw-corp-merge-openclaw-");
      const openshell = join(dir, "openshell-ca.pem");
      const corp = join(dir, "corporate-ca.pem");
      const merged = join(dir, "merged-ca.pem");
      writeFileSync(openshell, OPENSHELL_PEM);
      writeFileSync(corp, CORPORATE_PEM);

      const out = runShellLines(dir, [
        `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
        mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corp, merged),
        'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
        'printf "CURL_CA_BUNDLE=%s\\n" "${CURL_CA_BUNDLE:-}"',
        'printf "REQUESTS_CA_BUNDLE=%s\\n" "${REQUESTS_CA_BUNDLE:-}"',
        'printf "GIT_SSL_CAINFO=%s\\n" "${GIT_SSL_CAINFO:-}"',
        'printf "NODE_EXTRA_CA_CERTS=%s\\n" "${NODE_EXTRA_CA_CERTS:-}"',
        'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
      ]);

      expect(out).toContain(`${name}=${merged}`);

      expect(out).toContain("MERGED=1");
      const mergedContent = readFileSync(merged, "utf-8");
      expect(mergedContent).toContain("OPENSHELL-ROOT");
      expect(mergedContent).toContain("CORPORATE-ROOT");
    },
  );

  it("is a no-op for OpenClaw when no corporate CA was baked into the image (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-noop-");
    const openshell = join(dir, "openshell-ca.pem");
    const absentCorp = join(dir, "absent-corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, absentCorp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when the OpenClaw merged bundle cannot be written (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-fail-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    // A merged path under a non-existent directory makes mktemp fail.
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    // Merge bailed: OpenShell-only trust intact, no merge marker.
    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when OpenClaw cannot make the merged bundle readable (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-chmod-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "chmod() { return 1; }",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("warns on stderr when the OpenClaw merge fails (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-warn-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    // exec 2>&1 folds the merge's stderr warning into captured stdout.
    const out = runShellLines(dir, [
      "exec 2>&1",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_STARTUP_ENV, MERGE_END, corp, merged),
    ]);
    expect(out).toContain("corporate proxy CA merge failed");
    expect(out).not.toContain("BEGIN CERTIFICATE");
  });

  it("persists the merged CA env into OpenClaw connect sessions only after a merge (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-connect-");
    const block = sliceBlock(
      OPENCLAW_STARTUP_ENV,
      "# Corporate proxy CA for connect sessions (NemoClaw#6210).",
      "# Nemotron inference fix for connect sessions.",
    );
    const bundle = "/tmp/nemoclaw-ca-bundle.pem";

    // Behavioral: capture the emitted connect-session exports, source them in a
    // fresh shell, and assert on the resulting environment — not the text.
    function connectSessionEnv(preEnv: string[]): Record<string, string> {
      const envFile = join(dir, "connect-env.sh");
      const emitted = runShellLines(dir, [...preEnv, `{ ${block}\n} > ${JSON.stringify(envFile)}`]);
      expect(emitted).toBe("");
      const sourced = runShellLines(dir, [
        `source ${JSON.stringify(envFile)}`,
        'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
        'printf "CURL_CA_BUNDLE=%s\\n" "${CURL_CA_BUNDLE:-}"',
        'printf "REQUESTS_CA_BUNDLE=%s\\n" "${REQUESTS_CA_BUNDLE:-}"',
        'printf "NODE_EXTRA_CA_CERTS=%s\\n" "${NODE_EXTRA_CA_CERTS:-}"',
      ]);
      return Object.fromEntries(
        sourced
          .trim()
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("=");
            return [line.slice(0, idx), line.slice(idx + 1)];
          }),
      );
    }

    const merged = connectSessionEnv([
      `export SSL_CERT_FILE=${bundle}`,
      `export CURL_CA_BUNDLE=${bundle}`,
      `export REQUESTS_CA_BUNDLE=${bundle}`,
      `export NODE_EXTRA_CA_CERTS=${bundle}`,
      "export _NEMOCLAW_CORPORATE_CA_MERGED=1",
    ]);
    expect(merged.SSL_CERT_FILE).toBe(bundle);
    expect(merged.CURL_CA_BUNDLE).toBe(bundle);
    expect(merged.REQUESTS_CA_BUNDLE).toBe(bundle);
    expect(merged.NODE_EXTRA_CA_CERTS).toBe(bundle);

    // No merge marker → the block emits nothing, so a fresh shell inherits no
    // corporate CA env from the connect-session file.
    const skipped = connectSessionEnv(["export SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem"]);
    expect(skipped.SSL_CERT_FILE).toBe("");
    expect(skipped.CURL_CA_BUNDLE).toBe("");
  });
});
