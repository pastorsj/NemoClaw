// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  directDockerfileContextSources,
  formatMissingDockerfileContextSources,
  missingDockerfileContextSources,
} from "../../../scripts/lib/dockerfile-copy-sources.mts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-copy-sources-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDockerfile(directory: string, source: string): string {
  const dockerfilePath = path.join(directory, "Dockerfile");
  fs.writeFileSync(dockerfilePath, source, "utf8");
  return dockerfilePath;
}

describe("optimized build-context Dockerfile sources", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses local COPY and ADD sources while ignoring build stages and pinned downloads", () => {
    const directory = makeTemporaryDirectory();
    const dockerfilePath = writeDockerfile(
      directory,
      [
        "FROM base AS build",
        "copy --chmod=0444 \\",
        "  scripts/lib/corporate-ca-runtime.sh \\",
        "  scripts/lib/sandbox-init.sh \\",
        "  /usr/local/lib/nemoclaw/",
        "COPY --from=build /out/runtime /usr/local/lib/runtime",
        "ADD packages/nemoclaw-example/runtime.tgz /usr/local/share/runtime.tgz",
        `ADD --checksum=sha256:${"a".repeat(64)} https://packages.example/runtime.tgz /tmp/runtime.tgz`,
      ].join("\n"),
    );

    expect(directDockerfileContextSources(dockerfilePath)).toEqual([
      { lineNumber: 2, source: "scripts/lib/corporate-ca-runtime.sh" },
      { lineNumber: 2, source: "scripts/lib/sandbox-init.sh" },
      { lineNumber: 7, source: "packages/nemoclaw-example/runtime.tgz" },
    ]);
  });

  it("reports an absent flagged COPY source with its Dockerfile line", () => {
    const directory = makeTemporaryDirectory();
    const dockerfilePath = writeDockerfile(
      directory,
      [
        "FROM base",
        "COPY --chmod=0444 scripts/lib/corporate-ca-runtime.sh /usr/local/lib/nemoclaw/",
      ].join("\n"),
    );

    const missing = missingDockerfileContextSources(dockerfilePath, directory);

    expect(missing).toEqual([
      {
        dockerfileLabel: "Dockerfile",
        lineNumber: 2,
        source: "scripts/lib/corporate-ca-runtime.sh",
      },
    ]);
    expect(formatMissingDockerfileContextSources(missing)).toContain(
      "Dockerfile:2 missing scripts/lib/corporate-ca-runtime.sh",
    );
  });

  it("requires a wildcard source to match at least one staged path", () => {
    const directory = makeTemporaryDirectory();
    const dockerfilePath = writeDockerfile(
      directory,
      "COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/\n",
    );
    const scriptsDirectory = path.join(directory, "nemoclaw-blueprint", "scripts");
    fs.mkdirSync(scriptsDirectory, { recursive: true });

    expect(missingDockerfileContextSources(dockerfilePath, directory)).toHaveLength(1);

    fs.writeFileSync(path.join(scriptsDirectory, "http-proxy-fix.js"), "fixture\n", "utf8");
    expect(missingDockerfileContextSources(dockerfilePath, directory)).toEqual([]);
  });

  it.each([
    ["JSON array", 'COPY ["scripts/lib/sandbox-init.sh", "/tmp/"]'],
    ["build-stage JSON array", 'COPY --from=build ["out", "/target"]'],
    ["heredoc", "COPY <<EOF /tmp/generated"],
    ["unhandled direct flag", "COPY --exclude=*.md scripts/lib/sandbox-init.sh /tmp/"],
    ["unhandled build-stage flag", "COPY --from=build --exclude=*.md /out/runtime /tmp/runtime"],
    ["variable source", "COPY scripts/$SOURCE /tmp/source"],
    ["absolute source", "COPY /etc/passwd /tmp/passwd"],
    ["parent traversal", "COPY ../outside /tmp/outside"],
  ])("rejects the %s COPY form instead of omitting its sources", (_form, dockerfile) => {
    const directory = makeTemporaryDirectory();
    const dockerfilePath = writeDockerfile(directory, dockerfile);

    expect(() => directDockerfileContextSources(dockerfilePath), dockerfile).toThrow(
      /Unsupported (?:direct )?Dockerfile (?:COPY (?:form|source)|heredoc instruction)/u,
    );
  });
});
