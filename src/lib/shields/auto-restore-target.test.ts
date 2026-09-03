// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolvePersistedAutoRestoreTarget } from "./index";

describe("persisted auto-restore target resolution", () => {
  it("augments a legacy marker without agentName when registry paths still match (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json" as const,
      sensitiveFiles: ["/sandbox/.openclaw/credentials.json"],
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-openclaw",
        {
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
        },
        () => registryTarget,
      ),
    ).toEqual({
      ...registryTarget,
      sensitiveFiles: ["/sandbox/.openclaw/credentials.json", "/sandbox/.openclaw/.config-hash"],
    });
  });

  it("keeps legacy marker paths when the registry now describes another target (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json" as const,
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-target",
        {
          configPath: "/sandbox/.legacy/config.json",
          configDir: "/sandbox/.legacy/",
        },
        () => registryTarget,
      ),
    ).toEqual({
      configPath: "/sandbox/.legacy/config.json",
      configDir: "/sandbox/.legacy/",
      sensitiveFiles: ["/sandbox/.legacy/.config-hash"],
      stateLockPlanInImage: false,
    });
  });

  it("keeps a named Hermes marker when the registry agent differs at the same paths (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes/",
      configFile: "config.yaml",
      format: "yaml" as const,
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "hermes",
        {
          agentName: "hermes",
          configPath: "/sandbox/.hermes/config.yaml",
          configDir: "/sandbox/.hermes/",
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes/",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
      stateLockPlan: expect.any(Object),
      stateLockPlanInImage: true,
    });
  });

  it("keeps legacy marker paths when registry resolution throws (#8074)", () => {
    const failRegistryResolution = () => {
      throw new Error("registry unavailable");
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-target",
        {
          configPath: "/sandbox/.legacy/config.json",
          configDir: "/sandbox/.legacy/",
        },
        failRegistryResolution,
      ),
    ).toEqual({
      configPath: "/sandbox/.legacy/config.json",
      configDir: "/sandbox/.legacy/",
      sensitiveFiles: ["/sandbox/.legacy/.config-hash"],
      stateLockPlanInImage: false,
    });
  });

  it("keeps a pre-Fabric OpenClaw marker when the current registry protects another file", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json" as const,
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash", "/sandbox/.openclaw/fabric.json"],
      mutablePrivateFiles: ["/sandbox/.openclaw/fabric.json"],
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "openclaw",
        {
          agentName: "openclaw",
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
          protectedFiles: ["openclaw.json", ".config-hash"],
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "openclaw",
      configPath: registryTarget.configPath,
      configDir: registryTarget.configDir,
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
      stateLockPlan: expect.any(Object),
      stateLockPlanInImage: true,
    });
  });

  it("keeps marker mutable access when the current registry contract differs", () => {
    const registryTarget = {
      agentName: "pi",
      configPath: "/sandbox/.pi/agent/models.json",
      configDir: "/sandbox/.pi/agent",
      configFile: "models.json",
      format: "json" as const,
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash", "/sandbox/.pi/agent/fabric.json"],
      mutablePrivateFiles: [
        "/sandbox/.pi/agent/models.json",
        "/sandbox/.pi/agent/.config-hash",
        "/sandbox/.pi/agent/fabric.json",
      ],
      mutableAccess: "shared" as const,
      stateLockPlanInImage: false,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "pi",
        {
          agentName: "pi",
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
          protectedFiles: ["models.json", ".config-hash", "fabric.json"],
          mutablePrivateFiles: ["fabric.json"],
          mutableAccess: "private",
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "pi",
      configPath: registryTarget.configPath,
      configDir: registryTarget.configDir,
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash", "/sandbox/.pi/agent/fabric.json"],
      mutablePrivateFiles: ["/sandbox/.pi/agent/fabric.json"],
      mutableAccess: "private",
      stateLockPlanInImage: false,
    });
  });

  it("does not adopt registry mutable access omitted by a current marker", () => {
    const registryTarget = {
      agentName: "pi",
      configPath: "/sandbox/.pi/agent/models.json",
      configDir: "/sandbox/.pi/agent",
      configFile: "models.json",
      format: "json" as const,
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash", "/sandbox/.pi/agent/fabric.json"],
      mutableAccess: "private" as const,
      stateLockPlanInImage: false,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "pi",
        {
          agentName: "pi",
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
          protectedFiles: ["models.json", ".config-hash", "fabric.json"],
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "pi",
      configPath: registryTarget.configPath,
      configDir: registryTarget.configDir,
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash", "/sandbox/.pi/agent/fabric.json"],
      stateLockPlanInImage: false,
    });
  });

  it("does not adopt registry mutable-private files omitted by a current marker", () => {
    const registryTarget = {
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      configFile: "config.yaml",
      format: "yaml" as const,
      sensitiveFiles: [
        "/sandbox/.hermes/.config-hash",
        "/sandbox/.hermes/.env",
        "/sandbox/.hermes/fabric.json",
      ],
      mutablePrivateFiles: ["/sandbox/.hermes/fabric.json"],
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "hermes",
        {
          agentName: "hermes",
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
          protectedFiles: ["config.yaml", ".config-hash", ".env", "fabric.json"],
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "hermes",
      configPath: registryTarget.configPath,
      configDir: registryTarget.configDir,
      sensitiveFiles: registryTarget.sensitiveFiles,
      stateLockPlan: expect.any(Object),
      stateLockPlanInImage: true,
    });
  });

  it.each([
    {
      agentName: "openclaw",
      configDir: "/sandbox/.openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      protectedFiles: ["openclaw.json", ".config-hash", "fabric.json"],
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash", "/sandbox/.openclaw/fabric.json"],
      mutablePrivateFiles: ["fabric.json"],
      resolvedMutablePrivateFiles: ["/sandbox/.openclaw/fabric.json"],
      stateLockPlanAvailable: true,
      stateLockPlanInImage: true,
    },
    {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      protectedFiles: ["config.yaml", ".config-hash", ".env", "fabric.json"],
      sensitiveFiles: [
        "/sandbox/.hermes/.config-hash",
        "/sandbox/.hermes/.env",
        "/sandbox/.hermes/fabric.json",
      ],
      mutablePrivateFiles: ["fabric.json"],
      resolvedMutablePrivateFiles: ["/sandbox/.hermes/fabric.json"],
      stateLockPlanAvailable: true,
      stateLockPlanInImage: true,
    },
    {
      agentName: "pi",
      configDir: "/sandbox/.pi/agent",
      configPath: "/sandbox/.pi/agent/models.json",
      protectedFiles: ["models.json", ".config-hash", "fabric.json"],
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash", "/sandbox/.pi/agent/fabric.json"],
      mutablePrivateFiles: ["models.json", ".config-hash", "fabric.json"],
      resolvedMutablePrivateFiles: [
        "/sandbox/.pi/agent/models.json",
        "/sandbox/.pi/agent/.config-hash",
        "/sandbox/.pi/agent/fabric.json",
      ],
      mutableAccess: "private" as const,
      stateLockPlanAvailable: false,
      stateLockPlanInImage: false,
    },
    {
      agentName: "langchain-deepagents-code",
      configDir: "/sandbox/.deepagents",
      configPath: "/sandbox/.deepagents/config.toml",
      protectedFiles: ["config.toml", ".config-hash", "fabric.json"],
      sensitiveFiles: ["/sandbox/.deepagents/.config-hash", "/sandbox/.deepagents/fabric.json"],
      mutablePrivateFiles: ["config.toml", ".config-hash", "fabric.json"],
      resolvedMutablePrivateFiles: [
        "/sandbox/.deepagents/config.toml",
        "/sandbox/.deepagents/.config-hash",
        "/sandbox/.deepagents/fabric.json",
      ],
      mutableAccess: "private" as const,
      stateLockPlanAvailable: true,
      stateLockPlanInImage: false,
    },
  ])(
    "reconstructs $agentName protected files when registry resolution fails",
    ({
      agentName,
      configDir,
      configPath,
      protectedFiles,
      sensitiveFiles,
      mutablePrivateFiles,
      resolvedMutablePrivateFiles,
      mutableAccess,
      stateLockPlanAvailable,
      stateLockPlanInImage,
    }) => {
      expect(
        resolvePersistedAutoRestoreTarget(
          agentName,
          {
            agentName,
            configDir,
            configPath,
            protectedFiles,
            mutablePrivateFiles,
            ...(mutableAccess ? { mutableAccess } : {}),
          },
          () => {
            throw new Error("registry unavailable");
          },
        ),
      ).toEqual({
        agentName,
        configDir,
        configPath,
        sensitiveFiles,
        mutablePrivateFiles: resolvedMutablePrivateFiles,
        ...(mutableAccess ? { mutableAccess } : {}),
        ...(stateLockPlanAvailable ? { stateLockPlan: expect.any(Object) } : {}),
        stateLockPlanInImage,
      });
    },
  );

  it("reconstructs protected files while withholding state mutation for a removed definition", () => {
    expect(
      resolvePersistedAutoRestoreTarget(
        "removed-agent",
        {
          agentName: "removed-agent",
          configDir: "/sandbox/.removed-agent",
          configPath: "/sandbox/.removed-agent/config.json",
          protectedFiles: ["config.json", ".config-hash", "fabric.json"],
          mutableAccess: "shared",
        },
        () => {
          throw new Error("registry unavailable");
        },
      ),
    ).toEqual({
      agentName: "removed-agent",
      configDir: "/sandbox/.removed-agent",
      configPath: "/sandbox/.removed-agent/config.json",
      sensitiveFiles: [
        "/sandbox/.removed-agent/.config-hash",
        "/sandbox/.removed-agent/fabric.json",
      ],
      mutableAccess: "shared",
      stateLockPlanInImage: false,
    });
  });

  it("fails safely when direct fallback input contains an unsafe protected path", () => {
    expect(
      resolvePersistedAutoRestoreTarget(
        "unsafe-agent",
        {
          agentName: "unsafe-agent",
          configDir: "/sandbox/.unsafe-agent",
          configPath: "/sandbox/.unsafe-agent/config.json",
          protectedFiles: ["config.json", "../outside.json"],
        },
        () => {
          throw new Error("registry unavailable");
        },
      ),
    ).toBeUndefined();
  });

  it("fails safely when mutable-private fallback authority leaves the protected set", () => {
    expect(
      resolvePersistedAutoRestoreTarget(
        "unsafe-agent",
        {
          agentName: "unsafe-agent",
          configDir: "/sandbox/.unsafe-agent",
          configPath: "/sandbox/.unsafe-agent/config.json",
          protectedFiles: ["config.json", ".config-hash"],
          mutablePrivateFiles: ["fabric.json"],
        },
        () => {
          throw new Error("registry unavailable");
        },
      ),
    ).toBeUndefined();
  });
});
