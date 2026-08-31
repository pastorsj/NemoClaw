// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
//
// Validates the Deep Agents Code corporate-proxy CA image contract.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LEAF_PEM } from "../../../../src/lib/onboard/__test-helpers__/corporate-ca-fixtures";
import {
  hasGnuBase64Decode,
  hasOpenssl,
  runDockerfileCorporateCaDecode,
} from "../helpers/corporate-ca";

const canRunDecodeBlock = hasGnuBase64Decode() && hasOpenssl();
const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const DEEP_AGENTS_DOCKERFILES = [
  join(PACKAGE_ROOT, "Dockerfile"),
  join(PACKAGE_ROOT, "Dockerfile.base"),
] as const;

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-corp-ca-decode-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Deep Agents Code Dockerfile corporate CA validation", () => {
  it.each([...DEEP_AGENTS_DOCKERFILES])(
    "requires CA:TRUE at the X.509 certificate parser in %s (#8119)",
    (dockerfile) => {
      const source = readFileSync(dockerfile, "utf8");
      const parsedCertificates = source.match(/new X509Certificate\(/g) ?? [];
      const caChecks = source.match(/new X509Certificate\([^)]*\)\.ca/g) ?? [];
      expect(parsedCertificates.length).toBeGreaterThan(0);
      expect(caChecks).toHaveLength(parsedCertificates.length);
    },
  );
});

describe.skipIf(!canRunDecodeBlock)("Deep Agents Code corporate CA constraint", () => {
  it("rejects a valid certificate without CA:TRUE (#8119)", () => {
    const res = runDockerfileCorporateCaDecode(
      DEEP_AGENTS_DOCKERFILES[0],
      Buffer.from(LEAF_PEM).toString("base64"),
      tmpDir(),
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("basicConstraints CA:TRUE");
  });
});
