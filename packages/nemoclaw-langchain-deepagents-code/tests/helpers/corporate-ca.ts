// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * True when the host `base64` accepts GNU's `--decode` long option (as the
 * Dockerfiles require). BSD/macOS `base64` only accepts `-D`, so the extracted
 * RUN block cannot run there — callers skip the Dockerfile-decode test on such
 * hosts (the image itself is only ever built on Linux).
 */
export function hasGnuBase64Decode(): boolean {
  const res = spawnSync("bash", ["-c", "printf 'aGk=' | base64 --decode"], { encoding: "utf-8" });
  return res.status === 0 && res.stdout === "hi";
}

/**
 * True when the `openssl` CLI is available. The Dockerfile decode RUN block
 * requires openssl to validate the certificate bundle, so the Dockerfile-decode
 * test only runs where openssl is present (as the TLS e2e already requires).
 */
export function hasOpenssl(): boolean {
  return spawnSync("openssl", ["version"], { encoding: "utf-8" }).status === 0;
}

/**
 * Extract the shipped corporate-CA `base64 --decode` RUN block from a Dockerfile
 * and execute it (with the install path redirected to `outDir`) for a given
 * `NEMOCLAW_CORPORATE_CA_B64` value. Exercises the actual Dockerfile shell text,
 * not a re-implementation, so the malformed-input guards are validated as
 * shipped. Returns the exit status and stderr.
 */
export function runDockerfileCorporateCaDecode(
  dockerfilePath: string,
  b64Value: string,
  outDir: string,
): { status: number; stderr: string } {
  const lines = fs.readFileSync(dockerfilePath, "utf-8").split("\n");
  const startIdx = lines.findIndex((line) =>
    line.includes('RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then'),
  );
  const endIdx = lines.findIndex((line, idx) => idx > startIdx && line.trimEnd() === "    fi");
  const found = startIdx !== -1 && endIdx !== -1;
  const block = (found ? lines.slice(startIdx, endIdx + 1) : [])
    .join("\n")
    .replace(/^RUN /, "")
    .replaceAll("/usr/local/share/nemoclaw", outDir)
    .replaceAll("/usr/local/share/ca-certificates", path.join(outDir, "ca-certificates"))
    // The shipped block refreshes the image OS trust store. Keep this
    // unprivileged extraction focused on the decode/split contract and prevent
    // it from mutating the test host's trust store.
    .replaceAll("command -v update-ca-certificates >/dev/null 2>&1", "true")
    .replaceAll("&& update-ca-certificates \\", "&& true \\")
    // Redirect the fixed /tmp decode scratch path into the per-test dir so
    // concurrent test runs never collide.
    .replaceAll("/tmp/nemoclaw-corporate-ca.decoded", path.join(outDir, "decoded"))
    // Root ownership requires root. The contract test preserves the exact
    // production command; this extracted-script test substitutes the current
    // user and group so the certificate guards run unprivileged.
    .replaceAll(
      "install -d -o root -g root -m 0755",
      'install -d -o "$(id -u)" -g "$(id -g)" -m 0755',
    )
    .replaceAll("chown root:root", 'chown "$(id -u):$(id -g)"');
  const wrapper = path.join(outDir, "decode.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `export NEMOCLAW_CORPORATE_CA_B64=${JSON.stringify(b64Value)}`,
      block || "echo 'decode block not found' >&2; exit 3",
    ].join("\n"),
    { mode: 0o700 },
  );
  const res = spawnSync("bash", [wrapper], { encoding: "utf-8" });
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}
