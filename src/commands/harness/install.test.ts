// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HarnessPackageUnavailableError,
  listHarnessPackageInventory,
  resolveHarnessPackageInstallSelection,
} from "../../lib/agent-runtime/package/catalog";
import { installHarnessPackage } from "../../lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../lib/agent-runtime/package/receipt";
import { readInstalledHarnessPackage } from "../../lib/agent-runtime/package/store";
import HarnessInstallCommand, { harnessInstallCommandDependencies } from "./install";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-harness-command-tests");
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  },
};
const originalHome = process.env.HOME;
const REVIEWED_FIXTURES = Object.freeze([
  { id: "hermes", displayName: "Hermes Agent", packageVersion: "0.1.0" },
  {
    id: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    packageVersion: "0.1.4",
    aliases: ["dcode"],
  },
  { id: "openclaw", displayName: "OpenClaw", packageVersion: "0.1.1" },
]);

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-harness-command-test-unused");
let bundledRoot = path.join(fixtureRoot, "bundled");
let storeRoot = path.join(fixtureRoot, "store");
let privateHome = path.join(fixtureRoot, "home");
let packageCodeMarker = path.join(fixtureRoot, "package-code-ran");

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writeReviewedBundle(): void {
  fs.mkdirSync(bundledRoot, { recursive: true, mode: 0o700 });
  REVIEWED_FIXTURES.forEach((declaration) => {
    const packageRoot = path.join(bundledRoot, `nemoclaw-${declaration.id}`);
    const manifestPath = `packages/nemoclaw-${declaration.id}/manifest.yaml`;
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    writeFixtureFile(
      packageRoot,
      "nemoclaw-package.json",
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "agent-runtime",
        id: declaration.id,
        displayName: declaration.displayName,
        packageVersion: declaration.packageVersion,
        manifest: manifestPath,
      })}\n`,
    );
    writeFixtureFile(
      packageRoot,
      manifestPath,
      [
        `name: ${declaration.id}`,
        `display_name: ${JSON.stringify(declaration.displayName)}`,
        "description: Reviewed adapter",
        ...(declaration.aliases
          ? ["aliases:", ...declaration.aliases.map((alias) => `  - ${alias}`)]
          : []),
        "",
      ].join("\n"),
    );
    writeFixtureFile(packageRoot, "runtime/payload.txt", `${declaration.id}\n`);
  });
  writeFixtureFile(
    path.join(bundledRoot, "nemoclaw-openclaw"),
    "runtime/entry.mjs",
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(packageCodeMarker)}, "ran");\n`,
  );
}

function writePiBundle(): void {
  const packageRoot = path.join(bundledRoot, "nemoclaw-pi");
  const manifestPath = "packages/nemoclaw-pi/manifest.yaml";
  fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writeFixtureFile(
    packageRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "pi",
      displayName: "Pi",
      packageVersion: "0.1.0",
      manifest: manifestPath,
    })}\n`,
  );
  writeFixtureFile(
    packageRoot,
    manifestPath,
    ["name: pi", "display_name: Pi", "description: Reviewed candidate adapter", ""].join("\n"),
  );
  writeFixtureFile(packageRoot, "runtime/payload.txt", "pi\n");
}

function writeLocalPackage(id = "future-harness"): string {
  const packageRoot = path.join(fixtureRoot, "local", `nemoclaw-${id}`);
  const manifestPath = `packages/nemoclaw-${id}/manifest.yaml`;
  fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writeFixtureFile(
    packageRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id,
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      manifest: manifestPath,
    })}\n`,
  );
  writeFixtureFile(
    packageRoot,
    manifestPath,
    [
      `name: ${id}`,
      "display_name: Future Harness",
      "description: Locally built adapter",
      "aliases:",
      "  - future",
      "runtime:",
      "  kind: gateway",
      "",
    ].join("\n"),
  );
  writeFixtureFile(packageRoot, "runtime/payload.txt", "local package\n");
  writeFixtureFile(
    packageRoot,
    "runtime/entry.mjs",
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(packageCodeMarker)}, "ran");\n`,
  );
  return packageRoot;
}

function catalogueOptions() {
  return { bundledRoot, storeRoot } as const;
}

function wirePrivateDependencies() {
  const prompt = vi.spyOn(harnessInstallCommandDependencies, "prompt").mockResolvedValue("1");
  const isStdinTty = vi
    .spyOn(harnessInstallCommandDependencies, "isStdinTty")
    .mockReturnValue(false);
  const listInventory = vi
    .spyOn(harnessInstallCommandDependencies, "listHarnessPackageInventory")
    .mockImplementation(() => listHarnessPackageInventory(catalogueOptions()));
  const resolveSelection = vi
    .spyOn(harnessInstallCommandDependencies, "resolveHarnessPackageInstallSelection")
    .mockImplementation((selector) =>
      resolveHarnessPackageInstallSelection(selector, catalogueOptions()),
    );
  const installPackage = vi
    .spyOn(harnessInstallCommandDependencies, "installHarnessPackage")
    .mockImplementation((source) => installHarnessPackage(source, { storeRoot }));
  const getBuildIdentity = vi
    .spyOn(harnessInstallCommandDependencies, "getBuildIdentity")
    .mockReturnValue(SOURCE_IDENTITY.nemoclawBuildIdentity);
  return {
    getBuildIdentity,
    installPackage,
    isStdinTty,
    listInventory,
    prompt,
    resolveSelection,
  };
}

function installedIds(): readonly string[] {
  return listHarnessPackageInventory(catalogueOptions()).installed.map(({ id }) => id);
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  bundledRoot = path.join(fixtureRoot, "bundled");
  storeRoot = path.join(fixtureRoot, "store");
  privateHome = path.join(fixtureRoot, "home");
  packageCodeMarker = path.join(fixtureRoot, "package-code-ran");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  fs.mkdirSync(privateHome, { mode: 0o700 });
  fs.writeFileSync(path.join(privateHome, "sentinel"), "unchanged\n", { mode: 0o600 });
  process.env.HOME = privateHome;
  writeReviewedBundle();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("harness install oclif command", () => {
  it("installs an exact reviewed ID without executing package-owned code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dependencies = wirePrivateDependencies();

    await HarnessInstallCommand.run(["openclaw"], process.cwd());

    expect(installedIds()).toEqual(["openclaw"]);
    expect(dependencies.getBuildIdentity).toHaveBeenCalledWith({ rootDir: process.cwd() });
    expect(fs.existsSync(packageCodeMarker)).toBe(false);
    expect(fs.readdirSync(privateHome)).toEqual(["sentinel"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Installed harness package 'openclaw'/),
    );
  });

  it("installs one explicitly trusted local built package without executing its code", async () => {
    const localRoot = writeLocalPackage();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    wirePrivateDependencies();

    await HarnessInstallCommand.run(
      ["future-harness", "--from", localRoot, "--yes-i-trust-local-package"],
      process.cwd(),
    );

    expect(installedIds()).toEqual(["future-harness"]);
    expect(
      readInstalledHarnessPackage("future-harness", { storeRoot })?.receipt.sourceIdentity,
    ).toEqual({ kind: "local" });
    expect(fs.existsSync(packageCodeMarker)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Installed trusted local harness package 'future-harness'/),
    );
  });

  it("requires an exact id and explicit trust before reading a local package", async () => {
    const localRoot = writeLocalPackage();
    const dependencies = wirePrivateDependencies();

    await expect(
      HarnessInstallCommand.run(
        ["--from", localRoot, "--yes-i-trust-local-package"],
        process.cwd(),
      ),
    ).rejects.toThrow("canonical harness package ID is required");
    await expect(
      HarnessInstallCommand.run(["future-harness", "--from", localRoot], process.cwd()),
    ).rejects.toThrow("Local harness packages are trusted code");

    expect(dependencies.installPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects the local trust acknowledgement without a local source", async () => {
    const dependencies = wirePrivateDependencies();

    await expect(
      HarnessInstallCommand.run(["openclaw", "--yes-i-trust-local-package"], process.cwd()),
    ).rejects.toThrow("may be used only with '--from'");

    expect(dependencies.installPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects a local package whose declared id differs from the requested id", async () => {
    const localRoot = writeLocalPackage();
    wirePrivateDependencies();

    await expect(
      HarnessInstallCommand.run(
        ["other-harness", "--from", localRoot, "--yes-i-trust-local-package"],
        process.cwd(),
      ),
    ).rejects.toThrow("does not match the requested installation id");

    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("does not treat a URL as a local package source", async () => {
    const dependencies = wirePrivateDependencies();

    await expect(
      HarnessInstallCommand.run(
        [
          "future-harness",
          "--from",
          "https://example.invalid/package",
          "--yes-i-trust-local-package",
        ],
        process.cwd(),
      ),
    ).rejects.toThrow("accepts a local filesystem directory, not a URL");

    expect(dependencies.installPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it.each(["unsafe-mode", "symbolic-link", "authoring-path"])(
    "rejects a local package with %s without changing the store",
    async (caseName) => {
      const localRoot = writeLocalPackage();
      switch (caseName) {
        case "unsafe-mode":
          fs.chmodSync(path.join(localRoot, "runtime/payload.txt"), 0o666);
          break;
        case "symbolic-link":
          fs.symlinkSync("payload.txt", path.join(localRoot, "runtime/link"));
          break;
        case "authoring-path":
          writeFixtureFile(
            localRoot,
            "tests/adapter.test.ts",
            "throw new Error('must not run');\n",
          );
          break;
      }
      wirePrivateDependencies();

      await expect(
        HarnessInstallCommand.run(
          ["future-harness", "--from", localRoot, "--yes-i-trust-local-package"],
          process.cwd(),
        ),
      ).rejects.toThrow();

      expect(fs.readdirSync(storeRoot)).toEqual([]);
      expect(fs.existsSync(packageCodeMarker)).toBe(false);
    },
  );

  it("rejects a mutable local source owned by another user", async () => {
    const localRoot = writeLocalPackage();
    const actualUid = process.geteuid?.() ?? 1;
    vi.spyOn(process, "geteuid").mockReturnValue(actualUid + 10_000);
    wirePrivateDependencies();

    await expect(
      HarnessInstallCommand.run(
        ["future-harness", "--from", localRoot, "--yes-i-trust-local-package"],
        process.cwd(),
      ),
    ).rejects.toThrow(/untrusted owner/u);

    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("resolves an exact current public alias to its canonical package", async () => {
    const dependencies = wirePrivateDependencies();

    await HarnessInstallCommand.run(["dcode"], process.cwd());

    expect(installedIds()).toEqual(["langchain-deepagents-code"]);
    expect(dependencies.resolveSelection).toHaveBeenCalledWith("dcode");
  });

  it("rejects direct Pi installation before changing the store when qualification is unavailable", async () => {
    writePiBundle();
    const dependencies = wirePrivateDependencies();

    await expect(HarnessInstallCommand.run(["pi"], process.cwd())).rejects.toThrow(
      /release candidate.*not selectable/u,
    );

    expect(dependencies.installPackage).not.toHaveBeenCalled();
    expect(installedIds()).toEqual([]);
  });

  it("installs Pi after its candidate qualification gate succeeds", async () => {
    writePiBundle();
    const dependencies = wirePrivateDependencies();
    const requireCandidate = vi
      .spyOn(harnessInstallCommandDependencies, "requireCandidateAgentSelectable")
      .mockImplementation(() => undefined);

    await HarnessInstallCommand.run(["pi"], process.cwd());

    expect(requireCandidate).toHaveBeenCalledWith("pi");
    expect(dependencies.installPackage).toHaveBeenCalledOnce();
    expect(installedIds()).toEqual(["pi"]);
  });

  it.each(["OpenClaw", "../openclaw", "https://example.invalid/package"])(
    "rejects unreviewed selector %s without changing the store",
    async (selector) => {
      wirePrivateDependencies();

      await expect(HarnessInstallCommand.run([selector], process.cwd())).rejects.toThrow(
        HarnessPackageUnavailableError,
      );

      expect(fs.readdirSync(storeRoot)).toEqual([]);
    },
  );

  it("prompts on a TTY and installs only the selected reviewed package", async () => {
    const dependencies = wirePrivateDependencies();
    dependencies.isStdinTty.mockReturnValue(true);
    dependencies.prompt.mockResolvedValue("1");

    await HarnessInstallCommand.run([], process.cwd());

    expect(installedIds()).toEqual(["hermes"]);
    expect(dependencies.prompt).toHaveBeenCalledWith("Choose [1]: ");
  });

  it("omits unqualified Pi from the interactive installation choices", async () => {
    writePiBundle();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dependencies = wirePrivateDependencies();
    dependencies.isStdinTty.mockReturnValue(true);

    await HarnessInstallCommand.run([], process.cwd());

    expect(installedIds()).toEqual(["hermes"]);
    expect(log.mock.calls.flat().join("\n")).not.toContain("(pi)");
  });

  it("leaves state unchanged for operator exit and EOF", async () => {
    const dependencies = wirePrivateDependencies();
    dependencies.isStdinTty.mockReturnValue(true);
    dependencies.prompt.mockResolvedValueOnce("exit");
    await HarnessInstallCommand.run([], process.cwd());
    dependencies.prompt.mockRejectedValueOnce(Object.assign(new Error("closed"), { code: "EOF" }));
    await HarnessInstallCommand.run([], process.cwd());

    expect(fs.readdirSync(storeRoot)).toEqual([]);
    expect(dependencies.installPackage).not.toHaveBeenCalled();
  });

  it("requires an exact command instead of prompting without a TTY", async () => {
    const dependencies = wirePrivateDependencies();

    await expect(HarnessInstallCommand.run([], process.cwd())).rejects.toThrow(
      "A harness package ID is required without an interactive terminal",
    );

    expect(dependencies.prompt).not.toHaveBeenCalled();
    expect(dependencies.listInventory).not.toHaveBeenCalled();
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("reports the all-installed state without prompting", async () => {
    const dependencies = wirePrivateDependencies();
    dependencies.isStdinTty.mockReturnValue(true);
    const roots = listHarnessPackageInventory(catalogueOptions()).available;
    roots.forEach((available) =>
      installHarnessPackage(
        { packageRoot: available.packageRoot, sourceIdentity: SOURCE_IDENTITY },
        { storeRoot },
      ),
    );

    await HarnessInstallCommand.run([], process.cwd());

    expect(dependencies.prompt).not.toHaveBeenCalled();
    expect(installedIds()).toEqual(["hermes", "langchain-deepagents-code", "openclaw"]);
  });

  it("keeps an exact reinstall idempotent", async () => {
    const dependencies = wirePrivateDependencies();

    await HarnessInstallCommand.run(["openclaw"], process.cwd());
    await HarnessInstallCommand.run(["openclaw"], process.cwd());

    expect(installedIds()).toEqual(["openclaw"]);
    expect(dependencies.installPackage).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(packageCodeMarker)).toBe(false);
  });
});
