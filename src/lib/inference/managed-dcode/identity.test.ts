// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { harnessPackageContentDigest, resolveHarnessPackage } from "../../harness/package-registry";
import { normalizeManagedDcodeModelName, resolveManagedDcodeIdentity } from "./identity";

const temporaryHomes: string[] = [];

function writeInstalledDcodeRuntime(): { home: string; runtimePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-runtime-"));
  temporaryHomes.push(home);
  const root = path.join(home, ".nemoclaw", "harnesses", "nemoclaw-langchain-deepagents-code");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@nvidia/nemoclaw-langchain-deepagents-code",
      version: "1.2.3",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), "name: langchain-deepagents-code\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  const runtimePath = path.join(root, "managed-identity.cts");
  fs.writeFileSync(
    runtimePath,
    [
      '"use strict";',
      "module.exports = {",
      '  OPENROUTER_ENDPOINT_URL: "https://openrouter.ai/api/v1",',
      '  OPENROUTER_PROVIDER_NAME: "openrouter-api",',
      '  normalizeManagedDcodeEndpointUrl() { return "https://installed.example/v1"; },',
      '  normalizeManagedDcodeModelName() { return "installed-dcode-runtime"; },',
      "  resolveManagedDcodeIdentity() {",
      '    return { provider: "openai", model: "installed", defaultModel: "openai:installed" };',
      "  },",
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

describe("Deep Agents Code managed-identity package runtime", testTimeoutOptions(30_000), () => {
  it("uses the bundled Deep Agents Code module by default", () => {
    expect(resolveManagedDcodeIdentity("openrouter-api", "openrouter:model", null)).toEqual({
      provider: "openrouter",
      model: "model",
      defaultModel: "openrouter:model",
    });
  });

  it("uses the receipt-verified installed Deep Agents Code module", () => {
    const installed = writeInstalledDcodeRuntime();
    vi.stubEnv("HOME", installed.home);

    expect(resolveHarnessPackage("langchain-deepagents-code")?.rootDir).toBe(
      path.join(installed.home, ".nemoclaw", "harnesses", "nemoclaw-langchain-deepagents-code"),
    );

    expect(normalizeManagedDcodeModelName("ignored by installed runtime")).toBe(
      "installed-dcode-runtime",
    );
    fs.appendFileSync(installed.runtimePath, "// changed after capture\n");
    expect(normalizeManagedDcodeModelName("still captured")).toBe("installed-dcode-runtime");
  });
});
