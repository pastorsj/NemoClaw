// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CheckoutCommand,
  type CheckoutCommandResult,
  prepareCheckoutRootRemoval,
  readPackageCheckoutCliOptions,
  readInstalledHarnessDigest,
  runPackageCheckoutRehearsal,
} from "../../scripts/packages/checkout.mts";
import { verifyInstalledHarnessContract } from "../../scripts/packages/verify-contract.mts";
import {
  ensureHarnessPackageStore,
  harnessPackageStorePaths,
} from "../../src/lib/agent-runtime/package/store-files";

function createCheckoutCandidate(
  parent: string,
  fabricTestScript?: string,
  buildProjects?: readonly string[],
): string {
  const candidateRoot = path.join(parent, "candidate");
  fs.mkdirSync(candidateRoot);
  fs.writeFileSync(
    path.join(candidateRoot, "package.json"),
    `${JSON.stringify({
      name: "@nvidia/nemoclaw-example",
      nemoclaw: {
        harnessManifest: "manifest.yaml",
        ...(buildProjects ? { buildProjects } : {}),
      },
      ...(fabricTestScript ? { scripts: { "test:fabric": fabricTestScript } } : {}),
    })}\n`,
  );
  fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
  return candidateRoot;
}

function createBuildProject(candidateRoot: string, projectPath: string): string {
  const projectRoot = path.join(candidateRoot, ...projectPath.split("/"));
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package-lock.json"), "{}\n");
  return projectRoot;
}

function createCheckoutToolDirectory(parent: string, includeUv: boolean): string {
  const toolDirectory = path.join(parent, "host-tools");
  fs.mkdirSync(toolDirectory);
  for (const toolName of ["npm", "git", "tar", ...(includeUv ? ["uv"] : [])]) {
    const toolPath = path.join(toolDirectory, toolName);
    fs.writeFileSync(toolPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.chmodSync(toolPath, 0o755);
  }
  return toolDirectory;
}

function createInstalledHarnessContract(packageRoot: string): string {
  const contractRoot = path.join(
    packageRoot,
    "node_modules",
    "@nvidia",
    "nemoclaw-harness-contract",
  );
  fs.mkdirSync(path.join(contractRoot, "dist"), { recursive: true });
  const bin = {
    "nemoclaw-build-adapters": "./dist/build-adapters.mjs",
    "nemoclaw-build-package": "./dist/build-package.mjs",
    "nemoclaw-materialize-runtime": "./dist/materialize-runtime.mjs",
    "nemoclaw-validate-package": "./dist/validate-package.mjs",
  };
  fs.writeFileSync(
    path.join(contractRoot, "package.json"),
    `${JSON.stringify({ name: "@nvidia/nemoclaw-harness-contract", bin })}\n`,
  );
  for (const target of Object.values(bin)) {
    fs.writeFileSync(path.join(contractRoot, target), "export {};\n", { mode: 0o755 });
  }
  return contractRoot;
}

describe("installed harness contract verification", () => {
  it("accepts a self-contained package with every authoring binary", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-install-"));
    try {
      createInstalledHarnessContract(packageRoot);
      expect(() => verifyInstalledHarnessContract(packageRoot)).not.toThrow();
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a monorepo link that would break after extraction",
    () => {
      const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-link-"));
      const externalContract = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-source-"));
      try {
        const contractRoot = createInstalledHarnessContract(packageRoot);
        fs.rmSync(contractRoot, { recursive: true, force: true });
        fs.symlinkSync(externalContract, contractRoot, "dir");
        expect(() => verifyInstalledHarnessContract(packageRoot)).toThrow(
          /regular installed directory/u,
        );
      } finally {
        fs.rmSync(packageRoot, { recursive: true, force: true });
        fs.rmSync(externalContract, { recursive: true, force: true });
      }
    },
  );

  it("rejects an installed contract missing a required binary", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-bin-"));
    try {
      const contractRoot = createInstalledHarnessContract(packageRoot);
      fs.rmSync(path.join(contractRoot, "dist", "validate-package.mjs"));
      expect(() => verifyInstalledHarnessContract(packageRoot)).toThrow(
        /nemoclaw-validate-package.*missing/u,
      );
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("package checkout code execution acknowledgement", () => {
  it("refuses before command execution unless the caller acknowledges trusted package code", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-refusal-"));
    const candidateRoot = createCheckoutCandidate(parent);
    const commandPurposes: string[] = [];

    try {
      expect(() =>
        runPackageCheckoutRehearsal(
          {
            mode: "package-only",
            packageId: "example",
            candidatePackageDir: candidateRoot,
            temporaryParentDir: parent,
          },
          {
            runCommand: (command) => {
              commandPurposes.push(command.purpose);
              return { stdout: "" };
            },
          },
        ),
      ).toThrow(/executes trusted candidate package code .* not an untrusted-package sandbox/u);
      expect(commandPurposes).toEqual([]);
      expect(fs.readdirSync(parent).filter((entry) => entry.startsWith("nc-"))).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("maps only the explicit CLI flag to the API acknowledgement", () => {
    const baseArguments = ["package-only", "--package", "example", "--candidate", "."];

    expect(readPackageCheckoutCliOptions(baseArguments).allowPackageCode).toBe(false);
    expect(
      readPackageCheckoutCliOptions([...baseArguments, "--allow-package-code"]).allowPackageCode,
    ).toBe(true);
  });
});

describe("package checkout cleanup", () => {
  it("uses a canonical private home when the temporary parent has a symlinked ancestor", () => {
    const parent = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-package-checkout-parent-"),
    );
    const candidateRoot = path.join(parent, "candidate");
    const actualParent = path.join(parent, "actual", "temporary");
    const linkedAncestor = path.join(parent, "linked");
    const selectedParent = path.join(linkedAncestor, "temporary");
    fs.mkdirSync(candidateRoot);
    fs.mkdirSync(actualParent, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(parent, "actual"),
      linkedAncestor,
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const observedHomes: string[] = [];

    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: selectedParent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            const commandHome = command.env.HOME ?? "";
            expect(commandHome).not.toBe("");
            expect(path.resolve(commandHome)).toBe(fs.realpathSync.native(commandHome));
            observedHomes.push(commandHome);
            ensureHarnessPackageStore(
              harnessPackageStorePaths(path.join(commandHome, ".nemoclaw", "harnesses"), "example"),
            );
            return { stdout: "" };
          },
        },
      );

      expect(observedHomes).toHaveLength(2);
      expect(
        observedHomes.every((home) =>
          home.startsWith(`${fs.realpathSync.native(selectedParent)}${path.sep}`),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("removes generated read-only artifacts after a package-only rehearsal", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-cleanup-"));
    const candidateRoot = path.join(parent, "candidate");
    fs.mkdirSync(candidateRoot);
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const commandPurposes: string[] = [];
    const createGeneratedArtifactsByPurpose: Record<string, (workingDirectory: string) => void> = {
      "install candidate package dependencies": (workingDirectory) => {
        const rehearsalRoot = path.resolve(workingDirectory, "..", "..", "..");
        const artifactRoot = path.join(
          rehearsalRoot,
          "nemoclaw",
          "dist",
          "harnesses",
          "nemoclaw-example",
          "runtime",
        );
        fs.mkdirSync(artifactRoot, { recursive: true });
        fs.writeFileSync(path.join(artifactRoot, "start.sh"), "#!/bin/sh\n", {
          mode: 0o444,
        });
        fs.chmodSync(artifactRoot, 0o555);
        fs.chmodSync(path.dirname(artifactRoot), 0o555);
      },
    };

    try {
      const result = runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            createGeneratedArtifactsByPurpose[command.purpose]?.(command.cwd);
            return { stdout: "" };
          },
        },
      );

      expect(result).toEqual({ mode: "package-only", packageId: "example" });
      expect(commandPurposes).toEqual([
        "install candidate package dependencies",
        "run candidate package-only tests",
      ]);
      expect(fs.readdirSync(parent).filter((entry) => entry.startsWith("nc-"))).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("installs a packed public harness contract without exposing NemoClaw source", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-checkout-"));
    const candidateRoot = path.join(parent, "independent-package");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
        devDependencies: { "@nvidia/nemoclaw-harness-contract": "^0.1.0" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const commandPurposes: string[] = [];
    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            const packsContract = command.purpose === "pack public harness contract";
            packsContract &&
              expect(command.cwd).toBe(path.resolve(import.meta.dirname, "../../harness-contract"));
            packsContract &&
              expect(command.args).toEqual([
                "pack",
                "--json",
                "--pack-destination",
                expect.any(String),
              ]);
            const workspaceRoot = path.resolve(command.cwd, "..", "..");
            packsContract ||
              expect(command.cwd).toBe(path.join(workspaceRoot, "packages", "nemoclaw-example"));
            packsContract ||
              expect(fs.existsSync(path.join(workspaceRoot, "harness-contract"))).toBe(false);
            packsContract ||
              expect(fs.existsSync(path.join(workspaceRoot, "src", "lib"))).toBe(false);
            command.purpose === "install candidate package dependencies" &&
              expect(command.args).toEqual([
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--no-save",
                expect.stringMatching(/\.tgz$/u),
              ]);
            command.purpose === "verify installed harness contract" &&
              expect(command.executable).toBe("node");
            command.purpose === "verify installed harness contract" &&
              expect(command.args).toEqual([
                "--experimental-strip-types",
                "--no-warnings",
                expect.stringMatching(/verify-contract\.mts$/u),
                command.cwd,
              ]);
            return {
              stdout: packsContract
                ? '[{"filename":"nvidia-nemoclaw-harness-contract-0.1.0.tgz"}]'
                : "",
            };
          },
        },
      );
      expect(commandPurposes).toEqual([
        "pack public harness contract",
        "install candidate package dependencies",
        "verify installed harness contract",
        "run candidate package-only tests",
      ]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("accepts a later published contract range without teaching core its release", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-range-"));
    const candidateRoot = path.join(parent, "independent-package");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
        devDependencies: { "@nvidia/nemoclaw-harness-contract": "^9.8.7" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    try {
      expect(() =>
        runPackageCheckoutRehearsal(
          {
            mode: "package-only",
            packageId: "example",
            candidatePackageDir: candidateRoot,
            allowPackageCode: true,
            temporaryParentDir: parent,
            parentEnvironment: { PATH: process.env.PATH },
          },
          {
            runCommand: (command) => ({
              stdout:
                command.purpose === "pack public harness contract"
                  ? '[{"filename":"nvidia-nemoclaw-harness-contract-0.1.0.tgz"}]'
                  : "",
            }),
          },
        ),
      ).not.toThrow();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a local-path contract dependency in an external package rehearsal", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-local-path-"));
    const candidateRoot = path.join(parent, "independent-package");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
        devDependencies: { "@nvidia/nemoclaw-harness-contract": "file:../contract" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    try {
      expect(() =>
        runPackageCheckoutRehearsal({
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        }),
      ).toThrow(/published .* caret range/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not follow a redirected generated artifact path", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-symlink-"));
    const rehearsalRoot = path.join(parent, "checkout");
    const distRoot = path.join(rehearsalRoot, "nemoclaw", "dist");
    const outsideRoot = path.join(parent, "outside");
    fs.mkdirSync(distRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    const outsideFile = path.join(outsideRoot, "keep.txt");
    fs.writeFileSync(outsideFile, "keep\n", { mode: 0o444 });
    fs.chmodSync(outsideRoot, 0o555);
    fs.symlinkSync(outsideRoot, path.join(distRoot, "harnesses"));

    try {
      prepareCheckoutRootRemoval(rehearsalRoot);

      expect(fs.statSync(outsideRoot).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep\n");
      fs.rmSync(rehearsalRoot, { recursive: true, force: true });
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep\n");
    } finally {
      fs.chmodSync(outsideRoot, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("package checkout build projects", () => {
  it("installs every package-declared nested project without using the harness identity", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-project-"));
    const candidateRoot = createCheckoutCandidate(parent, undefined, ["ui-extension"]);
    const projectRoot = createBuildProject(candidateRoot, "ui-extension");
    const commands: CheckoutCommand[] = [];

    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commands.push(command);
            return { stdout: "" };
          },
        },
      );

      const nestedInstall = commands.find(
        ({ purpose }) => purpose === "install candidate build project dependencies: ui-extension",
      );
      expect(nestedInstall?.args).toEqual(["ci", "--ignore-scripts"]);
      expect(path.relative(candidateRoot, projectRoot)).toBe("ui-extension");
      expect(path.basename(nestedInstall?.cwd ?? "")).toBe("ui-extension");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an empty build-project declaration", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-empty-projects-"));
    const candidateRoot = createCheckoutCandidate(parent, undefined, []);
    try {
      expect(() =>
        runPackageCheckoutRehearsal({
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        }),
      ).toThrow(/must contain between 1 and 8 paths/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(["tests/plugin", "cache/plugin", "node_modules/plugin"])(
    "rejects a build project beneath forbidden directory %s",
    (projectPath) => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forbidden-project-"));
      const candidateRoot = createCheckoutCandidate(parent, undefined, [projectPath]);
      createBuildProject(candidateRoot, projectPath);
      try {
        expect(() =>
          runPackageCheckoutRehearsal({
            mode: "package-only",
            packageId: "example",
            candidatePackageDir: candidateRoot,
            allowPackageCode: true,
            temporaryParentDir: parent,
            parentEnvironment: { PATH: process.env.PATH },
          }),
        ).toThrow(/must not identify a test, cache, or dependency directory/u);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.each([[["../outside"]], [["nested\\outside"]]])(
    "rejects an unsafe project declaration: %j",
    (buildProjects) => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-project-"));
      const candidateRoot = createCheckoutCandidate(parent, undefined, buildProjects);
      try {
        expect(() =>
          runPackageCheckoutRehearsal({
            mode: "package-only",
            packageId: "example",
            candidatePackageDir: candidateRoot,
            allowPackageCode: true,
            temporaryParentDir: parent,
            parentEnvironment: { PATH: process.env.PATH },
          }),
        ).toThrow(/build project/u);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it("rejects duplicate project declarations", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-duplicate-project-"));
    const candidateRoot = createCheckoutCandidate(parent, undefined, ["plugin", "plugin"]);
    createBuildProject(candidateRoot, "plugin");
    try {
      expect(() =>
        runPackageCheckoutRehearsal({
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        }),
      ).toThrow("Candidate package build projects must be unique");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects the superseded authoringProjects metadata name", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-project-metadata-"));
    const candidateRoot = createCheckoutCandidate(parent);
    createBuildProject(candidateRoot, "plugin");
    const packageJsonPath = path.join(candidateRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    (packageJson.nemoclaw as Record<string, unknown>).authoringProjects = ["plugin"];
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`);
    try {
      expect(() =>
        runPackageCheckoutRehearsal({
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        }),
      ).toThrow(/renamed to nemoclaw\.buildProjects/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("package checkout Fabric tools", () => {
  it.skipIf(process.platform === "win32")(
    "runs the DCode adapter lane without a sibling NemoClaw Fabric runner",
    () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-package-only-"));
      const packageRoot = path.join(parent, "package");
      const fabricRoot = path.join(packageRoot, "fabric");
      const testRoot = path.join(packageRoot, "tests", "fabric");
      const toolRoot = path.join(parent, "tools");
      const argumentsPath = path.join(parent, "uv-arguments");
      fs.mkdirSync(fabricRoot, { recursive: true });
      fs.mkdirSync(testRoot, { recursive: true });
      fs.mkdirSync(toolRoot);
      fs.writeFileSync(path.join(fabricRoot, "requirements.lock"), "");
      fs.copyFileSync(
        path.resolve(
          import.meta.dirname,
          "../../packages/nemoclaw-langchain-deepagents-code/tests/fabric/run-tests.sh",
        ),
        path.join(testRoot, "run-tests.sh"),
      );
      const fakeUv = path.join(toolRoot, "uv");
      fs.writeFileSync(
        fakeUv,
        '#!/bin/sh\n: "${UV_ARGUMENTS_FILE:?}"\nprintf \'%s\\n\' "$@" > "$UV_ARGUMENTS_FILE"\n',
        { mode: 0o755 },
      );
      fs.chmodSync(fakeUv, 0o755);

      try {
        expect(fs.existsSync(path.join(parent, "nemoclaw-fabric"))).toBe(false);
        const result = spawnSync("bash", [path.join(testRoot, "run-tests.sh")], {
          cwd: packageRoot,
          env: {
            PATH: `${toolRoot}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
            TMPDIR: parent,
            UV_ARGUMENTS_FILE: argumentsPath,
          },
          encoding: "utf8",
        });

        expect(result.status, result.stderr).toBe(0);
        const argumentsList = fs.readFileSync(argumentsPath, "utf8").trim().split("\n");
        expect(argumentsList).toContain("fabric/requirements.lock");
        expect(argumentsList).toContain("tests.fabric.test_turn.ReleasedDeepAgentsAdapterTests");
        expect(argumentsList.some((argument) => argument.includes("nemoclaw-fabric"))).toBe(false);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it("links uv when the candidate Fabric test invokes it", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-uv-"));
    const candidateRoot = createCheckoutCandidate(parent, "uv --version");
    const hostTools = createCheckoutToolDirectory(parent, true);
    const hostUv = fs.realpathSync(path.join(hostTools, "uv"));
    const commandPurposes: string[] = [];
    let linkedUv = "";

    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: hostTools },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            const privateTools = command.env.PATH?.split(path.delimiter)[0] ?? "";
            linkedUv = fs.realpathSync(path.join(privateTools, "uv"));
            return { stdout: "" };
          },
        },
      );

      expect(linkedUv).toBe(hostUv);
      expect(commandPurposes).toEqual([
        "install candidate package dependencies",
        "run candidate package-only tests",
        "run candidate Fabric tests",
      ]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("lets a declared Fabric test choose tools other than uv", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-no-uv-"));
    const candidateRoot = createCheckoutCandidate(parent, "python3 -m unittest");
    const hostTools = createCheckoutToolDirectory(parent, false);

    try {
      const commandPurposes: string[] = [];
      let linkedUv = true;
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: hostTools },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            const privateTools = command.env.PATH?.split(path.delimiter)[0] ?? "";
            linkedUv = fs.existsSync(path.join(privateTools, "uv"));
            return { stdout: "" };
          },
        },
      );

      expect(linkedUv).toBe(false);
      expect(commandPurposes).toEqual([
        "install candidate package dependencies",
        "run candidate package-only tests",
        "run candidate Fabric tests",
      ]);
      expect(fs.readdirSync(parent).filter((entry) => entry.startsWith("nc-"))).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not link or require uv when the candidate has no Fabric tests", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-no-fabric-"));
    const candidateRoot = createCheckoutCandidate(parent);
    const hostTools = createCheckoutToolDirectory(parent, true);
    const commandPurposes: string[] = [];
    let linkedUv = true;

    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: hostTools },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            const privateTools = command.env.PATH?.split(path.delimiter)[0] ?? "";
            linkedUv = fs.existsSync(path.join(privateTools, "uv"));
            return { stdout: "" };
          },
        },
      );

      expect(linkedUv).toBe(false);
      expect(commandPurposes).toEqual([
        "install candidate package dependencies",
        "run candidate package-only tests",
      ]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("package checkout installed digest", () => {
  const digest = "a".repeat(64);
  const installedRow = {
    id: "example",
    displayName: "Example",
    health: "healthy",
    identity: {
      kind: "agent-runtime",
      id: "example",
      packageVersion: "0.1.0",
      contentDigest: digest,
    },
  };

  it("reads the receipt-verified digest from public harness inventory", () => {
    expect(
      readInstalledHarnessDigest(
        JSON.stringify({ schemaVersion: 1, installed: [installedRow], available: [] }),
        "example",
      ),
    ).toBe(digest);
  });

  it.each([
    ["a damaged row", { ...installedRow, health: "damaged", identity: null }],
    [
      "a malformed digest",
      { ...installedRow, identity: { ...installedRow.identity, contentDigest: "not-a-digest" } },
    ],
  ])("rejects %s", (_label, row) => {
    expect(() =>
      readInstalledHarnessDigest(
        JSON.stringify({ schemaVersion: 1, installed: [row], available: [] }),
        "example",
      ),
    ).toThrow("Candidate package inventory is invalid");
  });

  it("uses public inventory JSON to finish a composed rehearsal", () => {
    const parent = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-package-checkout-composed-"),
    );
    const candidateRoot = path.join(parent, "candidate");
    const coreCheckout = path.join(parent, "core");
    const coreCommit = "b".repeat(40);
    fs.mkdirSync(candidateRoot);
    fs.mkdirSync(coreCheckout);
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
        scripts: {
          "build:package": "nemoclaw-build-package --create-output-parent . ../dist/example",
          "test:nemoclaw": "vitest run --config vitest.nemoclaw.ts",
        },
        devDependencies: { "@nvidia/nemoclaw-harness-contract": "^0.1.0" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const commandPurposes: string[] = [];
    const commands: CheckoutCommand[] = [];
    const commandHandlers: Record<string, (command: CheckoutCommand) => CheckoutCommandResult> = {
      "read exact NemoClaw revision": () => ({ stdout: `${coreCommit}\n` }),
      "extract exact NemoClaw revision": (command) => {
        const coreRoot = command.args.at(-1) ?? "";
        expect(coreRoot).not.toBe("");
        fs.writeFileSync(path.join(coreRoot, "package-lock.json"), "{}\n");
        fs.mkdirSync(path.join(coreRoot, "harness-contract"));
        return { stdout: "" };
      },
      "pack public harness contract": (command) => {
        expect(command.cwd).toMatch(/nemoclaw\/harness-contract$/u);
        return { stdout: '[{"filename":"nvidia-nemoclaw-harness-contract-0.1.0.tgz"}]' };
      },
      "build candidate package artifact": (command) => {
        const artifact = path.join(command.cwd, "..", "dist", "example");
        fs.mkdirSync(artifact, { recursive: true });
        fs.writeFileSync(path.join(artifact, "nemoclaw-package.json"), "{}\n");
        fs.chmodSync(path.join(artifact, "nemoclaw-package.json"), 0o444);
        fs.chmodSync(artifact, 0o555);
        return { stdout: "" };
      },
      "list installed harnesses": () => ({
        stdout: "Installed\n  example | Example\n\nAvailable\n",
      }),
      "read installed harness digest": () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          installed: [installedRow],
          available: [],
        }),
      }),
    };

    try {
      const result = runPackageCheckoutRehearsal(
        {
          mode: "composed",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          allowPackageCode: true,
          coreCheckoutDir: coreCheckout,
          coreCommit,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            commands.push(command);
            return commandHandlers[command.purpose]?.(command) ?? { stdout: "" };
          },
        },
      );

      expect(result).toEqual({
        mode: "composed",
        packageId: "example",
        coreCommit,
        installedDigest: digest,
      });
      expect(commandPurposes.slice(-3)).toEqual([
        "install candidate harness",
        "list installed harnesses",
        "read installed harness digest",
      ]);
      expect(commandPurposes).toContain("run candidate NemoClaw integration tests");
      const buildCommand = commands.find(
        ({ purpose }) => purpose === "build candidate package artifact",
      );
      expect(buildCommand).toMatchObject({
        args: ["run", "build:package"],
      });
      expect(buildCommand, "Expected the candidate package build command").toBeDefined();
      expect(path.basename(buildCommand!.cwd)).toBe("candidate-package");
      const expectedPackageArtifact = path.join(path.dirname(buildCommand!.cwd), "dist", "example");
      const integrationTestCommand = commands.find(
        ({ purpose }) => purpose === "run candidate NemoClaw integration tests",
      );
      expect(
        integrationTestCommand,
        "Expected the candidate integration test command",
      ).toBeDefined();
      expect(path.basename(integrationTestCommand!.cwd)).toBe("nemoclaw-example");
      expect(path.basename(path.dirname(integrationTestCommand!.cwd))).toBe("packages");
      const installCommand = commands.find(
        ({ purpose }) => purpose === "install candidate harness",
      );
      expect(installCommand, "Expected the candidate harness install command").toBeDefined();
      const cliPath = installCommand!.args[0];
      expect(cliPath.endsWith(path.join("bin", "nemoclaw.js"))).toBe(true);
      expect(installCommand!.args).toEqual([
        cliPath,
        "harness",
        "install",
        "example",
        "--from",
        expectedPackageArtifact,
        "--yes-i-trust-local-package",
      ]);
      expect(installCommand!.args.join(" ")).not.toContain(
        `${path.sep}packages${path.sep}nemoclaw-example`,
      );
      expect(fs.readdirSync(parent).filter((entry) => entry.startsWith("nc-"))).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
