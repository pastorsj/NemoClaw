// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../test/helpers/timeouts";
import { harnessPackageContentDigest, resolveHarnessPackage } from "./harness/package-registry";
import {
  buildHermesUpstreamHeader,
  hermesApiMode,
  hermesProviderKey,
} from "./hermes-managed-route";

const temporaryHomes: string[] = [];

function writeInstalledHermesRuntime(): { home: string; runtimePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-"));
  temporaryHomes.push(home);
  const root = path.join(home, ".nemoclaw", "harnesses", "nemoclaw-hermes");
  const hostDir = path.join(root, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@nvidia/nemoclaw-hermes",
      version: "1.2.3",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), "name: hermes\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  const runtimePath = path.join(hostDir, "managed-route.cts");
  fs.writeFileSync(
    runtimePath,
    [
      '"use strict";',
      "module.exports = {",
      '  HERMES_PROXY_REWRITE_SENTINEL: "installed-sentinel",',
      "  applyHermesManagedRoute() {},",
      '  buildHermesUpstreamHeader() { return "# installed Hermes header\\n"; },',
      "  hermesApiMode() { return null; },",
      '  hermesProviderKey() { return "installed-hermes-runtime"; },',
      "};",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest: harnessPackageContentDigest(root) })}\n`,
    { mode: 0o600 },
  );
  return { home, runtimePath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("Hermes managed-route package runtime", testTimeoutOptions(30_000), () => {
  it("uses the bundled Hermes module by default", () => {
    expect(hermesApiMode("openai-responses")).toBe("codex_responses");
  });

  it("uses the receipt-verified installed Hermes module", () => {
    const installed = writeInstalledHermesRuntime();
    vi.stubEnv("HOME", installed.home);

    expect(resolveHarnessPackage("hermes")?.rootDir).toBe(
      path.join(installed.home, ".nemoclaw", "harnesses", "nemoclaw-hermes"),
    );

    expect(hermesProviderKey("ignored by installed runtime")).toBe("installed-hermes-runtime");
    fs.appendFileSync(installed.runtimePath, "// changed after capture\n");
    expect(buildHermesUpstreamHeader({})).toBe("# installed Hermes header\n");
  });
});
