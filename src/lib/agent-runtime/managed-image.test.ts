// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

import { ROOT } from "../runner";
import { loadManifestRecord, parseManifestRecord } from "./manifest-readers";
import { readManagedImageDeclaration } from "./managed-image";

function declaration(overrides = ""): string {
  return `
name: future-harness
managed_image:
  repository: registry.example/team/future-harness
  architectures:
    - linux/amd64
    - linux/arm64
  runtime_identity:
    uid: 1234
    gid: 1235
    workdir: /sandbox
  startup_profile_contract_version: 1
  capability_contract_version: 1
${overrides}`;
}

function read(source: string) {
  return readManagedImageDeclaration(parseManifestRecord(source, "/fixture/manifest.yaml"));
}

describe("managed image package declaration", () => {
  it.each([
    [
      "openclaw",
      "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
      998,
      998,
      {
        workspace: { owner: "runtime", mode: "0755" },
        state_root: { mount_target: "/sandbox/.openclaw", mode: "2770" },
      },
    ],
    [
      "hermes",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
      998,
      999,
      {
        workspace: { owner: "runtime", mode: "0755" },
        state_root: { mount_target: "/sandbox/.hermes", mode: "3770" },
      },
    ],
    [
      "langchain-deepagents-code",
      "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
      999,
      999,
      { workspace: { owner: "root", mode: "1775" } },
    ],
    [
      "pi",
      "ghcr.io/nvidia/nemoclaw/pi-sandbox",
      999,
      999,
      { workspace: { owner: "runtime", mode: "0755" } },
    ],
  ] as const)(
    "loads %s image composition from its package manifest",
    (agent, repository, uid, gid, layout) => {
      const manifestPath = path.join(ROOT, "packages", `nemoclaw-${agent}`, "manifest.yaml");
      expect(readManagedImageDeclaration(loadManifestRecord(manifestPath))).toEqual({
        repository,
        architectures: ["linux/amd64", "linux/arm64"],
        runtime_identity: { uid, gid, workdir: "/sandbox" },
        ...layout,
        startup_profile_contract_version: 1,
        capability_contract_version: 1,
      });
    },
  );

  it("reads an unknown harness without consulting a core harness catalogue", () => {
    const result = read(declaration());

    expect(result).toEqual({
      repository: "registry.example/team/future-harness",
      architectures: ["linux/amd64", "linux/arm64"],
      runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
      startup_profile_contract_version: 1,
      capability_contract_version: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.runtime_identity)).toBe(true);
  });

  it("reads a future harness workspace and durable state root without a core catalogue", () => {
    const result = read(
      declaration(`  workspace:
    owner: root
    mode: "1775"
  state_root:
    mount_target: /sandbox/.future-harness
    mode: "2770"`),
    );

    expect(result).toMatchObject({
      workspace: { owner: "root", mode: "1775" },
      state_root: { mount_target: "/sandbox/.future-harness", mode: "2770" },
    });
    expect(Object.isFrozen(result?.workspace)).toBe(true);
    expect(Object.isFrozen(result?.state_root)).toBe(true);
  });

  it.each([
    "https://registry.example/team/future-harness",
    "user@registry.example/team/future-harness",
    "registry.example/team/future-harness:latest",
    `registry.example/team/future-harness@sha256:${"a".repeat(64)}`,
    "Registry.example/team/future-harness",
  ])("rejects unsafe or mutable repository identity %s", (repository) => {
    expect(() =>
      read(declaration().replace("registry.example/team/future-harness", repository)),
    ).toThrow("without a tag or digest");
  });

  it("rejects duplicate platforms and unknown declaration fields", () => {
    expect(() => read(declaration().replace("    - linux/arm64", "    - linux/amd64"))).toThrow(
      "must not contain duplicates",
    );
    expect(() =>
      read(
        declaration().replace(
          "  capability_contract_version: 1",
          "  capability_contract_version: 1\n  command: id",
        ),
      ),
    ).toThrow("and only");
  });

  it.each([
    ["uid", "0", "positive 32-bit integer"],
    ["gid", "2147483648", "positive 32-bit integer"],
    ["workdir", "/tmp", "must be /sandbox"],
    ["startup_profile_contract_version", "2", "must be 1"],
    ["capability_contract_version", "2", "must be 1"],
  ])("rejects unsupported %s", (field, replacement, message) => {
    const values: Record<string, string> = {
      uid: "1234",
      gid: "1235",
      workdir: "/sandbox",
      startup_profile_contract_version: "1",
      capability_contract_version: "1",
    };
    expect(() =>
      read(declaration().replace(`${field}: ${values[field]}`, `${field}: ${replacement}`)),
    ).toThrow(message);
  });

  it.each([
    ["workspace", "null", "must be an object"],
    ["workspace.owner", "service", "must be runtime or root"],
    ["workspace.mode", '"0775"', "must be 0755 or 1775"],
    ["state_root", "[]", "must be an object"],
    [
      "state_root.mount_target",
      "/sandbox/nested/state",
      "must be one directory directly below /sandbox",
    ],
    ["state_root.mount_target", "/tmp/state", "must be one directory directly below /sandbox"],
    ["state_root.mode", '"0777"', "must be 0770, 2770, or 3770"],
  ] as const)("rejects invalid %s declarations", (field, replacement, message) => {
    const validLayout = `  workspace:
    owner: runtime
    mode: "0755"
  state_root:
    mount_target: /sandbox/.future-harness
    mode: "2770"`;
    const sources: Record<string, string> = {
      workspace: validLayout.replace(
        '  workspace:\n    owner: runtime\n    mode: "0755"',
        `  workspace: ${replacement}`,
      ),
      "workspace.owner": validLayout.replace("owner: runtime", `owner: ${replacement}`),
      "workspace.mode": validLayout.replace('mode: "0755"', `mode: ${replacement}`),
      state_root: validLayout.replace(
        '  state_root:\n    mount_target: /sandbox/.future-harness\n    mode: "2770"',
        `  state_root: ${replacement}`,
      ),
      "state_root.mount_target": validLayout.replace("/sandbox/.future-harness", replacement),
      "state_root.mode": validLayout.replace('mode: "2770"', `mode: ${replacement}`),
    };

    expect(() => read(declaration(sources[field]))).toThrow(message);
  });

  it("rejects unknown workspace and state-root fields", () => {
    expect(() =>
      read(
        declaration(`  workspace:
    owner: runtime
    mode: "0755"
    user: future
`),
      ),
    ).toThrow("managed_image.workspace' must contain exactly");
    expect(() =>
      read(
        declaration(`  state_root:
    mount_target: /sandbox/.future-harness
    mode: "2770"
    volume: future
`),
      ),
    ).toThrow("managed_image.state_root' must contain exactly");
  });
});
