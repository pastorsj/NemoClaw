// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHarnessAdapterArtifacts } from "./build-adapters.mts";
import { HarnessPackageConformanceError, validateHarnessPackage } from "./validate-package.mts";

const CONTRACT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.dirname(CONTRACT_ROOT);
const REQUIRED_RUNTIME_FILES = [
  "Dockerfile.base",
  "Dockerfile",
  "manifest.yaml",
  "policy-additions.yaml",
  "start.sh",
] as const;

interface FixtureOptions {
  readonly files?: readonly string[];
  readonly manifest?: string;
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly version?: string;
  readonly minimumNemoClawVersion?: string;
}

function writeFile(root: string, relativePath: string, contents: string, mode = 0o644): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, { mode });
}

function createPackageFixture(options: FixtureOptions = {}): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-conformance-"));
  const packageRoot = path.join(fixtureRoot, "nemoclaw-future-terminal");
  fs.mkdirSync(packageRoot);
  const packageJson = {
    name: options.name ?? "@example/nemoclaw-future-terminal",
    version: options.version ?? "3.2.1-beta.2+build.7",
    scripts: options.scripts ?? {},
    files: options.files ?? [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts"],
    nemoclaw: {
      harnessManifest: "manifest.yaml",
      minimumNemoClawVersion: options.minimumNemoClawVersion ?? "0.0.113",
    },
  };
  writeFile(packageRoot, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
  writeFile(packageRoot, "Dockerfile", "FROM scratch\n");
  writeFile(
    packageRoot,
    "manifest.yaml",
    options.manifest ??
      [
        "name: future-terminal",
        'display_name: "Future Terminal"',
        "runtime:",
        "  kind: terminal",
        "  prompt_transport: stdin",
        "mcp:",
        "  support: disabled",
        "messaging:",
        "  support: disabled",
        "",
      ].join("\n"),
  );
  writeFile(packageRoot, "policy-additions.yaml", "network_policies: []\n");
  writeFile(packageRoot, "start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
  writeFile(
    packageRoot,
    "host/config-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  writeFile(
    packageRoot,
    "host/messaging-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  return packageRoot;
}

function removeFixture(packageRoot: string): void {
  fs.rmSync(path.dirname(packageRoot), { recursive: true, force: true });
}

function expectDiagnostic(
  packageRoot: string,
  code: string,
  relativePath: string,
): HarnessPackageConformanceError {
  let caught: unknown;
  try {
    validateHarnessPackage(packageRoot);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessPackageConformanceError);
  assert.equal(caught.diagnostics[0]?.code, code);
  assert.equal(caught.diagnostics[0]?.path, relativePath);
  assert.doesNotMatch(caught.message, new RegExp(packageRoot.replaceAll("/", "\\/"), "u"));
  return caught;
}

function updatePackageJson(
  packageRoot: string,
  update: (value: Record<string, unknown>) => void,
): void {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  update(value);
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(value, null, 2)}\n`);
}

function addTypedAdapterSource(packageRoot: string): void {
  const typescriptTarget = path.join(REPOSITORY_ROOT, "node_modules", "typescript");
  const typescriptLink = path.join(packageRoot, "node_modules", "typescript");
  fs.mkdirSync(path.dirname(typescriptLink), { recursive: true });
  fs.symlinkSync(typescriptTarget, typescriptLink, "dir");
  writeFile(
    packageRoot,
    "host/source/config-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      "const adapter = Object.freeze({});",
      "export = adapter;",
      "",
    ].join("\n"),
  );
  buildHarnessAdapterArtifacts(packageRoot);
}

test("accepts a synthetic harness package and reports its published runtime files", () => {
  const packageRoot = createPackageFixture({
    scripts: { prepack: "node prepack.mjs" },
  });
  try {
    writeFile(
      packageRoot,
      "prepack.mjs",
      'import fs from "node:fs"; fs.writeFileSync("ran", "yes");\n',
    );
    const report = validateHarnessPackage(packageRoot);
    assert.equal(report.harnessId, "future-terminal");
    assert.equal(report.packageName, "@example/nemoclaw-future-terminal");
    assert.equal(report.packageVersion, "3.2.1-beta.2+build.7");
    assert.equal(report.minimumNemoClawVersion, "0.0.113");
    assert.deepEqual(report.adapterArtifacts, [
      "host/config-adapter.cts",
      "host/messaging-adapter.cts",
    ]);
    assert.ok(report.packedFiles.includes("manifest.yaml"));
    assert.ok(report.packedFiles.includes("host/config-adapter.cts"));
    assert.ok(report.packedFiles.includes("host/messaging-adapter.cts"));
    assert.equal(fs.existsSync(path.join(packageRoot, "ran")), false);
  } finally {
    removeFixture(packageRoot);
  }
});

test("the package validator binary emits one JSON conformance report", () => {
  const packageRoot = createPackageFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(CONTRACT_ROOT, "validate-package.mts"), "--json", packageRoot],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { harnessId?: unknown; packedFiles?: unknown };
    assert.equal(report.harnessId, "future-terminal");
    assert.ok(Array.isArray(report.packedFiles));
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects package identity and manifest identity mismatches before packing", async (t) => {
  const cases = [
    {
      name: "a package name without the nemoclaw prefix",
      options: { name: "@example/future-terminal" },
      code: "metadata",
      relativePath: "package.json",
    },
    {
      name: "a package version with a leading zero",
      options: { version: "03.2.1" },
      code: "metadata",
      relativePath: "package.json",
    },
    {
      name: "a manifest name that differs from the package name",
      options: { manifest: "name: another-harness\n" },
      code: "manifest-identity",
      relativePath: "manifest.yaml",
    },
  ] as const;
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const packageRoot = createPackageFixture(fixture.options);
      try {
        expectDiagnostic(packageRoot, fixture.code, fixture.relativePath);
      } finally {
        removeFixture(packageRoot);
      }
    });
  }
});

test("requires one exact minimum compatible NemoClaw version", async (t) => {
  for (const minimumNemoClawVersion of ["0.0", "v0.0.113", "00.0.113", "0.0.113-beta"]) {
    await t.test(`rejects ${minimumNemoClawVersion}`, () => {
      const packageRoot = createPackageFixture({ minimumNemoClawVersion });
      try {
        expectDiagnostic(packageRoot, "metadata", "package.json");
      } finally {
        removeFixture(packageRoot);
      }
    });
  }

  await t.test("rejects a missing declaration", () => {
    const packageRoot = createPackageFixture();
    try {
      updatePackageJson(packageRoot, (value) => {
        const nemoclaw = value.nemoclaw as Record<string, unknown>;
        delete nemoclaw.minimumNemoClawVersion;
      });
      expectDiagnostic(packageRoot, "metadata", "package.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects aliases and deeply nested values in the bounded manifest", async (t) => {
  await t.test("a YAML alias", () => {
    const packageRoot = createPackageFixture({
      manifest: "name: future-terminal\nvalue: &shared [one]\ncopy: *shared\n",
    });
    try {
      expectDiagnostic(packageRoot, "manifest", "manifest.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a value beyond the manifest depth limit", () => {
    const nested = Array.from(
      { length: 18 },
      (_value, index) => `${"  ".repeat(index)}level${String(index)}:`,
    );
    const packageRoot = createPackageFixture({
      manifest: ["name: future-terminal", ...nested, `${"  ".repeat(18)}value: true`, ""].join(
        "\n",
      ),
    });
    try {
      expectDiagnostic(packageRoot, "manifest", "manifest.yaml");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects missing, linked, and non-executable runtime files", async (t) => {
  await t.test("a missing Dockerfile", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.rmSync(path.join(packageRoot, "Dockerfile"));
      expectDiagnostic(packageRoot, "file-type", "Dockerfile");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a linked Dockerfile", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.rmSync(path.join(packageRoot, "Dockerfile"));
      fs.symlinkSync("Dockerfile.base", path.join(packageRoot, "Dockerfile"));
      expectDiagnostic(packageRoot, "file-type", "Dockerfile");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a start script without an executable bit", () => {
    const packageRoot = createPackageFixture();
    try {
      fs.chmodSync(path.join(packageRoot, "start.sh"), 0o644);
      expectDiagnostic(packageRoot, "start-mode", "start.sh");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects stale typed adapter artifacts before inspecting the archive", () => {
  const packageRoot = createPackageFixture();
  try {
    addTypedAdapterSource(packageRoot);
    fs.appendFileSync(path.join(packageRoot, "host/config-adapter.cts"), "// stale\n");
    expectDiagnostic(packageRoot, "adapter-artifact", "host");
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects authoring and credential files that npm would publish", async (t) => {
  await t.test("a test fixture in the archive", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "tests/leak.txt"],
    });
    try {
      writeFile(packageRoot, "tests/leak.txt", "authoring only\n");
      expectDiagnostic(packageRoot, "archive-authoring-path", "tests/leak.txt");
    } finally {
      removeFixture(packageRoot);
    }
  });
  await t.test("a credential-shaped file in the archive", () => {
    const packageRoot = createPackageFixture({
      files: [...REQUIRED_RUNTIME_FILES, "host/*-adapter.cts", "credentials.json"],
    });
    try {
      writeFile(packageRoot, "credentials.json", '{"token":"not-a-real-secret"}\n');
      expectDiagnostic(packageRoot, "archive-credential-path", "credentials.json");
    } finally {
      removeFixture(packageRoot);
    }
  });
});

test("rejects an adapter artifact omitted from the npm archive", () => {
  const packageRoot = createPackageFixture({ files: REQUIRED_RUNTIME_FILES });
  try {
    expectDiagnostic(packageRoot, "archive-membership", "host/config-adapter.cts");
  } finally {
    removeFixture(packageRoot);
  }
});

test("requires compiled adapters for the capabilities declared by the manifest", async (t) => {
  const cases = [
    {
      name: "the universal configuration boundary",
      manifest:
        "name: future-terminal\nmcp:\n  support: disabled\nmessaging:\n  support: disabled\n",
      artifact: "host/config-adapter.cts",
    },
    {
      name: "the universal messaging boundary",
      manifest:
        "name: future-terminal\nmcp:\n  support: disabled\nmessaging:\n  support: disabled\n",
      artifact: "host/messaging-adapter.cts",
    },
    {
      name: "MCP bridge support",
      manifest: "name: future-terminal\nmcp:\n  support: bridge\nmessaging:\n  support: disabled\n",
      artifact: "host/mcp-adapter.cts",
    },
    {
      name: "managed image startup",
      manifest:
        "name: future-terminal\nmanaged_image: {}\nmcp:\n  support: disabled\nmessaging:\n  support: disabled\n",
      artifact: "host/startup-adapter.cts",
    },
    {
      name: "package-owned configuration restore",
      manifest: [
        "name: future-terminal",
        "state_files:",
        "  - path: config.json",
        "    restore:",
        "      merge: package-config",
        "mcp:",
        "  support: disabled",
        "messaging:",
        "  support: disabled",
        "",
      ].join("\n"),
      artifact: "host/restore-adapter.cts",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const packageRoot = createPackageFixture({ manifest: fixture.manifest });
      try {
        if (fixture.artifact !== "host/config-adapter.cts") {
          writeFile(
            packageRoot,
            fixture.artifact,
            '"use strict";\nmodule.exports = Object.freeze({});\n',
          );
        }
        fs.rmSync(path.join(packageRoot, fixture.artifact));
        expectDiagnostic(packageRoot, "adapter-artifact", fixture.artifact);
      } finally {
        removeFixture(packageRoot);
      }
    });
  }
});

test("rejects typed adapter source that npm would publish", () => {
  const packageRoot = createPackageFixture({
    files: [...REQUIRED_RUNTIME_FILES, "host/**"],
  });
  try {
    addTypedAdapterSource(packageRoot);
    expectDiagnostic(packageRoot, "archive-authoring-path", "host/source/config-adapter.cts");
  } finally {
    removeFixture(packageRoot);
  }
});

test("rejects unsupported CLI options without reading a package", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(CONTRACT_ROOT, "validate-package.mts"), "--execute-scripts", "."],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage: nemoclaw-validate-package [--json] <package-root>\n");
});
