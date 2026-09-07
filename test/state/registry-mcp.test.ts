// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// HOME must be set before registry is loaded because the module resolves its
// durable state path at load time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-mcp-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../../src/lib/state/registry");
const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  fs.rmSync(regFile, { force: true });
});

describe("MCP registry state", () => {
  it("persists MCP server state without local proxy secrets", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            denyTools: ["delete_*", "doordash_submit_order"],
            pendingDenyTools: ["replacement_*"],
            providerName: "alpha-mcp-github",
            providerId: "11111111-2222-4333-8444-555555555555",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    const entry = raw.sandboxes.alpha.mcp.bridges.github;

    expect(entry).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      denyTools: ["delete_*", "doordash_submit_order"],
      pendingDenyTools: ["replacement_*"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    });
    expect(entry.token).toBeUndefined();
    expect(entry.command).toBeUndefined();
    expect(entry.port).toBeUndefined();
    expect(raw.sandboxes.alpha.mcp.managedServerNames).toEqual(["github"]);
  });

  it.each([
    ["invalid selector", ["tool name"]],
    ["duplicate selector", ["delete_*", "delete_*"]],
    ["non-canonical selector order", ["doordash_submit_order", "delete_*"]],
  ])("rejects %s from durable MCP denied-tool intent (#11115)", (_label, denyTools) => {
    registry.registerSandbox({
      name: "invalid-denied-tools",
      agent: "openclaw",
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            denyTools,
            providerName: "invalid-denied-tools-mcp-github",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    expect(registry.getSandbox("invalid-denied-tools").mcp?.bridges.github).toBeUndefined();
  });

  it("persists canonical trusted-private MCP intent and exact pins (#8267)", () => {
    registry.registerSandbox({
      name: "private-mcp",
      agent: "hermes",
      mcp: {
        bridges: {
          local: {
            server: "local",
            agent: "hermes",
            adapter: "hermes-config",
            url: "https://mcp.corp.example/mcp",
            env: ["LOCAL_MCP_TOKEN"],
            trustedPrivateHost: "mcp.corp.example",
            allowedIps: ["10.20.30.40", "fd00::40"],
            providerName: "private-mcp-mcp-local",
            providerId: "11111111-2222-4333-8444-555555555555",
            policyName: "mcp-bridge-local",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    expect(registry.getSandbox("private-mcp").mcp.bridges.local).toMatchObject({
      trustedPrivateHost: "mcp.corp.example",
      allowedIps: ["10.20.30.40", "fd00::40"],
    });
  });

  it.each([
    {
      label: "non-canonical host",
      trustedPrivateHost: "MCP.CORP.EXAMPLE.",
      allowedIps: ["10.20.30.40", "fd00::40"],
    },
    {
      label: "non-canonical pin order",
      trustedPrivateHost: "mcp.corp.example",
      allowedIps: ["fd00::40", "10.20.30.40"],
    },
  ])(
    "rejects $label from durable trusted-private MCP authority (#8267)",
    ({ trustedPrivateHost, allowedIps }) => {
      registry.registerSandbox({
        name: "noncanonical-private-mcp",
        agent: "hermes",
        mcp: {
          bridges: {
            local: {
              server: "local",
              agent: "hermes",
              adapter: "hermes-config",
              url: "https://mcp.corp.example/mcp",
              env: ["LOCAL_MCP_TOKEN"],
              trustedPrivateHost,
              allowedIps,
              providerName: "noncanonical-private-mcp-mcp-local",
              providerId: "11111111-2222-4333-8444-555555555555",
              policyName: "mcp-bridge-local",
              addedAt: new Date(0).toISOString(),
            },
          },
        },
      });

      expect(registry.getSandbox("noncanonical-private-mcp").mcp?.bridges?.local).toBeUndefined();
    },
  );

  it("retains sanitized managed MCP names after the active bridge map is emptied", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "hermes",
      mcp: {
        bridges: {},
        managedServerNames: ["retired", "../invalid", "retired", "still_active"],
      },
    });

    const stored = registry.getSandbox("alpha").mcp;
    expect(stored).toEqual({
      bridges: {},
      managedServerNames: ["retired", "still_active"],
    });
    expect(JSON.parse(fs.readFileSync(regFile, "utf-8")).sandboxes.alpha.mcp).toEqual(stored);
  });

  it("normalizes MCP bridge maps by the recovered server name", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: {
          stale_key: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "alpha-mcp-github",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(raw.sandboxes.alpha.mcp.bridges.github.server).toBe("github");
    expect(raw.sandboxes.alpha.mcp.bridges.stale_key).toBeUndefined();
  });
});
