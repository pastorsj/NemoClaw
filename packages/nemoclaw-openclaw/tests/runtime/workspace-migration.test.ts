// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunctionFromSource,
  readOpenClawStartupSource,
} from "../helpers/startup-suite";

describe("NC-2227-01: legacy migration behavior", () => {
  const src = readOpenClawStartupSource();

  function migrationFunctions(): string {
    return [
      "path_has_immutable_bit",
      "ensure_mutable_for_migration",
      "chown_tree_no_symlink_follow",
      "legacy_symlinks_exist",
      "assert_no_legacy_layout",
      "migrate_legacy_layout",
    ]
      .map((name) => extractShellFunctionFromSource(src, name))
      .join("\n");
  }

  function runMigration(
    configDir: string,
    dataDir: string,
    opts: {
      fakeRoot?: boolean;
      fakeSandboxOwner?: boolean;
      fakeRootConfigOwner?: boolean;
    } = {},
  ) {
    const script = path.join(path.dirname(configDir), `migration-${Date.now()}.sh`);
    const prelude = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      opts.fakeRoot
        ? 'id() { if [ "${1:-}" = "-u" ]; then echo 0; else command id "$@"; fi; }'
        : "",
      opts.fakeSandboxOwner || opts.fakeRootConfigOwner
        ? `stat() {
  if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%U" ] && [ "\${3:-}" = ${JSON.stringify(dataDir)} ]; then
    echo ${opts.fakeSandboxOwner ? "sandbox" : '$(command stat -c %U "$3")'}
    return 0
  fi
  if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%U" ] && [ "\${3:-}" = ${JSON.stringify(configDir)} ]; then
    echo ${opts.fakeRootConfigOwner ? "root" : '$(command stat -c %U "$3")'}
    return 0
  fi
  command stat "$@"
}`
        : "",
      migrationFunctions(),
      `migrate_legacy_layout ${JSON.stringify(configDir)} ${JSON.stringify(dataDir)} openclaw`,
    ].filter(Boolean);
    fs.writeFileSync(script, prelude.join("\n"), { mode: 0o700 });
    try {
      return spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
    } finally {
      fs.rmSync(script, { force: true });
    }
  }

  it("migrates legacy and hidden data, removes the legacy dir, and writes a read-only sentinel", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const dataDir = path.join(tmpDir, ".openclaw-data");
    fs.mkdirSync(path.join(configDir, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "workspace", "note.txt"), "from legacy");
    fs.mkdirSync(path.join(dataDir, ".hidden"));
    fs.writeFileSync(path.join(dataDir, ".hidden", "secret.txt"), "secret");
    fs.rmSync(path.join(configDir, "workspace"), { recursive: true, force: true });
    fs.symlinkSync(path.join(dataDir, "workspace"), path.join(configDir, "workspace"));

    try {
      const result = runMigration(configDir, dataDir, { fakeRoot: true });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Completed openclaw layout migration");
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.lstatSync(path.join(configDir, "workspace")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(configDir, "workspace", "note.txt"), "utf-8")).toBe(
        "from legacy",
      );
      expect(fs.readFileSync(path.join(configDir, ".hidden", "secret.txt"), "utf-8")).toBe(
        "secret",
      );
      const sentinel = path.join(configDir, ".migration-complete");
      expect(fs.existsSync(sentinel)).toBe(true);
      expect((fs.statSync(sentinel).mode & 0o777).toString(8)).toBe("444");
    } finally {
      spawnSync(
        "bash",
        ["-lc", 'chmod -R u+rwx "$1" 2>/dev/null || true; rm -rf "$1"', "bash", tmpDir],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup on WSL/overlayfs can fail on chmod-preserved fixtures */
      }
    }
  });

  it("refuses symlink and sandbox-owned untrusted migration inputs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-guards-"));
    try {
      const configDir = path.join(tmpDir, "config");
      const dataDir = path.join(tmpDir, "data");
      fs.mkdirSync(configDir);
      fs.mkdirSync(dataDir);

      fs.symlinkSync(configDir, path.join(tmpDir, "config-link"));
      expect(
        runMigration(path.join(tmpDir, "config-link"), dataDir, { fakeRoot: true }).status,
      ).toBe(1);

      fs.writeFileSync(path.join(dataDir, "evil"), "payload");
      fs.symlinkSync(path.join(tmpDir, "outside"), path.join(dataDir, "linked-entry"));
      const linkedEntry = runMigration(configDir, dataDir, { fakeRoot: true });
      expect(linkedEntry.status).toBe(1);
      expect(linkedEntry.stderr).toContain("refusing migration");

      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir);
      const sandboxOwned = runMigration(configDir, dataDir, {
        fakeRoot: true,
        fakeSandboxOwner: true,
      });
      expect(sandboxOwned.status).toBe(1);
      expect(sandboxOwned.stderr).toContain("possible agent-planted trigger");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(["workspace-existing", "workspace-main", "workspace-alpha", "workspace-beta"])(
    "provisions only canonical workspace paths from OpenClaw config [%s]",
    (name) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workspaces-"));
      const configDir = path.join(tmpDir, ".openclaw");
      const script = path.join(tmpDir, "provision.sh");
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.join(configDir, "workspace-existing"));
      fs.symlinkSync(tmpDir, path.join(configDir, "workspace-linked"));
      fs.writeFileSync(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: { workspace: "main" },
            list: [
              { workspace: path.join(configDir, "workspace-alpha") },
              { workspace: "workspace-beta" },
              { workspace: "../escape" },
            ],
          },
        }),
      );
      const body = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractShellFunctionFromSource(src, "chown_tree_no_symlink_follow"),
        extractShellFunctionFromSource(src, "provision_agent_workspaces").replaceAll(
          "/sandbox/.openclaw",
          configDir,
        ),
        "provision_agent_workspaces",
      ].join("\n");
      fs.writeFileSync(script, body, { mode: 0o700 });
      try {
        const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
        expect(result.status).toBe(0);

        expect(fs.statSync(path.join(configDir, name)).isDirectory()).toBe(true);

        expect(fs.existsSync(path.join(configDir, "workspace-.."))).toBe(false);
        expect(result.stderr).toContain("refusing symlinked workspace dir");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe("seed_default_workspace_templates (#3240)", () => {
  const src = readOpenClawStartupSource();

  function runSeed(
    workspaceDir: string,
    templatesDir: string,
    scriptPath: string,
    options: { skipBootstrap?: boolean; env?: Record<string, string> } = {},
  ) {
    const configPath = path.join(path.dirname(scriptPath), "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { skipBootstrap: options.skipBootstrap ?? true } } }),
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractShellFunctionFromSource(src, "seed_default_workspace_templates"),
        `seed_default_workspace_templates ${JSON.stringify(workspaceDir)} ${JSON.stringify(templatesDir)} ${JSON.stringify(configPath)}`,
      ].join("\n"),
      { mode: 0o700 },
    );
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, NEMOCLAW_MINIMAL_BOOTSTRAP: "", ...(options.env ?? {}) },
      timeout: 5000,
    });
  }

  function writeTemplates(templatesDir: string) {
    fs.mkdirSync(templatesDir, { recursive: true });
    for (const name of [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
    ]) {
      fs.writeFileSync(
        path.join(templatesDir, name),
        `---\nsummary: "${name} template"\n---\n# ${name} template content\n`,
      );
    }
  }

  it("seeds the documented workspace templates and skips BOOTSTRAP.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeTemplates(templatesDir);
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      expect(
        ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md"].every(
          (name) => fs.existsSync(path.join(workspaceDir, name)),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "BOOTSTRAP.md"))).toBe(false);
      expect(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8")).toBe(
        "# SOUL.md template content\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    path.join("docs", "reference", "templates"),
    path.join("dist", "docs", "reference", "templates"),
  ])("resolves supported OpenClaw package template layouts [case %#]", (relativeTemplatesDir) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-package-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const fakeBin = path.join(tmpDir, "bin");
    const npmRoot = path.join(tmpDir, "npm-root");
    const templatesDir = path.join(npmRoot, "openclaw", relativeTemplatesDir);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    writeTemplates(templatesDir);
    fs.writeFileSync(
      path.join(fakeBin, "npm"),
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "root" ] && [ "${2:-}" = "-g" ]; then',
        `  printf '%s\\n' ${JSON.stringify(npmRoot)}`,
        "  exit 0",
        "fi",
        'printf "unexpected npm args: %s\\n" "$*" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = runSeed(workspaceDir, "", path.join(tmpDir, "seed.sh"), {
        env: { PATH: `${fakeBin}:${process.env.PATH || ""}` },
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(true);
      expect(result.stderr).toContain("seeded 6 default workspace template");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves the OpenClaw package root from the openclaw binary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-openclaw-bin-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const openclawPkg = path.join(tmpDir, "openclaw-package");
    const binDir = path.join(openclawPkg, "bin");
    const npmRoot = path.join(tmpDir, "empty-npm-root");
    const templatesDir = path.join(openclawPkg, "docs", "reference", "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(npmRoot, { recursive: true });
    writeTemplates(templatesDir);
    fs.writeFileSync(path.join(binDir, "openclaw"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(binDir, "npm"),
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "root" ] && [ "${2:-}" = "-g" ]; then',
        `  printf '%s\n' ${JSON.stringify(npmRoot)}`,
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = runSeed(workspaceDir, "", path.join(tmpDir, "seed.sh"), {
        env: { PATH: `${binDir}:${process.env.PATH || ""}` },
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(true);
      expect(result.stderr).toContain("seeded 6 default workspace template");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not synthesize templates when OpenClaw templates are missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-missing-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const fakeBin = path.join(tmpDir, "bin");
    const npmRoot = path.join(tmpDir, "empty-npm-root");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openclaw"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(fakeBin, "npm"),
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "root" ] && [ "${2:-}" = "-g" ]; then',
        `  printf '%s\n' ${JSON.stringify(npmRoot)}`,
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = runSeed(workspaceDir, "", path.join(tmpDir, "seed.sh"), {
        env: { PATH: `${fakeBin}:${path.dirname(process.execPath)}:${process.env.PATH || ""}` },
      });
      expect(result.status).toBe(0);
      expect(
        ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md"].every(
          (name) => !fs.existsSync(path.join(workspaceDir, name)),
        ),
      ).toBe(true);
      expect(result.stderr).toContain("openclaw workspace templates dir not found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not seed unless OpenClaw bootstrap is explicitly skipped", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-bootstrap-on-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"), {
        skipBootstrap: false,
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not clobber an already-populated workspace", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-existing-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "USER.md"), "user content");
    fs.writeFileSync(path.join(templatesDir, "USER.md"), "template content");
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(workspaceDir, "USER.md"), "utf-8")).toBe("user content");
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses to seed a symlinked workspace dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-symlink-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "link");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(realDir);
    fs.mkdirSync(templatesDir);
    fs.symlinkSync(realDir, linkDir);
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(linkDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("refusing to seed symlinked workspace dir");
      expect(fs.existsSync(path.join(realDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips seeding when NEMOCLAW_MINIMAL_BOOTSTRAP=1 (#2598)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-minimal-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeTemplates(templatesDir);
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"), {
        env: { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("NEMOCLAW_MINIMAL_BOOTSTRAP=1");
      expect(result.stderr).toContain("skipping default workspace template seed");
      expect(
        ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md"].every(
          (name) => !fs.existsSync(path.join(workspaceDir, name)),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still seeds when NEMOCLAW_MINIMAL_BOOTSTRAP is not '1' (#2598)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-noopt-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeTemplates(templatesDir);
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"), {
        env: { NEMOCLAW_MINIMAL_BOOTSTRAP: "0" },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("skipping default workspace template seed");
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
