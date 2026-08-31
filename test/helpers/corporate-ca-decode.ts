// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Cross-package support for exercising the shared corporate-CA image decode contract.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Return whether the host supports the GNU base64 interface used in package images. */
export function hasGnuBase64Decode(): boolean {
  const result = spawnSync("bash", ["-c", "printf 'aGk=' | base64 --decode"], {
    encoding: "utf-8",
  });
  return result.status === 0 && result.stdout === "hi";
}

/** Return whether the certificate parser required by the image decode contract is available. */
export function hasOpenssl(): boolean {
  return spawnSync("openssl", ["version"], { encoding: "utf-8" }).status === 0;
}

/** Execute one package Dockerfile's shipped corporate-CA decode block. */
export function runDockerfileCorporateCaDecode(
  dockerfilePath: string,
  base64Value: string,
  outputDirectory: string,
): { status: number; stderr: string } {
  const lines = fs.readFileSync(dockerfilePath, "utf-8").split("\n");
  const startIndex = lines.findIndex((line) =>
    line.includes('RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then'),
  );
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trimEnd() === "    fi",
  );
  const found = startIndex !== -1 && endIndex !== -1;
  const block = (found ? lines.slice(startIndex, endIndex + 1) : [])
    .join("\n")
    .replace(/^RUN /, "")
    .replaceAll("/usr/local/share/nemoclaw", outputDirectory)
    .replaceAll("/usr/local/share/ca-certificates", path.join(outputDirectory, "ca-certificates"))
    .replaceAll("command -v update-ca-certificates >/dev/null 2>&1", "true")
    .replaceAll("&& update-ca-certificates \\", "&& true \\")
    .replaceAll("/tmp/nemoclaw-corporate-ca.decoded", path.join(outputDirectory, "decoded"))
    .replaceAll(
      "install -d -o root -g root -m 0755",
      'install -d -o "$(id -u)" -g "$(id -g)" -m 0755',
    )
    .replaceAll("chown root:root", 'chown "$(id -u):$(id -g)"');
  const wrapper = path.join(outputDirectory, "decode.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `export NEMOCLAW_CORPORATE_CA_B64=${JSON.stringify(base64Value)}`,
      block || "echo 'decode block not found' >&2; exit 3",
    ].join("\n"),
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [wrapper], { encoding: "utf-8" });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}
