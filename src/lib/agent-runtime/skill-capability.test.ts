// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseManifestRecord } from "./manifest-readers";
import { readSkillCapability } from "./skill-capability";

function read(source: string) {
  return readSkillCapability(parseManifestRecord(source, "/fixture/manifest.yaml"));
}

function managedCapability(overrides = ""): string {
  return `
name: future-harness
skills:
  support: managed
  install_root: /sandbox/.future/skills
  mirror_root: $HOME/.future/skills
  collision: replace
  removal: remove
  activation:
    kind: reset-session-index
    path: /sandbox/.future/sessions/index.json
  list_command: [skills, list]
  add_command: [skills, install, "{source}"]
  remove_command: [skills, remove, "{name}"]
${overrides}`;
}

describe("skill package capability", () => {
  it("reads an unknown harness without consulting a core harness catalogue", () => {
    const capability = read(managedCapability());

    expect(capability).toEqual({
      support: "managed",
      install_root: "/sandbox/.future/skills",
      mirror_root: "$HOME/.future/skills",
      collision: "replace",
      removal: "remove",
      activation: {
        kind: "reset-session-index",
        path: "/sandbox/.future/sessions/index.json",
      },
      list_command: ["skills", "list"],
      add_command: ["skills", "install", "{source}"],
      remove_command: ["skills", "remove", "{name}"],
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.activation)).toBe(true);
  });

  it("disables skill installation when a package omits the declaration", () => {
    expect(read("name: future-harness\n")).toEqual({
      support: "disabled",
      reason: "This harness package does not declare skill installation support.",
    });
  });

  it("preserves a package reason when the package disables skill installation", () => {
    expect(
      read(`
name: future-harness
skills:
  support: disabled
  reason: Future Harness has no native skill loader.
`),
    ).toEqual({
      support: "disabled",
      reason: "Future Harness has no native skill loader.",
    });
  });

  it("rejects multiline disabled reasons before they reach terminal output", () => {
    expect(() =>
      read(`
name: future-harness
skills:
  support: disabled
  reason: |-
    First line.
    Second line.
`),
    ).toThrow("single-line string");
  });

  it("rejects invisible formatting characters in a displayed disabled reason", () => {
    expect(() =>
      read(`
name: future-harness
skills:
  support: disabled
  reason: "Hidden\u202e text"
`),
    ).toThrow("single-line string");
  });

  it.each([
    ["a non-object declaration", "skills: []\n", "must be an object"],
    [
      "an install root outside the sandbox",
      managedCapability().replace("/sandbox/.future/skills", "/tmp/skills"),
      "canonical path below /sandbox",
    ],
    [
      "a traversing install root",
      managedCapability().replace("/sandbox/.future/skills", "/sandbox/.future/../skills"),
      "canonical path below /sandbox",
    ],
    [
      "a shell-expanding mirror root",
      managedCapability().replace("$HOME/.future/skills", "$PATH/.future/skills"),
      "canonical path below $HOME",
    ],
    [
      "a traversing mirror root",
      managedCapability().replace("$HOME/.future/skills", "$HOME/../skills"),
      "canonical path below $HOME",
    ],
    [
      "an activation path outside the sandbox",
      managedCapability().replace("/sandbox/.future/sessions/index.json", "/tmp/index.json"),
      "canonical path below /sandbox",
    ],
    [
      "an executable activation",
      managedCapability().replace("kind: reset-session-index", "kind: command"),
      "must contain exactly",
    ],
    [
      "a list command with a replacement token",
      managedCapability().replace(
        "list_command: [skills, list]",
        'list_command: [skills, list, "{name}"]',
      ),
      "must contain no {name} token",
    ],
    [
      "an add command without its source token",
      managedCapability().replace(
        'add_command: [skills, install, "{source}"]',
        "add_command: [skills, install]",
      ),
      "must contain exactly one {source} token",
    ],
    [
      "a remove command with two name tokens",
      managedCapability().replace(
        'remove_command: [skills, remove, "{name}"]',
        'remove_command: [skills, remove, "{name}", "{name}"]',
      ),
      "must contain exactly one {name} token",
    ],
    ["an unknown top-level field", managedCapability("  command: rm -rf /\n"), "and only"],
  ])("rejects %s", (_caseName, source, message) => {
    expect(() => read(source)).toThrow(message);
  });

  it("rejects unsupported fresh-only combinations", () => {
    const freshOnly = managedCapability()
      .replace("  mirror_root: $HOME/.future/skills\n", "")
      .replace('  remove_command: [skills, remove, "{name}"]\n', "")
      .replace("collision: replace", "collision: refuse");

    expect(() => read(freshOnly)).toThrow("removal' must be refuse");
    expect(() =>
      read(
        freshOnly
          .replace("removal: remove", "removal: refuse")
          .replace(
            "  collision: refuse\n",
            "  collision: refuse\n  mirror_root: $HOME/.future/skills\n",
          ),
      ),
    ).toThrow("mirror_root' requires collision: replace");
  });
});
