// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  BRAVE_PROVIDER_PROFILE_ID,
  braveProviderProfilePath,
  ensureBraveProviderProfile,
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
  shouldEnableBraveWebSearch,
  TAVILY_PROVIDER_PROFILE_ID,
  webSearchProviderProfilePath,
} from "./brave-provider-profile";

function makeDeps(runOpenshell: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    root: "/repo",
    runOpenshell,
    redact: (s: string) => s,
    log: vi.fn(),
    exit: vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }),
    ...overrides,
  } as Parameters<typeof ensureBraveProviderProfile>[1];
}

describe("ensureBraveProviderProfile", () => {
  it("imports a Hermes Tavily profile accepted by its native request path", () => {
    const runOpenshell = vi.fn((args: string[]) => {
      const profile = YAML.parse(fs.readFileSync(args[4], "utf8"));
      const credential = profile.credentials?.[0];
      const endpoint = profile.endpoints?.[0];
      const supported =
        profile.id === "tavily-hermes-v1" &&
        credential?.env_vars?.includes("TAVILY_API_KEY") &&
        credential?.required === true &&
        endpoint?.host === "api.tavily.com" &&
        endpoint?.request_body_credential_rewrite === true &&
        endpoint?.rules?.some(
          (rule: { allow?: { method?: string; path?: string } }) =>
            rule.allow?.method === "POST" && rule.allow.path === "/search",
        ) &&
        profile.binaries?.includes("/opt/hermes/.venv/bin/python");
      return supported
        ? { status: 0, stderr: "", stdout: "" }
        : { status: 2, stderr: "profile rejected", stdout: "" };
    });

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
        makeDeps(runOpenshell),
      ),
    ).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("does nothing when no token def is brave-typed", () => {
    const runOpenshell = vi.fn();
    ensureBraveProviderProfile([{ providerType: "generic", token: "tok" }], makeDeps(runOpenshell));
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does nothing when the brave token def has no token", () => {
    const runOpenshell = vi.fn();
    ensureBraveProviderProfile(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: null }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("imports the Brave profile from the blueprint path on first run", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    ensureBraveProviderProfile(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", braveProviderProfilePath("/repo")],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("imports Tavily and Brave profiles when both have tokens", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    ensureWebSearchProviderProfiles(
      [
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" },
      ],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "profile", "import", "--file", webSearchProviderProfilePath("/repo", "tavily")],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "import", "--file", braveProviderProfilePath("/repo")],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("uses a versioned Hermes profile instead of accepting a stale Tavily profile", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    ensureWebSearchProviderProfiles(
      [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
      makeDeps(runOpenshell),
    );

    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        expect.stringMatching(/nemoclaw-harness-file-.+[\\/]tavily-hermes-v1\.yaml$/u),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("imports the Hermes profile from the selected installed harness package", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    const installedPackageRoot = "/home/test/.nemoclaw/harnesses/nemoclaw-hermes";

    ensureWebSearchProviderProfiles(
      [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
      makeDeps(runOpenshell, {
        resolveHarnessPackage: vi.fn(() => ({ rootDir: installedPackageRoot })),
        withCapturedHarnessPackageTextFile: vi.fn(
          (_harnessPackage, relativePath, _maxBytes, consume) =>
            consume(path.join(installedPackageRoot, relativePath)),
        ),
      }),
    );

    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        path.join(
          installedPackageRoot,
          "provider-profiles",
          `${HERMES_TAVILY_PROVIDER_PROFILE_ID}.yaml`,
        ),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("refuses Hermes profile registration when the selected harness package is unavailable", () => {
    const runOpenshell = vi.fn();

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
        makeDeps(runOpenshell, { resolveHarnessPackage: vi.fn(() => null) }),
      ),
    ).toThrow("Hermes harness package is unavailable");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("treats an existing-profile diagnostic as success on re-onboard", () => {
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stderr: "custom provider profile 'brave' already exists",
      stdout: "",
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).not.toThrow();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("exits with the OpenShell status when import fails for a non-idempotent reason", () => {
    const runOpenshell = vi.fn(() => ({
      status: 2,
      stderr: "schema validation error: missing endpoints",
      stdout: "",
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:2/);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });
});

describe("shouldEnableBraveWebSearch", () => {
  it("returns false for null/undefined web search config", () => {
    expect(shouldEnableBraveWebSearch(null)).toBe(false);
    expect(shouldEnableBraveWebSearch(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is missing or falsy", () => {
    // Regression for #3626: a `{ fetchEnabled: false }` config previously
    // tripped `if (webSearchConfig)` in createSandbox and pushed a Brave
    // provider/token plus the BRAVE_API_KEY abort even though the runtime
    // gate downstream is `fetchEnabled`.
    expect(shouldEnableBraveWebSearch({})).toBe(false);
    expect(shouldEnableBraveWebSearch({ fetchEnabled: false })).toBe(false);
    expect(shouldEnableBraveWebSearch({ fetchEnabled: null })).toBe(false);
  });

  it("returns true only when fetchEnabled is explicitly true", () => {
    expect(shouldEnableBraveWebSearch({ fetchEnabled: true })).toBe(true);
  });
});
