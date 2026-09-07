// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManifestRecord } from "./manifest-types";
import { readWebSearchCapability } from "./web-search";

function webSearchManifest(configPath: string): ManifestRecord {
  return {
    web_search: {
      support: "providers",
      providers: [
        {
          provider: "tavily",
          credential_env: "TAVILY_API_KEY",
          profile_type: "tavily-future",
          config_verification: {
            path: configPath,
            format: "yaml",
            assertions: [{ path: ["web", "provider"], equals: "tavily" }],
            credential_paths: [["web", "api_key"]],
          },
          egress_verification: {
            method: "POST",
            url: "https://search.example.test/query",
            parameters: [{ name: "query", value: "NVIDIA" }],
            credential: { kind: "header", name: "Authorization", prefix: "bearer" },
            result_array_path: ["results"],
          },
        },
      ],
    },
  };
}

describe("web-search config path validation", () => {
  it("accepts a canonical sandbox path", () => {
    expect(
      readWebSearchCapability(webSearchManifest("/sandbox/.future/config.yaml")),
    ).toMatchObject({ support: "providers" });
  });

  it.each([
    "/sandbox/.future/../secret",
    "/sandbox/.future\\config.yaml",
    "/sandbox/.future/config\u001b.yaml",
  ])("rejects the non-canonical sandbox path %j", (configPath) => {
    expect(() => readWebSearchCapability(webSearchManifest(configPath))).toThrow(
      /config_verification/u,
    );
  });
});
