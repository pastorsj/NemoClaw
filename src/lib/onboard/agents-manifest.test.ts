// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAgentsManifestEnv,
  assertAgentsManifestCapability,
  loadAgentsManifest,
} from "./agents-manifest";

let temporaryDirectory = "";

function writeManifest(name: string, contents: string): string {
  const target = path.join(temporaryDirectory, name);
  fs.writeFileSync(target, contents, "utf8");
  return target;
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agents-manifest-"));
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("agent roster manifest transport", () => {
  it("returns the historical empty roster for an empty file", () => {
    expect(loadAgentsManifest(writeManifest("empty.yaml", ""))).toEqual({ agents: [] });
  });

  it("preserves package-native fields without adding OpenClaw paths", () => {
    const payload = loadAgentsManifest(
      writeManifest(
        "future.yaml",
        ["workers:", "  - name: planner", "strategy: round-robin", ""].join("\n"),
      ),
    );

    expect(payload).toEqual({ workers: [{ name: "planner" }], strategy: "round-robin" });
  });

  it("leaves OpenClaw path defaults to the OpenClaw package", () => {
    const payload = loadAgentsManifest(
      writeManifest("openclaw.yaml", ["agents:", "  - id: alpha", ""].join("\n")),
    );

    expect(payload).toEqual({ agents: [{ id: "alpha" }] });
  });

  it("rejects a non-mapping top level", () => {
    expect(() => loadAgentsManifest(writeManifest("list.yaml", "- id: alpha\n"))).toThrow(
      /must be a YAML mapping/u,
    );
  });

  it("rejects oversized input before package transport", () => {
    expect(() =>
      loadAgentsManifest(writeManifest("large.yaml", `value: ${"x".repeat(65 * 1024)}\n`)),
    ).toThrow(/64 KiB input boundary/u);
  });

  it.each(["apiKey", "token", "client_secret", "privateKey", "password"])(
    "rejects credential-shaped fields before package transport [case %#]",
    (key) => {
      const file = writeManifest(
        "credential.yaml",
        ["agents:", "  - id: alpha", `    ${key}: unsafe`, ""].join("\n"),
      );
      expect(() => loadAgentsManifest(file)).toThrow(/looks like a credential/u);
    },
  );

  it("sets the existing bounded onboarding environment", () => {
    const environment: NodeJS.ProcessEnv = {};
    const file = writeManifest("agents.yaml", "agents:\n  - id: alpha\n");

    expect(applyAgentsManifestEnv(file, environment)).toEqual({ agents: [{ id: "alpha" }] });
    expect(JSON.parse(environment.NEMOCLAW_EXTRA_AGENTS_JSON ?? "null")).toEqual({
      agents: [{ id: "alpha" }],
    });
  });
});

describe("agent roster onboarding capability", () => {
  it("accepts an unknown future package that declares the typed capability", () => {
    expect(() =>
      assertAgentsManifestCapability({
        name: "future-harness",
        displayName: "Future Harness",
        agentRosterCapability: {
          support: "managed",
          adapter: "agent-roster",
          onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
        },
      }),
    ).not.toThrow();
  });

  it("returns typed unsupported for a selected package that omits the capability", () => {
    expect(() =>
      assertAgentsManifestCapability({
        name: "future-harness",
        displayName: "Future Harness",
        agentRosterCapability: null,
      }),
    ).toThrow(/not supported by Future Harness/u);
  });
});
