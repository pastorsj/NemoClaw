// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { harnessPackageContentDigest, installBundledHarness } from "../harness/package-registry";
import { getEffectiveSandboxAgent } from "./sandbox-agent";
import { agentSupportsWebSearch, agentSupportsWebSearchProvider } from "./web-search-support";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-web-search-support-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeDockerfile(dir: string, content: string, fileName = "Dockerfile"): string {
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentSupportsWebSearch", () => {
  it("detects default, OpenClaw, and Hermes agent support", () => {
    expect(agentSupportsWebSearch(null)).toBe(true);
    expect(agentSupportsWebSearch({ name: "openclaw" })).toBe(true);
    expect(agentSupportsWebSearch({ name: "hermes" })).toBe(true);
  });

  it("accepts Hermes when its Dockerfile declares web-search support", () => {
    const root = tmpRoot();
    const dockerfile = writeDockerfile(root, "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n");

    expect(agentSupportsWebSearch({ name: "hermes", dockerfilePath: dockerfile }, null, root)).toBe(
      true,
    );
    expect(
      agentSupportsWebSearchProvider(
        { name: "hermes", dockerfilePath: dockerfile },
        "brave",
        null,
        root,
      ),
    ).toBe(false);
  });

  it("requires a provider selector arg for Tavily while preserving legacy Brave support", () => {
    const root = tmpRoot();
    const legacyDockerfile = writeDockerfile(
      root,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n",
      "Legacyfile",
    );
    const providerAwareDockerfile = writeDockerfile(
      root,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\nARG NEMOCLAW_WEB_SEARCH_PROVIDER=brave\n",
      "Providerfile",
    );

    expect(
      agentSupportsWebSearchProvider(
        { name: "openclaw", dockerfilePath: legacyDockerfile },
        "brave",
        null,
        root,
      ),
    ).toBe(true);
    expect(
      agentSupportsWebSearchProvider(
        { name: "openclaw", dockerfilePath: legacyDockerfile },
        "tavily",
        null,
        root,
      ),
    ).toBe(false);
    expect(
      agentSupportsWebSearchProvider(
        { name: "openclaw", dockerfilePath: providerAwareDockerfile },
        "tavily",
        null,
        root,
      ),
    ).toBe(true);
  });

  it("uses an override Dockerfile path first", () => {
    const root = tmpRoot();
    writeDockerfile(root, "FROM scratch\n");
    const override = writeDockerfile(root, "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n", "Customfile");

    expect(agentSupportsWebSearch({ name: "openclaw" }, override, root)).toBe(true);
  });

  it("uses the bundled OpenClaw Dockerfile only when no selected path exists", () => {
    const root = tmpRoot();
    const agentDockerfile = writeDockerfile(root, "FROM scratch\n", "Agentfile");
    writeDockerfile(
      root,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n",
      "packages/nemoclaw-openclaw/Dockerfile",
    );

    expect(
      agentSupportsWebSearch({ name: "openclaw", dockerfilePath: agentDockerfile }, null, root),
    ).toBe(false);
    const missingDockerfile = path.join(root, "missing-dockerfile");
    expect(
      agentSupportsWebSearch({ name: "openclaw", dockerfilePath: missingDockerfile }, null, root),
    ).toBe(false);
    expect(
      agentSupportsWebSearchProvider(
        { name: "openclaw", dockerfilePath: missingDockerfile },
        "brave",
        null,
        root,
      ),
    ).toBe(false);
    expect(agentSupportsWebSearch({ name: "openclaw" }, null, root)).toBe(true);
  });

  it("probes the installed OpenClaw package for the default agent", () => {
    const home = tmpRoot();
    const environment = { HOME: home };
    const installed = installBundledHarness("openclaw", environment);
    const dockerfile = path.join(installed.rootDir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    fs.writeFileSync(
      path.join(installed.rootDir, ".nemoclaw-install.json"),
      `${JSON.stringify({ installedDigest: harnessPackageContentDigest(installed.rootDir) })}\n`,
    );

    const effectiveAgent = getEffectiveSandboxAgent(null, environment);
    expect(effectiveAgent.dockerfilePath).toBe(dockerfile);
    expect(agentSupportsWebSearch(effectiveAgent)).toBe(false);
    expect(agentSupportsWebSearchProvider(effectiveAgent, "brave")).toBe(false);
  });

  it("returns false when no candidate declares the web-search ARG", () => {
    const root = tmpRoot();
    writeDockerfile(root, "FROM scratch\n", "packages/nemoclaw-openclaw/Dockerfile");

    expect(agentSupportsWebSearch({ name: "openclaw" }, null, root)).toBe(false);
  });
});
