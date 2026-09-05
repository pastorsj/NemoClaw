// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLegacySkillPaths } from "./legacy-skills";
// Import source directly so tests cannot pass against a stale build.
import {
  collectFiles,
  parseFrontmatter,
  postInstall,
  resolveSkillPaths,
  validateRelativePath,
  verifyInstall,
} from "./skill-install";

const MIRRORED_RESET_SKILLS = {
  support: "managed",
  install_root: "/sandbox/.future/skills",
  mirror_root: "$HOME/.future/skills",
  collision: "replace",
  removal: "remove",
  activation: {
    kind: "reset-session-index",
    path: "/sandbox/.future/sessions/index.json",
  },
} as const;

describe("parseFrontmatter", () => {
  it("extracts name from valid frontmatter", () => {
    const result = parseFrontmatter("---\nname: my-skill\ndescription: test\n---\n# Body");
    expect(result).toEqual({ name: "my-skill" });
  });

  it("handles quoted name values", () => {
    expect(parseFrontmatter('---\nname: "my-tool"\n---\n').name).toBe("my-tool");
    expect(parseFrontmatter("---\nname: 'demo.tool'\n---\n").name).toBe("demo.tool");
  });

  it("handles name with dots, hyphens, and underscores", () => {
    expect(parseFrontmatter("---\nname: my_skill.v2-beta\n---\n").name).toBe("my_skill.v2-beta");
  });

  it("parses complex YAML metadata beyond name", () => {
    const fm = parseFrontmatter(
      '---\nname: rich-skill\ndescription: "A skill"\nmetadata: { "openclaw": { "emoji": "🔧" } }\n---\n',
    );
    expect(fm.name).toBe("rich-skill");
  });

  it("rejects malformed YAML", () => {
    expect(() => parseFrontmatter("---\nname: ok\ndescription: [broken\n---\n")).toThrow(
      "not valid YAML",
    );
  });

  it("rejects non-mapping frontmatter", () => {
    expect(() => parseFrontmatter("---\n- just\n- a list\n---\n")).toThrow(
      "must be a YAML mapping",
    );
  });

  it("throws when frontmatter is missing entirely", () => {
    expect(() => parseFrontmatter("# Just markdown\nNo frontmatter")).toThrow(
      "missing YAML frontmatter",
    );
  });

  it("throws when closing delimiter is missing", () => {
    expect(() => parseFrontmatter("---\nname: broken\n# No closing")).toThrow(
      "missing closing --- frontmatter delimiter",
    );
  });

  it("throws when name field is absent", () => {
    expect(() => parseFrontmatter("---\ndescription: no name here\n---\n")).toThrow(
      "missing required 'name' field",
    );
  });

  it("throws when name field is empty or null", () => {
    expect(() => parseFrontmatter("---\nname:\n---\n")).toThrow("missing required 'name' field");
    expect(() => parseFrontmatter('---\nname: ""\n---\n')).toThrow("missing required 'name' field");
  });

  it("rejects names with invalid characters", () => {
    expect(() => parseFrontmatter("---\nname: my skill\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: ../escape\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: a/b\n---\n")).toThrow("is invalid");
  });

  it("rejects dot and double-dot as skill names in frontmatter", () => {
    expect(() => parseFrontmatter("---\nname: .\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: ..\n---\n")).toThrow("is invalid");
  });
});

describe("validateRelativePath", () => {
  it("accepts safe paths", () => {
    expect(validateRelativePath("SKILL.md")).toBe(true);
    expect(validateRelativePath("scripts/helper.js")).toBe(true);
    expect(validateRelativePath("data/config-v2.yaml")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(validateRelativePath("$(touch /tmp/pwn).js")).toBe(false);
    expect(validateRelativePath("a'b.txt")).toBe(false);
    expect(validateRelativePath('a"b.txt')).toBe(false);
    expect(validateRelativePath("a`b`.txt")).toBe(false);
    expect(validateRelativePath("file name.txt")).toBe(false);
    expect(validateRelativePath("a;rm -rf.txt")).toBe(false);
  });

  it("rejects directory traversal", () => {
    expect(validateRelativePath("../escape")).toBe(false);
    expect(validateRelativePath("foo/../../etc/passwd")).toBe(false);
    expect(validateRelativePath("./current")).toBe(false);
  });

  it("rejects empty and degenerate paths", () => {
    expect(validateRelativePath("")).toBe(false);
    expect(validateRelativePath("/absolute")).toBe(false);
    expect(validateRelativePath("foo//bar")).toBe(false);
  });
});

describe("collectFiles", () => {
  let tmpDir: string;

  function setup(files: Record<string, string>) {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(tmpDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  function cleanup() {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("collects a single SKILL.md", () => {
    setup({ "SKILL.md": "---\nname: solo\n---\n" });
    try {
      const { files, skippedDotfiles, unsafePaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(skippedDotfiles).toEqual([]);
      expect(unsafePaths).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("collects SKILL.md plus nested scripts, skips dotfiles", () => {
    setup({
      "SKILL.md": "---\nname: rich\n---\n",
      "scripts/helper.js": "console.log('hi')",
      ".env": "KEY=val",
    });
    try {
      const { files, skippedDotfiles } = collectFiles(tmpDir);
      expect(files.sort()).toEqual(["SKILL.md", "scripts/helper.js"]);
      expect(skippedDotfiles).toEqual([".env"]);
    } finally {
      cleanup();
    }
  });

  it("reports hidden directories in skippedDotfiles", () => {
    setup({
      "SKILL.md": "---\nname: safe\n---\n",
      ".secret/token.txt": "secret-value",
      "scripts/visible.sh": "#!/bin/sh",
      "scripts/.hidden.sh": "#!/bin/sh",
    });
    try {
      const { files, skippedDotfiles } = collectFiles(tmpDir);
      expect(files.sort()).toEqual(["SKILL.md", "scripts/visible.sh"]);
      expect(skippedDotfiles.sort()).toEqual([".secret/", "scripts/.hidden.sh"]);
    } finally {
      cleanup();
    }
  });

  it("flags files with unsafe characters", () => {
    setup({
      "SKILL.md": "---\nname: bad\n---\n",
      "has space.txt": "content",
    });
    try {
      const { files, unsafePaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(unsafePaths).toEqual(["has space.txt"]);
    } finally {
      cleanup();
    }
  });

  it("rejects visible symlinks instead of following their targets", () => {
    setup({ "SKILL.md": "---\nname: linked\n---\n" });
    try {
      symlinkSync("SKILL.md", join(tmpDir, "alias.md"));
      const { files, unsupportedPaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(unsupportedPaths).toEqual(["alias.md"]);
    } finally {
      cleanup();
    }
  });
});

describe("resolveSkillPaths", () => {
  it("resolves a future package from its declaration without a harness catalogue", () => {
    const paths = resolveSkillPaths(
      {
        support: "managed",
        install_root: "/sandbox/.future/skills",
        mirror_root: "$HOME/.future/skills",
        collision: "replace",
        removal: "remove",
        activation: { kind: "new-session" },
      },
      "test-skill",
    );

    expect(paths).toEqual({
      stateDir: "/sandbox/.future",
      uploadDir: "/sandbox/.future/skills/test-skill",
      mirrorDir: "$HOME/.future/skills/test-skill",
      collision: "replace",
      removal: "remove",
      activation: { kind: "new-session" },
    });
  });

  it("refuses to resolve a disabled package capability", () => {
    expect(() =>
      resolveSkillPaths(
        { support: "disabled", reason: "Future Harness does not load skills." },
        "test-skill",
      ),
    ).toThrow("Future Harness does not load skills");
  });
});

describe("resolveLegacySkillPaths", () => {
  it("preserves the no-receipt OpenClaw layout", () => {
    expect(resolveLegacySkillPaths(null, "weather")).toMatchObject({
      stateDir: "/sandbox/.openclaw",
      uploadDir: "/sandbox/.openclaw/skills/weather",
      mirrorDir: "$HOME/.openclaw/skills/weather",
      collision: "replace",
      removal: "remove",
      activation: { kind: "reset-session-index" },
    });
  });

  it("preserves fresh-only removal refusal for a no-receipt Deep Agents row", () => {
    expect(
      resolveLegacySkillPaths(
        {
          name: "langchain-deepagents-code",
          configPaths: { dir: "/sandbox/.deepagents" },
        },
        "note-summarizer",
      ),
    ).toMatchObject({
      uploadDir: "/sandbox/.deepagents/agent/skills/note-summarizer",
      collision: "refuse",
      removal: "refuse",
      activation: { kind: "new-session" },
    });
  });
});

describe("postInstall", () => {
  it("tells users to start a fresh session when the package declares new-session activation", () => {
    const paths = resolveSkillPaths(
      {
        support: "managed",
        install_root: "/sandbox/.future/skills",
        collision: "replace",
        removal: "remove",
        activation: { kind: "new-session" },
      },
      "weather",
    );
    const result = postInstall(
      { configFile: "/tmp/ssh-config", sandboxName: "alpha" },
      paths,
      "/unused",
      {
        sshExecImpl: () => {
          throw new Error("new-session activation must not require an SSH mutation");
        },
      },
    );

    expect(result).toEqual({
      success: true,
      messages: ["Start a new chat session to load the skill; a gateway restart is not required."],
    });
  });

  it("reports a required gateway restart without claiming that core performed one", () => {
    const paths = resolveSkillPaths(
      {
        support: "managed",
        install_root: "/sandbox/.future/skills",
        collision: "replace",
        removal: "remove",
        activation: { kind: "gateway-restart-required" },
      },
      "weather",
    );
    const result = postInstall(
      { configFile: "/tmp/ssh-config", sandboxName: "alpha" },
      paths,
      "/unused",
      {
        sshExecImpl: () => {
          throw new Error("restart-required activation must not execute a restart");
        },
      },
    );

    expect(result.messages).toEqual(["Restart the agent gateway to pick up the new skill."]);
  });

  it("resets the declared session index after an updated skill install", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "skill-postinstall-"));
    const commands: string[] = [];
    try {
      writeFileSync(skillDir + "/SKILL.md", "---\nname: weather\n---\n# Weather\n");
      const result = postInstall(
        { configFile: "/tmp/ssh-config", sandboxName: "alpha" },
        resolveSkillPaths(MIRRORED_RESET_SKILLS, "weather"),
        skillDir,
        {
          sshExecImpl: (_ctx, command) => {
            commands.push(command);
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(result).toEqual({ success: true, messages: [] });
      expect(commands).toContain("printf '{}' > '/sandbox/.future/sessions/index.json'");
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("copies an installed skill into the declared loader mirror", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "skill-postinstall-mirror-"));
    const commands: string[] = [];
    try {
      writeFileSync(skillDir + "/SKILL.md", "---\nname: report-writer\n---\n# Report\n");
      const paths = resolveSkillPaths(MIRRORED_RESET_SKILLS, "report-writer");
      postInstall({ configFile: "/tmp/ssh-config", sandboxName: "alpha" }, paths, skillDir, {
        sshExecImpl: (_ctx, command) => {
          commands.push(command);
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      // A command must copy the upload dir into the home mirror dir.
      const mirrorCmd = commands.find(
        (c) => c.includes(paths.uploadDir) && c.includes('"$HOME/.future/skills/report-writer"'),
      );
      expect(
        mirrorCmd,
        "postInstall should mirror the skill into the declared loader root",
      ).toBeDefined();
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("warns when the declared loader mirror cannot be created", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "skill-postinstall-mirror-fail-"));
    try {
      writeFileSync(skillDir + "/SKILL.md", "---\nname: report-writer\n---\n# Report\n");
      const paths = resolveSkillPaths(MIRRORED_RESET_SKILLS, "report-writer");
      const result = postInstall(
        { configFile: "/tmp/ssh-config", sandboxName: "alpha" },
        paths,
        skillDir,
        {
          sshExecImpl: (_ctx, command) => ({
            // Fail only the mirror command; session refresh still succeeds.
            status: command.includes("$HOME/.future/skills") ? 1 : 0,
            stdout: "",
            stderr: "",
          }),
        },
      );

      expect(result.success).toBe(true);
      expect(result.messages.some((m) => m.startsWith("Warning:") && m.includes("mirror"))).toBe(
        true,
      );
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

describe("verifyInstall", () => {
  it("requires SKILL.md in the declared loader mirror", () => {
    const paths = resolveSkillPaths(MIRRORED_RESET_SKILLS, "report-writer");
    const commands: string[] = [];
    const ok = verifyInstall({ configFile: "/tmp/ssh-config", sandboxName: "alpha" }, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "EXISTS", stderr: "" };
      },
    });

    expect(ok).toBe(true);
    // The verification command must cover the home mirror SKILL.md.
    expect(commands.some((c) => c.includes('"$HOME/.future/skills/report-writer/SKILL.md"'))).toBe(
      true,
    );
  });

  it("returns false when the upload dir has SKILL.md but the home mirror does not", () => {
    const paths = resolveSkillPaths(MIRRORED_RESET_SKILLS, "report-writer");
    const ok = verifyInstall({ configFile: "/tmp/ssh-config", sandboxName: "alpha" }, paths, {
      // A combined `test -f A && test -f B` shell command fails (non-zero,
      // no EXISTS) when the mirror file is absent.
      sshExecImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    });

    expect(ok).toBe(false);
  });
});
