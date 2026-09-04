// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findLayerImportBoundaryViolations,
  findManagedRuntimeBoundaryViolations,
} from "../../scripts/checks/layer-import-boundaries.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
let fixtureCounter = 0;

function fixturePath(dir: string, label: string, extension = ".ts"): string {
  fixtureCounter += 1;
  return path.join(
    REPO_ROOT,
    dir,
    `__boundary-${label}-${process.pid}-${fixtureCounter}${extension}`,
  );
}

function namedActionFixturePath(extension = ".mts"): string {
  fixtureCounter += 1;
  return path.join(
    REPO_ROOT,
    "src/lib",
    `__boundary-${process.pid}-${fixtureCounter}-action${extension}`,
  );
}

function scanFixture(fixture: string, source: string, packagesRoot?: string) {
  try {
    fs.writeFileSync(fixture, source);
    return findLayerImportBoundaryViolations(fixture, packagesRoot);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

describe("CLI layer import boundaries (#6245)", () => {
  it("keeps domain, adapter, action, and command layers separated (#6245)", () => {
    expect(findLayerImportBoundaryViolations()).toEqual([]);
  });

  it("keeps managed runtime orchestration provider-neutral (#9145)", () => {
    expect(findManagedRuntimeBoundaryViolations()).toEqual([]);
  });

  it.each([
    ["a static import", 'import "@nvidia/nemoclaw-pi";\n'],
    ["a re-export", 'export * from "@nvidia/nemoclaw-pi/runtime";\n'],
    ["CommonJS require", 'require("@nvidia/nemoclaw-pi");\n'],
    ["a dynamic import", 'void import("@nvidia/nemoclaw-pi/runtime");\n'],
  ])("blocks %s from an agent runtime package", (_case, source) => {
    expect(scanFixture(fixturePath("src/lib", "agent-runtime-package"), source)).toEqual([
      expect.objectContaining({
        rule: "core-no-agent-runtime-package-imports",
        detail:
          "core source must use the typed agent runtime package contract instead of importing @nvidia/nemoclaw-pi",
      }),
    ]);
  });

  it("blocks a relative import from an agent runtime package", () => {
    const fixture = fixturePath("src/lib", "relative-agent-runtime-package");
    const target = path.join(REPO_ROOT, "packages/nemoclaw-openclaw/compat/npm-remediation.mts");
    const specifier = path.relative(path.dirname(fixture), target).split(path.sep).join("/");

    expect(scanFixture(fixture, `import ${JSON.stringify(specifier)};\n`)).toEqual([
      expect.objectContaining({
        rule: "core-no-agent-runtime-package-imports",
        detail: expect.stringContaining("@nvidia/nemoclaw-openclaw"),
      }),
    ]);
  });

  it("discovers an agent runtime package from package metadata", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-packages-"));
    const packageRoot = path.join(packagesRoot, "custom-runtime");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/custom-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    try {
      expect(
        scanFixture(
          fixturePath("src/lib", "metadata-agent-runtime-package"),
          'import "@example/custom-runtime";\n',
          packagesRoot,
        ),
      ).toEqual([
        expect.objectContaining({
          rule: "core-no-agent-runtime-package-imports",
          detail: expect.stringContaining("@example/custom-runtime"),
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("does not classify shared NeMo Fabric infrastructure as an agent runtime package", () => {
    expect(
      scanFixture(fixturePath("src/lib", "fabric-package"), 'import "nemoclaw-fabric";\n'),
    ).toEqual([]);
  });

  it("collects TypeScript import-equals references (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/domain", "import-equals"),
      'import adapter = require("../adapters/openshell/client");\nexport const value = adapter;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "domain must not import src/lib/adapters/openshell/client.ts",
        }),
      ]),
    );
  });

  it("keeps messaging manifests isolated from side-effect layers (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/messaging/manifest", "fs"),
      'import { readFileSync } from "node:fs";\nexport const value = readFileSync;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "messaging manifest modules must not import node:fs",
        }),
      ]),
    );
  });

  it("blocks bare fs imports in messaging manifests (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/messaging/manifest", "bare-fs"),
      'import { readFile } from "fs/promises";\nexport const value = readFile;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "messaging manifest modules must not import fs",
        }),
      ]),
    );
  });

  it("blocks packaged bin shims outside protected layer directories (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib", "bin-lib-shim"),
      'import "../../bin/lib/ports.js";\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail:
            "src must import implementation modules directly instead of packaged shim bin/lib/ports.js",
        }),
      ]),
    );
  });

  it.each([
    ["CommonJS require", 'export const ports = require("../../bin/lib/ports.js");\n'],
    ["dynamic import", 'export const ports = import("../../bin/lib/ports.js");\n'],
  ])("blocks packaged bin shims loaded through %s (#6245)", (_case, source) => {
    const violations = scanFixture(fixturePath("src/lib", "bin-lib-call"), source);

    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "src-no-bin-lib-shims" })]),
    );
  });

  it("classifies a bin shim imported through a source-tree symlink (#6245)", () => {
    const importer = fixturePath("src/lib", "bin-lib-alias-importer");
    const alias = fixturePath("src/lib", "bin-lib-alias", ".js");
    const relativeAlias = `./${path.basename(alias)}`;
    try {
      fs.symlinkSync(path.join(REPO_ROOT, "bin/lib/ports.js"), alias, "file");
      fs.writeFileSync(importer, `import "${relativeAlias}";\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail:
            "src must import implementation modules directly instead of packaged shim bin/lib/ports.js",
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(alias, { force: true });
    }
  });

  it("counts only classes that extend Command as oclif command classes (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/commands", "implements"),
      'import { Command } from "@oclif/core";\nclass NotACommand implements Command {}\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "command files must define exactly one registered oclif command class; found 0",
        }),
      ]),
    );
  });

  it.each([
    {
      name: "a direct oclif import",
      source:
        'import { Command } from "@oclif/core";\nexport default class Example extends Command {}\n',
    },
    {
      name: "an aliased oclif import",
      source:
        'import { Command as OclifCommand } from "@oclif/core";\nexport default class Example extends OclifCommand {}\n',
    },
    {
      name: "a namespace-qualified oclif import",
      source:
        'import * as oclif from "@oclif/core";\nexport default class Example extends oclif.Command {}\n',
    },
    {
      name: "the NemoClaw command base",
      source:
        'import { NemoClawCommand as Base } from "../lib/cli/nemoclaw-oclif-command";\nexport default class Example extends Base {}\n',
    },
  ])("recognizes $name by its import binding (#6245)", ({ source }) => {
    const violations = scanFixture(fixturePath("src/commands", "command-binding"), source);

    expect(violations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "one-command-per-file" })]),
    );
  });

  it.each(["Command", "NemoClawCommand"])(
    "rejects an unrelated local %s class as a command base (#6245)",
    (baseName) => {
      const violations = scanFixture(
        fixturePath("src/commands", "local-command-base"),
        `class ${baseName} {}\nexport default class Example extends ${baseName} {}\n`,
      );

      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: "command files must define exactly one registered oclif command class; found 0",
          }),
        ]),
      );
    },
  );

  it.each([".mts", ".cts", ".tsx"])(
    "scans production %s modules for protected-layer violations (#6245)",
    (extension) => {
      const violations = scanFixture(
        fixturePath("src/lib/actions", "module-extension", extension),
        'import { Command } from "@oclif/core";\n',
      );

      expect(violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: "actions-no-oclif" })]),
      );
    },
  );

  it("recognizes alternate-extension action modules outside the actions directory (#6245)", () => {
    const violations = scanFixture(
      namedActionFixturePath(),
      'import { Command } from "@oclif/core";\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "actions-no-oclif" })]),
    );
  });

  it("resolves extensionless imports to alternate TypeScript modules (#6245)", () => {
    const target = fixturePath("src/lib/actions", "extensionless-target", ".mts");
    const importer = fixturePath("src/lib/domain", "extensionless-importer", ".mts");
    const specifier = path
      .relative(path.dirname(importer), target)
      .split(path.sep)
      .join("/")
      .replace(/\.mts$/, "");
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it.each([
    { emittedExtension: ".js", sourceExtension: ".ts" },
    { emittedExtension: ".mjs", sourceExtension: ".mts" },
    { emittedExtension: ".cjs", sourceExtension: ".cts" },
  ])(
    "resolves $emittedExtension output specifiers to $sourceExtension source modules (#6245)",
    ({ emittedExtension, sourceExtension }) => {
      const target = fixturePath(
        "src/lib/adapters",
        `emitted-specifier-target-${sourceExtension.slice(1)}`,
        sourceExtension,
      );
      const importer = fixturePath(
        "src/lib/domain",
        `emitted-specifier-importer-${sourceExtension.slice(1)}`,
      );
      const specifier = path.relative(path.dirname(importer), target).split(path.sep).join("/");
      const emittedSpecifier = specifier.slice(0, -sourceExtension.length) + emittedExtension;
      try {
        fs.writeFileSync(target, "export const value = true;\n");
        fs.writeFileSync(
          importer,
          `import { value } from "${emittedSpecifier}";\nexport { value };\n`,
        );

        expect(findLayerImportBoundaryViolations(importer)).toEqual([
          expect.objectContaining({
            detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
          }),
        ]);
      } finally {
        fs.rmSync(importer, { force: true });
        fs.rmSync(target, { force: true });
      }
    },
  );

  it("resolves an extensionless directory import to its index module (#6245)", () => {
    const targetDir = fs.mkdtempSync(
      path.join(REPO_ROOT, "src/lib/actions/__boundary-extensionless-directory-"),
    );
    const target = path.join(targetDir, "index.mts");
    const importer = fixturePath("src/lib/domain", "extensionless-directory-importer", ".mts");
    const specifier = path.relative(path.dirname(importer), targetDir).split(path.sep).join("/");
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it.each([".test.mts", ".spec.cts", ".test.tsx"])(
    "excludes %s test modules from the production scan (#6245)",
    (extension) => {
      expect(
        scanFixture(
          fixturePath("src/lib/actions", "test-module-extension", extension),
          'import { Command } from "@oclif/core";\n',
        ),
      ).toEqual([]);
    },
  );

  it("does not recurse through a symbolic-link loop (#6245)", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(REPO_ROOT, "src/lib/domain/__boundary-symlink-loop-"),
    );
    try {
      fs.writeFileSync(
        path.join(fixtureRoot, "violation.mts"),
        'import { spawn } from "node:child_process";\nexport { spawn };\n',
      );
      fs.symlinkSync(".", path.join(fixtureRoot, "loop"), "dir");

      expect(findLayerImportBoundaryViolations(fixtureRoot)).toEqual([
        expect.objectContaining({ rule: "domain-purity" }),
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("classifies a symbolic-link import by its canonical protected-layer target (#6245)", () => {
    const target = fixturePath("src/lib/actions", "symlink-target", ".mts");
    const importer = fixturePath("src/lib/domain", "symlink-importer", ".mts");
    const alias = fixturePath("src/lib/domain", "symlink-alias", ".mts");
    const relativeAlias = path
      .relative(path.dirname(importer), alias)
      .split(path.sep)
      .join("/")
      .replace(/\.mts$/, "");
    const specifier = relativeAlias.startsWith(".") ? relativeAlias : `./${relativeAlias}`;
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.symlinkSync(target, alias, "file");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(alias, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});
