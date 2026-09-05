// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureSandboxSshConfig = vi.hoisted(() => vi.fn());
const getSessionAgent = vi.hoisted(() => vi.fn());
const getSandbox = vi.hoisted(() => vi.fn());
const captureSandboxCommandAgentAuthority = vi.hoisted(() => vi.fn());
const requireCurrentSandboxCommandAgentAuthority = vi.hoisted(() => vi.fn());
const resolveLegacySkillPaths = vi.hoisted(() => vi.fn());
const ensureLiveSandboxOrExit = vi.hoisted(() => vi.fn());
const skillInstall = vi.hoisted(() => ({
  validateSkillName: vi.fn(),
  resolveSkillPaths: vi.fn(),
  checkExisting: vi.fn(),
  removeSkill: vi.fn(),
  verifyRemove: vi.fn(),
  parseFrontmatter: vi.fn(),
  collectFiles: vi.fn(),
  uploadDirectory: vi.fn(),
  installFreshSkill: vi.fn(),
  postInstall: vi.fn(),
  verifyInstall: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureSandboxSshConfig,
}));

vi.mock("../../agent/runtime", () => ({
  getSessionAgent,
}));

vi.mock("../../state/registry", () => ({
  getSandbox,
}));

vi.mock("../../sandbox/command-agent", () => ({
  captureSandboxCommandAgentAuthority,
  requireCurrentSandboxCommandAgentAuthority,
}));

vi.mock("../../legacy-skills", () => ({
  resolveLegacySkillPaths,
}));

vi.mock("../../skill-install", () => skillInstall);

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit,
}));

import { installSandboxSkill, removeSandboxSkill } from "./skill-install";

const paths = {
  stateDir: "/sandbox/.openclaw",
  uploadDir: "/sandbox/.openclaw/skills/demo-skill",
  mirrorDir: "$HOME/.openclaw/skills/demo-skill",
  collision: "replace",
  removal: "remove",
  activation: {
    kind: "reset-session-index",
    path: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
  },
};

const agent = { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } };
const deepAgent = {
  name: "langchain-deepagents-code",
  configPaths: { dir: "/sandbox/.deepagents" },
};
const sharedPaths = {
  stateDir: "/sandbox/.deepagents",
  uploadDir: "/sandbox/.deepagents/agent/skills/demo-skill",
  mirrorDir: null,
  collision: "refuse",
  removal: "refuse",
  activation: { kind: "new-session" },
};
const packageEntry = {
  name: "alpha",
  agent: "future-harness",
  harnessPackage: {
    kind: "agent-runtime",
    id: "future-harness",
    packageVersion: "3.0.0",
    contentDigest: "a".repeat(64),
  },
};
const packageCapability = {
  support: "managed",
  install_root: "/sandbox/.future/skills",
  collision: "replace",
  removal: "remove",
  activation: { kind: "new-session" },
};
const packageAuthority = {
  agent: "future-harness",
  harnessPackage: packageEntry.harnessPackage,
  harnessPackageMigration: null,
  definition: { name: "future-harness", skillCapability: packageCapability },
};

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  return dir;
}

function restoreExitCode(previousExitCode: typeof process.exitCode): void {
  process.exitCode = previousExitCode;
}

function expectTempSshConfigCleanedUp(configFile: string): void {
  const configDir = path.dirname(configFile);
  expect(configDir).not.toBe(os.tmpdir());
  expect(path.basename(configDir)).toMatch(/^nemoclaw-ssh-skill-/);
  expect(path.basename(configFile)).toBe("ssh_config");
  expect(fs.existsSync(configDir)).toBe(false);
}

describe("sandbox skill action orchestration", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();

    captureSandboxSshConfig.mockReturnValue({ status: 0, output: "Host openshell-alpha\n" });
    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });
    getSessionAgent.mockReturnValue(agent);
    resolveLegacySkillPaths.mockReturnValue(paths);
    captureSandboxCommandAgentAuthority.mockReturnValue(packageAuthority);
    skillInstall.validateSkillName.mockReturnValue(true);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    skillInstall.checkExisting.mockReturnValue(true);
    skillInstall.removeSkill.mockReturnValue({
      success: true,
      removedUploadDir: true,
      removedMirrorDir: true,
      clearedSessions: true,
      messages: [],
    });
    skillInstall.verifyRemove.mockReturnValue(true);
    skillInstall.parseFrontmatter.mockReturnValue({ name: "demo-skill" });
    skillInstall.collectFiles.mockReturnValue({
      files: ["SKILL.md"],
      skippedDotfiles: [],
      unsafePaths: [],
      unsupportedPaths: [],
    });
    skillInstall.uploadDirectory.mockReturnValue({
      uploaded: 1,
      failed: [],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.installFreshSkill.mockReturnValue({
      success: true,
      uploaded: 1,
      contentDigest: "a".repeat(64),
    });
    skillInstall.postInstall.mockReturnValue({ success: true, messages: [] });
    skillInstall.verifyInstall.mockReturnValue(true);
  });

  afterEach(() => {
    restoreExitCode(previousExitCode);
    vi.restoreAllMocks();
  });

  it("fails skill remove when SSH config capture fails", async () => {
    captureSandboxSshConfig.mockReturnValue({ status: 1, output: "" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await expect(removeSandboxSkill("alpha", { name: "demo-skill" })).rejects.toThrow(
      "process.exit 1",
    );

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(captureSandboxSshConfig).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(error).toHaveBeenCalledWith("  Failed to obtain SSH configuration for the sandbox.");
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("treats unknown skill existence as fatal for remove and deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      expect(fs.existsSync(tempConfig)).toBe(true);
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Could not check if skill 'demo-skill' exists — sandbox may be unreachable.",
    );
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(tempConfig).not.toBe("");
    expect(fs.existsSync(tempConfig)).toBe(false);
  });

  it("reports an absent skill for remove and deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return false;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Skill 'demo-skill' is not installed in sandbox 'alpha'.");
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(tempConfig).not.toBe("");
    expect(fs.existsSync(tempConfig)).toBe(false);
  });

  it("removes and verifies an existing skill, then deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx, resolvedPaths) => {
      tempConfig = ctx.configFile;
      expect(resolvedPaths).toBe(paths);
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(getSessionAgent).toHaveBeenCalledWith("alpha");
    expect(resolveLegacySkillPaths).toHaveBeenCalledWith(agent, "demo-skill");
    expect(skillInstall.removeSkill).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(skillInstall.verifyRemove).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' removed"));
    expect(fs.existsSync(tempConfig)).toBe(false);
    expectTempSshConfigCleanedUp(tempConfig);
    expect(process.exitCode).toBeUndefined();
  });

  it("honors legacy removal refusal before obtaining SSH configuration", async () => {
    getSessionAgent.mockReturnValue(deepAgent);
    resolveLegacySkillPaths.mockReturnValue(sharedPaths);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("this harness package refuses skill removal"),
    );
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
  });

  it("stops skill installation at the shared gateway liveness guard (#2276)", async () => {
    const skillDir = makeSkillDir();
    ensureLiveSandboxOrExit.mockRejectedValueOnce(new Error("wrong gateway active"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("wrong gateway active");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
  });

  it("uses and revalidates an unknown package receipt before skill mutations", async () => {
    const skillDir = makeSkillDir();
    getSandbox.mockReturnValue(packageEntry);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(captureSandboxCommandAgentAuthority).toHaveBeenCalledWith(packageEntry);
    expect(skillInstall.resolveSkillPaths).toHaveBeenCalledWith(packageCapability, "demo-skill");
    expect(getSessionAgent).not.toHaveBeenCalled();
    expect(requireCurrentSandboxCommandAgentAuthority).toHaveBeenCalledTimes(2);
    expect(requireCurrentSandboxCommandAgentAuthority).toHaveBeenNthCalledWith(
      1,
      packageAuthority,
      packageEntry,
    );
    expect(skillInstall.uploadDirectory).toHaveBeenCalled();
    expect(skillInstall.postInstall).toHaveBeenCalled();
  });

  it("stops before upload when the package receipt changes", async () => {
    const skillDir = makeSkillDir();
    getSandbox.mockReturnValue(packageEntry);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    requireCurrentSandboxCommandAgentAuthority.mockImplementation(() => {
      throw new Error("Sandbox command agent authority changed before mutation");
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("authority changed before mutation");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
    expect(skillInstall.postInstall).not.toHaveBeenCalled();
  });

  it("rejects a receipt-backed package that disables skill installation", async () => {
    const skillDir = makeSkillDir();
    const disabledAuthority = {
      ...packageAuthority,
      definition: {
        name: "future-harness",
        skillCapability: { support: "disabled", reason: "No native skill loader." },
      },
    };
    getSandbox.mockReturnValue(packageEntry);
    captureSandboxCommandAgentAuthority.mockReturnValue(disabledAuthority);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "does not support NemoClaw skill installation: No native skill loader.",
      ),
    );
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
  });

  it("refuses a SKILL.md symlink before parsing or contacting the sandbox", async () => {
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-link-"));
    const target = path.join(skillDir, "target.md");
    fs.writeFileSync(target, "---\nname: demo-skill\n---\n# Demo\n");
    fs.symlinkSync(target, path.join(skillDir, "SKILL.md"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("process.exit 1");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(expect.stringContaining("must be a regular file"));
    expect(skillInstall.parseFrontmatter).not.toHaveBeenCalled();
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when SKILL.md is replaced between path validation and descriptor open", async () => {
    const skillDir = makeSkillDir();
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const replacement = path.join(skillDir, "replacement.md");
    fs.writeFileSync(replacement, "---\nname: attacker\n---\n# Replacement\n");
    let openedFlags = 0;
    vi.spyOn(fs, "openSync").mockImplementationOnce((_candidatePath, flags) => {
      openedFlags = flags as number;
      fs.rmSync(skillMdPath);
      fs.symlinkSync(replacement, skillMdPath);
      throw Object.assign(new Error("symbolic link refused"), { code: "ELOOP" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("process.exit 1");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(openedFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(openedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("must be a regular file"));
    expect(skillInstall.parseFrontmatter).not.toHaveBeenCalled();
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("continues skill install when the existence probe is unknown because upload plus verify are authoritative", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Warning: could not check sandbox for existing skill — treating as fresh install.",
      ),
    );
    expect(skillInstall.uploadDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      skillDir,
      paths.uploadDir,
    );
    expect(skillInstall.verifyInstall).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' installed"));
    expect(fs.existsSync(tempConfig)).toBe(false);
    expectTempSshConfigCleanedUp(tempConfig);
    expect(process.exitCode).toBeUndefined();
  });

  it("uses the atomic fresh-install path when collision replacement is refused", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    resolveLegacySkillPaths.mockReturnValue(sharedPaths);
    skillInstall.postInstall.mockReturnValue({
      success: true,
      messages: ["Start a new chat session to load the skill; a gateway restart is not required."],
    });
    let tempConfig = "";
    skillInstall.installFreshSkill.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return { success: true, uploaded: 1, contentDigest: "a".repeat(64) };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(skillInstall.installFreshSkill).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      skillDir,
      sharedPaths,
      {
        expectedRootIdentity: {
          dev: expect.any(Number),
          ino: expect.any(Number),
        },
      },
    );
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
    expect(skillInstall.postInstall).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      sharedPaths,
      skillDir,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' installed"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`Content digest (SHA-256): ${"a".repeat(64)}`),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Start a new chat session to load the skill"),
    );
    expectTempSshConfigCleanedUp(tempConfig);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a collision without using the replace path", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    resolveLegacySkillPaths.mockReturnValue(sharedPaths);
    skillInstall.installFreshSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "destination_exists",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("the harness skill destination already exists"),
    );
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
    expect(skillInstall.postInstall).not.toHaveBeenCalled();
  });

  it("reports an unknown atomic commit state with inspect-before-retry guidance", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    resolveLegacySkillPaths.mockReturnValue(sharedPaths);
    skillInstall.installFreshSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "remote_state_unknown",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    const output = error.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("did not confirm whether the skill was committed");
    expect(output).toContain(
      "Inspect /sandbox/.deepagents/agent/skills/demo-skill before retrying",
    );
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
    expect(skillInstall.postInstall).not.toHaveBeenCalled();
  });

  it("reports an upload failure and deletes the temporary SSH config (#6859)", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.uploadDirectory.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return { uploaded: 0, failed: ["SKILL.md"], skippedDotfiles: [], unsafePaths: [] };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    const output = error.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("Failed to upload 1 file(s): SKILL.md");
    expect(skillInstall.postInstall).not.toHaveBeenCalled();
    expectTempSshConfigCleanedUp(tempConfig);
  });

  it("fails skill install when the upload cannot be verified and deletes the temp SSH config", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.verifyInstall.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return false;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("verification failed"));
    expectTempSshConfigCleanedUp(tempConfig);
  });
});
