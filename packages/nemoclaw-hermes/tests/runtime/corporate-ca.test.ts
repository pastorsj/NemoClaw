// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
//
// Runtime behavior of the corporate-proxy CA merge (#6210) in the Hermes entrypoint.

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorporateCaHelperGuard, runShellLines, sliceBlock } from "../helpers/corporate-ca";

const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const HERMES_SERVICE_CONTROL = join(PACKAGE_ROOT, "runtime", "service-control.sh");
const OPENSHELL_PEM = "-----BEGIN CERTIFICATE-----\nOPENSHELL-ROOT\n-----END CERTIFICATE-----\n";
const CORPORATE_PEM = "-----BEGIN CERTIFICATE-----\nCORPORATE-ROOT\n-----END CERTIFICATE-----\n";
const MERGE_START = "# Corporate proxy CA merge (NemoClaw#6210).";
const MERGE_END = "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.";

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
    "exits Hermes before sourcing or merging when the deployed helper is %s and fallback is unavailable",
    (mode) => {
      const dir = tmpDir(`nemoclaw-hermes-helper-${mode}-`);
      const result = runCorporateCaHelperGuard(HERMES_SERVICE_CONTROL, dir, mode, MERGE_END);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("required corporate CA runtime helper is missing or unsafe");
      expect(result.stderr).not.toContain(result.secret);
      expect(existsSync(result.mergedPath)).toBe(false);
    },
  );
});

describe("corporate proxy CA trust-anchor rejection (#8650)", () => {
  it("rejects a symlinked corporate CA before reading it for Hermes (#8650)", () => {
    const dir = tmpDir("nemoclaw-hermes-corp-symlink-");
    const openshell = join(dir, "openshell-ca.pem");
    const corporate = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    const planted = join(dir, "not-a-certificate");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(planted, "PLANTED-NOT-A-CERTIFICATE\n");
    symlinkSync(planted, corporate);

    const diagnostic = mergeDiagnostic(
      dir,
      mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corporate, merged),
      [`export SSL_CERT_FILE=${JSON.stringify(openshell)}`],
    );

    expect(diagnostic).toContain("corporate CA");
    expect(diagnostic).not.toContain("PLANTED-NOT-A-CERTIFICATE");
    expect(existsSync(merged)).toBe(false);
  });

  it("rejects a corporate CA swapped to a symlink after the path check for Hermes (#8650)", () => {
    const dir = tmpDir("nemoclaw-hermes-corp-swap-");
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
    const raced = mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corporate, merged).replace(
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
  ])("appends the corporate CA and repoints all CA env for Hermes [%s] (#6210)", (name) => {
    const dir = tmpDir("nemoclaw-corp-merge-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    // Hermes' block ends at the OpenShell derivation comment; splice that in so
    // the CURL/REQUESTS/GIT vars derive from the merged SSL_CERT_FILE too.
    const hermesMerge = mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corp, merged);

    // Simulate OpenShell having pre-set CURL/REQUESTS/GIT to its own bundle;
    // the merge must override them, not leave them pointing at OpenShell-only.
    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      `export CURL_CA_BUNDLE=${JSON.stringify(openshell)}`,
      `export REQUESTS_CA_BUNDLE=${JSON.stringify(openshell)}`,
      `export GIT_SSL_CAINFO=${JSON.stringify(openshell)}`,
      hermesMerge,
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
  });

  it("bails without exporting when the Hermes merged bundle cannot be written (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-hermes-fail-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when Hermes cannot make the merged bundle readable (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-chmod-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "chmod() { return 1; }",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("warns on stderr when the Hermes merge fails (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-warn-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "exec 2>&1",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(HERMES_SERVICE_CONTROL, MERGE_END, corp, merged),
    ]);
    expect(out).toContain("corporate proxy CA merge failed");
    expect(out).not.toContain("BEGIN CERTIFICATE");
  });
});
