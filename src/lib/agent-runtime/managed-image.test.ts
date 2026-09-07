// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

import { ROOT } from "../runner";
import { loadValidatedHarnessManifest, parseManifestRecord } from "./manifest-readers";
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
        rebuild_base_image: "not-required",
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
        rebuild_base_image: "pinned-remote",
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
      const result = readManagedImageDeclaration(loadValidatedHarnessManifest(manifestPath, agent));
      expect(result).toMatchObject({
        repository,
        architectures: ["linux/amd64", "linux/arm64"],
        runtime_identity: { uid, gid, workdir: "/sandbox" },
        ...layout,
      });
      expect(result?.startup_profile_environment?.length).toBeGreaterThan(0);
    },
  );

  it("reads an unknown harness without consulting a core harness catalogue", () => {
    const result = read(declaration());

    expect(result).toEqual({
      repository: "registry.example/team/future-harness",
      architectures: ["linux/amd64", "linux/arm64"],
      runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.runtime_identity)).toBe(true);
  });

  it("reads unknown-package rebuild base-image behavior as typed data", () => {
    expect(read(declaration("  rebuild_base_image: pinned-remote"))?.rebuild_base_image).toBe(
      "pinned-remote",
    );
  });

  it("reads finite base-image behavior without a package identity catalogue", () => {
    const pinnedRef = `registry.example/team/future-harness-base@sha256:${"ab".repeat(32)}`;
    const result = read(
      declaration(`  base_image:
    corporate_ca: true
    security_inventory: true
    package_probe: true
    pinned_remote:
      argument: BASE_IMAGE
      ref: ${pinnedRef}`),
    );

    expect(result?.base_image).toEqual({
      corporate_ca: true,
      security_inventory: true,
      package_probe: true,
      pinned_remote: { argument: "BASE_IMAGE", ref: pinnedRef },
    });
    expect(Object.isFrozen(result?.base_image)).toBe(true);
    expect(Object.isFrozen(result?.base_image?.pinned_remote)).toBe(true);
  });

  it.each([
    ["callback", "    callback: ./probe.js", "and only"],
    ["probe path", "    package_probe: ./probe.sh", "must be a boolean"],
    [
      "mutable pin",
      "    pinned_remote:\n      argument: BASE_IMAGE\n      ref: registry.example/team/base:latest",
      "canonical OCI SHA-256 digest reference",
    ],
    [
      "arbitrary build argument",
      `    pinned_remote:\n      argument: OTHER_IMAGE\n      ref: registry.example/team/base@sha256:${"ab".repeat(32)}`,
      "must be BASE_IMAGE",
    ],
  ] as const)("rejects a base-image %s", (_label, fields, message) => {
    expect(() => read(declaration(`  base_image:\n${fields}`))).toThrow(message);
  });

  it("reads a receipt-bound external publication with exact platform digests", () => {
    const result = read(
      declaration(`  publication:
    source:
      repository: ExampleOrg/future-harness
      revision: ${"a".repeat(40)}
      release: v1.2.3
      cohort: build-2026.09.05
    digests:
      linux/amd64: sha256:${"ab".repeat(32)}
      linux/arm64: sha256:${"cd".repeat(32)}`),
    );

    expect(result?.publication).toEqual({
      source: {
        repository: "ExampleOrg/future-harness",
        revision: "a".repeat(40),
        release: "v1.2.3",
        cohort: "build-2026.09.05",
      },
      digests: {
        "linux/amd64": `sha256:${"ab".repeat(32)}`,
        "linux/arm64": `sha256:${"cd".repeat(32)}`,
      },
    });
    expect(Object.isFrozen(result?.publication)).toBe(true);
    expect(Object.isFrozen(result?.publication?.source)).toBe(true);
    expect(Object.isFrozen(result?.publication?.digests)).toBe(true);
  });

  it.each([
    ["source repository", "repository: ExampleOrg/future-harness", "repository: https://bad"],
    ["source revision", `revision: ${"a".repeat(40)}`, "revision: main"],
    ["source release", "release: v1.2.3", "release: latest"],
    ["source cohort", "cohort: build-2026.09.05", "cohort: Build Latest"],
    ["platform digest", `linux/amd64: sha256:${"ab".repeat(32)}`, "linux/amd64: latest"],
  ] as const)("rejects a malformed publication %s", (_label, target, replacement) => {
    const published = declaration(`  publication:
    source:
      repository: ExampleOrg/future-harness
      revision: ${"a".repeat(40)}
      release: v1.2.3
      cohort: build-2026.09.05
    digests:
      linux/amd64: sha256:${"ab".repeat(32)}
      linux/arm64: sha256:${"cd".repeat(32)}`);

    expect(() => read(published.replace(target, replacement))).toThrow("managed_image.publication");
  });

  it("rejects missing, extra, and executable-shaped publication fields", () => {
    const published = declaration(`  publication:
    source:
      repository: ExampleOrg/future-harness
      revision: ${"a".repeat(40)}
      release: v1.2.3
      cohort: build-42
    digests:
      linux/amd64: sha256:${"ab".repeat(32)}
      linux/arm64: sha256:${"cd".repeat(32)}`);

    expect(() => read(published.replace(/\n      linux\/arm64:.*$/mu, ""))).toThrow(
      "publication.digests' must contain exactly",
    );
    expect(() => read(`${published}\n      linux/s390x: sha256:${"ef".repeat(32)}`)).toThrow(
      "publication.digests' must contain exactly",
    );
    expect(() =>
      read(published.replace("  publication:", "  publication:\n    command: pull")),
    ).toThrow("publication' must contain exactly");
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

  it("reads bounded non-secret startup environment declarations for a future package", () => {
    const result = read(
      declaration(`  startup_profile_environment:
    - name: FUTURE_PUBLIC_MODE
      value_type: string
      max_bytes: 64`),
    );

    expect(result?.startup_profile_environment).toEqual([
      { name: "FUTURE_PUBLIC_MODE", value_type: "string", max_bytes: 64 },
    ]);
    expect(Object.isFrozen(result?.startup_profile_environment)).toBe(true);
  });

  it("permits a typed non-secret token quantity without permitting token credentials", () => {
    const result = read(
      declaration(`  startup_profile_environment:
    - name: FUTURE_MAX_TOKENS
      value_type: positive-integer
      max_bytes: 10`),
    );
    expect(result?.startup_profile_environment).toEqual([
      { name: "FUTURE_MAX_TOKENS", value_type: "positive-integer", max_bytes: 10 },
    ]);
    ["FUTURE_AUTH_TOKEN", "FUTURE_AUTH_TOKENS"].forEach((name) => {
      expect(() =>
        read(
          declaration(`  startup_profile_environment:
    - name: ${name}
      value_type: positive-integer
      max_bytes: 10`),
        ),
      ).toThrow(/non-secret, non-authority/u);
    });
  });

  it.each(["FUTURE_API_KEY", "FUTURE_AUTH_TOKEN", "NEMOCLAW_INFERENCE_BASE_URL"])(
    "rejects credential-shaped or core-authority startup input %s",
    (name) => {
      expect(() =>
        read(
          declaration(`  startup_profile_environment:
    - name: ${name}
      value_type: string
      max_bytes: 64`),
        ),
      ).toThrow(/non-secret, non-authority/u);
    },
  );

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
    expect(() => read(declaration("  command: id"))).toThrow("and only");
  });

  it.each([
    ["uid", "0", "positive 32-bit integer"],
    ["gid", "2147483648", "positive 32-bit integer"],
    ["workdir", "/tmp", "must be /sandbox"],
  ])("rejects unsupported %s", (field, replacement, message) => {
    const values: Record<string, string> = {
      uid: "1234",
      gid: "1235",
      workdir: "/sandbox",
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
