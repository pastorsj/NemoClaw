// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface OpenClawSealer {
  buildConfigHash(config: Buffer, fabric: Buffer): string;
  main(): void;
  readStableFile(target: string, maxBytes: bigint): Buffer;
  writeHashAtomically(target: string, contents: string): void;
}

const requireModule = createRequire(import.meta.url);
const sealer = requireModule(path.resolve("runtime/seal-config.cts")) as OpenClawSealer;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-seal-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_MANAGED_STARTUP_REPLAY;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("OpenClaw managed startup config sealer", () => {
  it("installs one immutable command at the core-owned image path", () => {
    const dockerfile = fs.readFileSync(path.resolve("Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      "COPY --chmod=0555 packages/nemoclaw-openclaw/runtime/seal-config.cts /usr/local/lib/nemoclaw/seal-config",
    );
    expect(dockerfile).toContain(
      "check_metadata /usr/local/lib/nemoclaw/seal-config 'root:root:555'",
    );
  });

  it("builds the existing two-file runtime integrity anchor", () => {
    const config = Buffer.from('{"agents":{}}\n');
    const fabric = Buffer.from('{"endpoint":"https://example.test"}\n');

    expect(sealer.buildConfigHash(config, fabric)).toBe(
      `${createHash("sha256").update(config).digest("hex")}  openclaw.json\n` +
        `${createHash("sha256").update(fabric).digest("hex")}  fabric.json\n`,
    );
  });

  it("writes the sandbox-owned compatibility anchor atomically", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, ".config-hash");
    fs.writeFileSync(target, "old\n", { mode: 0o600 });

    sealer.writeHashAtomically(target, "new\n");

    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o660);
    expect(fs.readdirSync(directory)).toEqual([".config-hash"]);
  });

  it("makes committed replay a bounded no-op and rejects an ambiguous mode", () => {
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "seal-config"]);
    process.env.NEMOCLAW_MANAGED_STARTUP_REPLAY = "1";
    expect(() => sealer.main()).not.toThrow();

    process.env.NEMOCLAW_MANAGED_STARTUP_REPLAY = "unexpected";
    expect(() => sealer.main()).toThrow(/must be 0 or 1/u);
  });

  it("rejects arguments before touching managed configuration", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "seal-config", "attacker"]);

    expect(() => sealer.main()).toThrow(/accepts no arguments/u);
  });
});
