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
    ["openclaw", "ghcr.io/nvidia/nemoclaw/openclaw-sandbox", 998, 998],
    ["hermes", "ghcr.io/nvidia/nemoclaw/hermes-sandbox", 998, 999],
    [
      "langchain-deepagents-code",
      "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
      999,
      999,
    ],
    ["pi", "ghcr.io/nvidia/nemoclaw/pi-sandbox", 999, 999],
  ] as const)(
    "loads %s image composition from its package manifest",
    (agent, repository, uid, gid) => {
      const manifestPath = path.join(ROOT, "packages", `nemoclaw-${agent}`, "manifest.yaml");
      expect(readManagedImageDeclaration(loadManifestRecord(manifestPath))).toEqual({
        repository,
        architectures: ["linux/amd64", "linux/arm64"],
        runtime_identity: { uid, gid, workdir: "/sandbox" },
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
    ).toThrow("must contain exactly");
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
});
