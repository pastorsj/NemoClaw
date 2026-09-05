// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveSkillPaths } from "./skill-install";
import { validateSkillName } from "./skill-name";
import { checkExisting, removeSkill, verifyRemove } from "./skill-remote";

const MIRRORED_SKILLS = {
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
const SESSION_SKILLS = {
  support: "managed",
  install_root: "/sandbox/.future/skills",
  collision: "replace",
  removal: "remove",
  activation: { kind: "new-session" },
} as const;
const REFUSED_SKILLS = {
  support: "managed",
  install_root: "/sandbox/.future/agent/skills",
  collision: "refuse",
  removal: "refuse",
  activation: { kind: "new-session" },
} as const;

describe("validateSkillName", () => {
  it("accepts valid skill names", () => {
    expect(validateSkillName("my-skill")).toBe(true);
    expect(validateSkillName("my_skill")).toBe(true);
    expect(validateSkillName("my.skill")).toBe(true);
    expect(validateSkillName("MySkill123")).toBe(true);
    expect(validateSkillName("digicon-zeiss-ai-strategy")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSkillName("")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(validateSkillName("my skill")).toBe(false);
  });

  it("rejects names with shell metacharacters", () => {
    expect(validateSkillName("my;skill")).toBe(false);
    expect(validateSkillName("my$skill")).toBe(false);
    expect(validateSkillName("my/skill")).toBe(false);
    expect(validateSkillName("../escape")).toBe(false);
    expect(validateSkillName("my`skill`")).toBe(false);
  });

  it("rejects dot and double-dot to prevent directory traversal on rm -rf", () => {
    expect(validateSkillName(".")).toBe(false);
    expect(validateSkillName("..")).toBe(false);
  });
});

describe("removeSkill (unit — no SSH)", () => {
  it("returns success=false and a warning when sshExec returns null (sandbox unreachable)", () => {
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");

    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    const result = removeSkill(ctx, paths);

    expect(result.success).toBe(false);
    expect(result.removedUploadDir).toBe(false);
    expect(result.messages.some((m) => m.startsWith("Warning:"))).toBe(true);
  });

  it("reports failure when mirror removal fails after removing the install directory", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => ({
        status: command.includes("$HOME/.future/skills") ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(result.removedUploadDir).toBe(true);
    expect(result.removedMirrorDir).toBe(false);
    expect(result.success).toBe(false);
  });

  it("removes declared install and mirror directories before resetting the session index", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const commands: string[] = [];
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.success).toBe(true);
    expect(result.clearedSessions).toBe(true);
    expect(commands).toEqual([
      "rm -rf '/sandbox/.future/skills/test-skill'",
      'rm -rf "$HOME/.future/skills/test-skill"',
      "printf '{}' > '/sandbox/.future/sessions/index.json'",
    ]);
  });

  it("tells users to start a fresh session when the package declares new-session activation", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(SESSION_SKILLS, "test-skill");
    const commands: string[] = [];
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.success).toBe(true);
    expect(result.messages).toEqual([
      "Start a new chat session for the removal to take effect; a gateway restart is not required.",
    ]);
    expect(commands).toEqual(["rm -rf '/sandbox/.future/skills/test-skill'"]);
  });

  it("probes a removal-refused destination for diagnostics", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(REFUSED_SKILLS, "user-authored");
    const commands: string[] = [];
    checkExisting(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "ABSENT", stderr: "" };
      },
    });

    expect(paths.removal).toBe("refuse");
    expect(commands).toEqual([
      "{ test -e '/sandbox/.future/agent/skills/user-authored'; } && echo EXISTS || echo ABSENT",
    ]);
  });

  it("refuses removal when the package declares removal refusal", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(REFUSED_SKILLS, "test-skill");
    const commands: string[] = [];
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.success).toBe(false);
    expect(result.removedUploadDir).toBe(false);
    expect(result.removedMirrorDir).toBe(false);
    expect(result.clearedSessions).toBe(false);
    expect(result.messages).toEqual([
      "Error: automatic removal is unavailable for the package-declared skill directory /sandbox/.future/agent/skills/test-skill.",
    ]);
    expect(commands).toEqual([]);
  });
});

describe("verifyRemove (unit — no SSH)", () => {
  it("returns false when SSH is unreachable (conservative — treat failure as not-gone)", () => {
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(verifyRemove(ctx, paths)).toBe(false);
  });

  it("returns false for non-mirrored paths when SSH is unreachable", () => {
    const paths = resolveSkillPaths(SESSION_SKILLS, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(verifyRemove(ctx, paths)).toBe(false);
  });

  it("refuses removal verification without SSH when removal is refused", () => {
    const paths = resolveSkillPaths(REFUSED_SKILLS, "test-skill");
    const commands: string[] = [];
    const gone = verifyRemove({ configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" }, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "GONE", stderr: "" };
      },
    });

    expect(gone).toBe(false);
    expect(commands).toEqual([]);
  });

  it("verifies both declared skill directories are gone", () => {
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const commands: string[] = [];
    const gone = verifyRemove(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "GONE", stderr: "" };
      },
    });

    expect(gone).toBe(true);
    expect(commands).toEqual([
      "test ! -e '/sandbox/.future/skills/test-skill' && test ! -e \"$HOME/.future/skills/test-skill\" && echo GONE || echo EXISTS",
    ]);
  });
});

describe("checkExisting (unit — no SSH)", () => {
  it("returns null when SSH is unreachable for mirrored paths", () => {
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(checkExisting(ctx, paths)).toBeNull();
  });

  it("returns null when SSH is unreachable for non-mirrored paths", () => {
    const paths = resolveSkillPaths(SESSION_SKILLS, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(checkExisting(ctx, paths)).toBeNull();
  });

  it("probes skill directories so removal can clean partial uploads", () => {
    const paths = resolveSkillPaths(MIRRORED_SKILLS, "test-skill");
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const commands: string[] = [];
    const exists = checkExisting(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "EXISTS", stderr: "" };
      },
    });

    expect(exists).toBe(true);
    expect(commands[0]).toContain("test -e '/sandbox/.future/skills/test-skill'");
    expect(commands[0]).toContain('test -e "$HOME/.future/skills/test-skill"');
    expect(commands[0]).not.toContain("SKILL.md");
  });
});
