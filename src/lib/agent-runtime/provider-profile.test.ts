// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessWebSearchProviderBinding } from "@nvidia/nemoclaw-harness-contract";

import {
  assertWebSearchVerificationMatchesProviderProfile,
  resolvePackageCredentialProviderProfile,
} from "./provider-profile";

const FIXTURE_ROOT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-provider-profile-tests",
);

const FUTURE_BINDING: HarnessWebSearchProviderBinding = {
  provider: "tavily",
  credential_env: "TAVILY_API_KEY",
  profile_type: "future-search",
  config_verification: {
    path: "/sandbox/.future/config.json",
    format: "json",
    assertions: [{ path: ["search", "enabled"], equals: true }],
    credential_paths: [["search", "apiKey"]],
  },
  egress_verification: {
    method: "POST",
    url: "https://search.example.test/query",
    parameters: [{ name: "q", value: "NVIDIA" }],
    credential: { kind: "header", name: "Authorization", prefix: "bearer" },
    result_array_path: ["payload", "items"],
  },
};

function writeProfile(host = "search.example.test"): string {
  const profileDirectory = path.join(FIXTURE_ROOT, "provider-profiles");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const profilePath = path.join(profileDirectory, "future-search.yaml");
  fs.writeFileSync(
    profilePath,
    [
      "id: future-search",
      "credentials:",
      "  - name: api_key",
      "    env_vars: [TAVILY_API_KEY]",
      "    auth_style: bearer",
      "    header_name: authorization",
      "endpoints:",
      `  - host: ${host}`,
      "    port: 443",
      "binaries: [/usr/bin/curl]",
      "",
    ].join("\n"),
  );
  return profilePath;
}

describe("receipt-selected credential provider profiles", () => {
  beforeEach(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

  it("resolves only the exact package-owned profile", () => {
    const profilePath = writeProfile();
    expect(resolvePackageCredentialProviderProfile("future-search", FIXTURE_ROOT)).toEqual({
      profileType: "future-search",
      profilePath,
    });
    expect(resolvePackageCredentialProviderProfile("another-profile", FIXTURE_ROOT)).toBeNull();
  });

  it("rejects a verification host outside the selected profile", () => {
    writeProfile("different.example.test");
    const profile = resolvePackageCredentialProviderProfile("future-search", FIXTURE_ROOT);
    expect(profile).not.toBeNull();
    expect(() =>
      assertWebSearchVerificationMatchesProviderProfile(FUTURE_BINDING, profile!),
    ).toThrow(/verification host is not declared/u);
  });

  it("rejects a symbolic-link provider profile", () => {
    const profilePath = writeProfile();
    const targetPath = path.join(FIXTURE_ROOT, "real-profile.yaml");
    fs.renameSync(profilePath, targetPath);
    fs.symlinkSync(targetPath, profilePath);

    expect(() => resolvePackageCredentialProviderProfile("future-search", FIXTURE_ROOT)).toThrow(
      /must be one regular file/u,
    );
  });

  it("rejects a symbolic-link provider profile directory", () => {
    const profilePath = writeProfile();
    const profileDirectory = path.dirname(profilePath);
    const realDirectory = path.join(FIXTURE_ROOT, "real-profiles");
    fs.renameSync(profileDirectory, realDirectory);
    fs.symlinkSync(realDirectory, profileDirectory, "dir");

    expect(() => resolvePackageCredentialProviderProfile("future-search", FIXTURE_ROOT)).toThrow(
      /must be one ordinary directory/u,
    );
  });
});
