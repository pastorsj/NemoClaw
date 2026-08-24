// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { harnessPackageContentDigest } from "../harness/package-registry";
import {
  buildDcodeManagedExecLaunchArgs,
  getDeepAgentsCodeBaseImageInputPaths,
  getDeepAgentsCodeDistribution,
  getDcodeActivityProbe,
  getDcodeManagedExec,
} from "./deep-agents-code-specifications";
import {
  createHermesBaseImageQualificationProbe,
  hermesFinalBaseAcceptsResolution,
  parseHermesPinnedRemoteBaseRef,
} from "./hermes-base-image-qualification";

const temporaryHomes: string[] = [];

function writeInstalledHarness(
  id: "hermes" | "langchain-deepagents-code",
  runtimeRelativePath: string,
  runtimeSource: string,
): { home: string; root: string; runtimePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-qualification-runtime-"));
  temporaryHomes.push(home);
  const root = path.join(home, ".nemoclaw", "harnesses", `nemoclaw-${id}`);
  const runtimePath = path.join(root, ...runtimeRelativePath.split("/"));
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: `@nvidia/nemoclaw-${id}`,
      version: "1.2.3",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), `name: ${id}\n`);
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  fs.writeFileSync(runtimePath, runtimeSource);
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest: harnessPackageContentDigest(root) })}\n`,
    { mode: 0o600 },
  );
  return { home, root, runtimePath };
}

function deepAgentsCodeRuntimeSource(agentName: string): string {
  return [
    '"use strict";',
    "module.exports = {",
    "  buildDcodeManagedExecLaunchArgs(args) { return ['installed-launcher', ...args]; },",
    "  createDeepAgentsCodeDos2UnixProbe(imageRef) {",
    '    return { args: ["installed-dos2unix", imageRef], expectedOutput: "installed-ok" };',
    "  },",
    "  createDeepAgentsCodeVersionProbe(imageRef) {",
    '    return { args: ["installed-version", imageRef], distribution: "installed-dist" };',
    "  },",
    "  getDeepAgentsCodeBaseImageInputPaths() { return ['inputs/manifest.yaml']; },",
    "  getDeepAgentsCodeDistribution() { return 'installed-dist'; },",
    "  getDcodeActivityProbe() {",
    "    return {",
    `      agentName: ${JSON.stringify(agentName)},`,
    "      prefix: 'INSTALLED=',",
    "      script: 'printf installed',",
    "      states: { active: 'a', idleDcodeRuntime: 'i', unverifiableDcodeRuntime: 'u', noDcodeRuntime: 'n' },",
    "    };",
    "  },",
    "  getDcodeManagedExec() {",
    `    return { agentName: ${JSON.stringify(agentName)}, launcher: '/installed/launcher', missingDetail: 'missing installed launcher' };`,
    "  },",
    "};",
    "",
  ].join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  temporaryHomes.splice(0).forEach((home) => fs.rmSync(home, { force: true, recursive: true }));
});

describe("package-owned qualification specifications", testTimeoutOptions(30_000), () => {
  it("uses the receipt-verified installed Hermes qualification module", () => {
    const installed = writeInstalledHarness(
      "hermes",
      "host/base-qualification.cts",
      [
        '"use strict";',
        "module.exports = {",
        "  createHermesBaseImageQualificationProbe(imageRef) {",
        '    return { args: ["installed-hermes-probe", imageRef], expectedOutput: "installed-ok" };',
        "  },",
        "  hermesFinalBaseAcceptsResolution(input) { return input.imageRef === 'installed-ref'; },",
        "  isHermesOfficialBaseDigestRef(imageRef) { return imageRef === 'installed-ref'; },",
        "  isHermesRepositoryBaseRef(imageRef) { return imageRef === 'installed-local'; },",
        "  parseHermesPinnedRemoteBaseRef() { return 'installed-ref'; },",
        "};",
        "",
      ].join("\n"),
    );
    vi.stubEnv("HOME", installed.home);

    expect(createHermesBaseImageQualificationProbe("image:test")).toEqual({
      args: ["installed-hermes-probe", "image:test"],
      expectedOutput: "installed-ok",
    });
    expect(parseHermesPinnedRemoteBaseRef("ignored")).toBe("installed-ref");
    expect(
      hermesFinalBaseAcceptsResolution({
        imageRef: "installed-ref",
        trackedPinnedRemoteRef: "ignored",
      }),
    ).toBe(true);

    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");
    expect(createHermesBaseImageQualificationProbe("image:test")).toEqual({
      args: ["installed-hermes-probe", "image:test"],
      expectedOutput: "installed-ok",
    });
  });

  it("uses the receipt-verified installed Deep Agents Code qualification module", () => {
    const installed = writeInstalledHarness(
      "langchain-deepagents-code",
      "host/base-qualification.cts",
      deepAgentsCodeRuntimeSource("langchain-deepagents-code"),
    );
    vi.stubEnv("HOME", installed.home);

    expect(getDeepAgentsCodeBaseImageInputPaths()).toEqual(["inputs/manifest.yaml"]);
    expect(getDeepAgentsCodeDistribution()).toBe("installed-dist");
    expect(getDcodeActivityProbe()).toMatchObject({ agentName: "langchain-deepagents-code" });
    expect(getDcodeManagedExec()).toMatchObject({ launcher: "/installed/launcher" });
    expect(buildDcodeManagedExecLaunchArgs(["sh", "-c", "true"])).toEqual([
      "installed-launcher",
      "sh",
      "-c",
      "true",
    ]);

    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");
    expect(getDeepAgentsCodeDistribution()).toBe("installed-dist");
  });

  it("rejects Hermes package drift before capturing its qualification module", () => {
    const installed = writeInstalledHarness(
      "hermes",
      "host/base-qualification.cts",
      [
        '"use strict";',
        "module.exports = {",
        "  createHermesBaseImageQualificationProbe() { return { args: ['probe'], expectedOutput: 'ok' }; },",
        "  hermesFinalBaseAcceptsResolution() { return true; },",
        "  isHermesOfficialBaseDigestRef() { return true; },",
        "  isHermesRepositoryBaseRef() { return true; },",
        "  parseHermesPinnedRemoteBaseRef() { return null; },",
        "};",
        "",
      ].join("\n"),
    );
    vi.stubEnv("HOME", installed.home);
    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");

    expect(() => createHermesBaseImageQualificationProbe("image:test")).toThrow(
      "Harness installation receipt does not match package content",
    );
  });

  it("rejects Deep Agents Code package drift before capturing its qualification module", () => {
    const installed = writeInstalledHarness(
      "langchain-deepagents-code",
      "host/base-qualification.cts",
      deepAgentsCodeRuntimeSource("langchain-deepagents-code"),
    );
    vi.stubEnv("HOME", installed.home);
    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");

    expect(() => getDeepAgentsCodeDistribution()).toThrow(
      "Harness installation receipt does not match package content",
    );
  });

  it.each([
    ["activity probe", getDcodeActivityProbe],
    ["managed exec", getDcodeManagedExec],
  ] as const)("rejects a Deep Agents Code %s with a different agent identity", (_label, read) => {
    const installed = writeInstalledHarness(
      "langchain-deepagents-code",
      "host/base-qualification.cts",
      deepAgentsCodeRuntimeSource("openclaw"),
    );
    vi.stubEnv("HOME", installed.home);

    expect(() => read()).toThrow(
      "LangChain Deep Agents Code qualification module returned an invalid specification.",
    );
  });
});
