// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { directDockerfileCopySources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import { ROOT } from "../runner";
import {
  BUNDLED_SOURCE_MAPPING_REMOVAL_PHASE,
  listBundledHarnessSources,
  type BundledHarnessSourceDeclaration,
  type BundledHarnessSourceMapping,
} from "./bundled-source";

const EXPECTED_IDS = ["openclaw", "hermes", "langchain-deepagents-code"];
const SOURCES = listBundledHarnessSources();
const DOCKERFILES: Readonly<Record<BundledHarnessSourceDeclaration["id"], readonly string[]>> = {
  openclaw: ["Dockerfile", "Dockerfile.base"],
  hermes: ["agents/hermes/Dockerfile", "agents/hermes/Dockerfile.base"],
  "langchain-deepagents-code": [
    "agents/langchain-deepagents-code/Dockerfile",
    "agents/langchain-deepagents-code/Dockerfile.base",
  ],
};

function normalizedMappingPath(value: string): string {
  return value.replace(/\/+$/u, "");
}

function mappingCovers(mapping: BundledHarnessSourceMapping, sourcePath: string): boolean {
  const mapped = normalizedMappingPath(mapping.sourcePath);
  const source = normalizedMappingPath(sourcePath);
  return (
    source === mapped ||
    (mapping.sourceType === "tree" &&
      (source.startsWith(`${mapped}/`) || source.startsWith(`${mapped}/*`)))
  );
}

function readManifest(source: BundledHarnessSourceDeclaration): Record<string, unknown> {
  return parse(fs.readFileSync(path.join(ROOT, source.manifestPath), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("reviewed bundled harness sources", () => {
  it("contains exactly the accepted standard harnesses in compatibility order", () => {
    expect(SOURCES.map(({ id }) => id)).toEqual(EXPECTED_IDS);
    expect(Object.isFrozen(SOURCES)).toBe(true);
    expect(SOURCES.every(({ mappings }) => Object.isFrozen(mappings))).toBe(true);
    expect(
      SOURCES.flatMap(({ mappings }) => mappings.map(({ sourcePath }) => sourcePath)),
    ).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^agents\/(?:pi|nemocua)(?:\/|$)/u)]),
    );
  });

  it.each(SOURCES)("keeps $id adapter and runtime versions independent", (source) => {
    const manifest = readManifest(source);
    expect(source.packageVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/u);
    expect(source.packageVersion).not.toBe(manifest.expected_version);
    expect(source.manifestPath).toBe(`agents/${source.id}/manifest.yaml`);
    expect(source.displayName).toBe(manifest.display_name);
  });

  it.each(SOURCES)("covers every $id Dockerfile COPY source", (source) => {
    const requiredPaths = DOCKERFILES[source.id].flatMap((dockerfile) => [
      dockerfile,
      ...directDockerfileCopySources(path.join(ROOT, dockerfile), dockerfile).map(
        ({ source: sourcePath }) => sourcePath,
      ),
    ]);
    expect(
      requiredPaths.filter(
        (requiredPath) => !source.mappings.some((mapping) => mappingCovers(mapping, requiredPath)),
      ),
    ).toEqual([]);
  });

  it.each(SOURCES)("maps $id runtime assets without unrelated roots", (source) => {
    const manifest = readManifest(source);
    const agentRoot = `agents/${source.id}`;
    const existingRuntimePaths = [
      source.manifestPath,
      ...[
        "Dockerfile",
        "Dockerfile.base",
        "start.sh",
        "policy-additions.yaml",
        "policy-permissive.yaml",
        "plugin",
      ].map((relativePath) => `${agentRoot}/${relativePath}`),
      ...Object.values((manifest._legacy_paths as Record<string, string> | undefined) ?? {}),
    ].filter((relativePath) => fs.existsSync(path.join(ROOT, relativePath)));
    expect(
      existingRuntimePaths.filter(
        (runtimePath) => !source.mappings.some((mapping) => mappingCovers(mapping, runtimePath)),
      ),
    ).toEqual([]);
    const unrelatedMappings = source.mappings
      .map(({ sourcePath }) => sourcePath)
      .filter(
        (sourcePath) =>
          /^(?:docs|test|agents\/(?:pi|nemocua))(?:\/|$)/u.test(sourcePath) ||
          (sourcePath.startsWith("packages/") &&
            !sourcePath.startsWith("packages/nemoclaw-fabric/")),
      );
    expect(unrelatedMappings).toEqual([]);
  });

  it("labels the disclosed shared blueprint dependency for Phase 3 removal", () => {
    expect(BUNDLED_SOURCE_MAPPING_REMOVAL_PHASE).toBe(3);
    expect(
      ["hermes", "langchain-deepagents-code"].map((id) =>
        SOURCES.find((candidate) => candidate.id === id)?.mappings.find(
          ({ sourcePath }) => sourcePath === "nemoclaw-blueprint",
        ),
      ),
    ).toEqual([
      {
        sourcePath: "nemoclaw-blueprint",
        destinationPath: "nemoclaw-blueprint",
        sourceType: "tree",
        role: "temporary-shared",
      },
      {
        sourcePath: "nemoclaw-blueprint",
        destinationPath: "nemoclaw-blueprint",
        sourceType: "tree",
        role: "temporary-shared",
      },
    ]);
  });

  it.each(SOURCES)("uses canonical $id destinations with only reviewed aliases", (source) => {
    const destinations = source.mappings.map(({ destinationPath }) =>
      destinationPath.normalize("NFKC").toLowerCase(),
    );
    const aliases = source.mappings.filter(
      ({ sourcePath, destinationPath }) => sourcePath !== destinationPath,
    );
    expect(aliases).toEqual(
      source.id === "openclaw"
        ? [
            {
              sourcePath: "Dockerfile",
              destinationPath: "agents/openclaw/Dockerfile",
              sourceType: "file",
              role: "legacy-layout",
            },
          ]
        : [],
    );
    expect(
      source.mappings.every(
        ({ sourcePath, destinationPath }) =>
          sourcePath === path.posix.normalize(sourcePath) &&
          destinationPath === path.posix.normalize(destinationPath),
      ),
    ).toBe(true);
    expect(
      source.mappings.some(
        ({ sourcePath, destinationPath }) =>
          path.posix.isAbsolute(sourcePath) || path.posix.isAbsolute(destinationPath),
      ),
    ).toBe(false);
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});
