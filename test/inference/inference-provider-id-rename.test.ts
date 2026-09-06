// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchStagedDockerfile } from "../../src/lib/onboard/dockerfile-patch";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function stageDockerfile(providerArgLine: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-id-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(
    file,
    [
      "ARG NEMOCLAW_MODEL=old",
      providerArgLine,
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
      "ARG CHAT_UI_URL=old",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
      "ARG NEMOCLAW_INFERENCE_API=old",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
      "ARG NEMOCLAW_BUILD_ID=old",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
    ].join("\n"),
    "utf-8",
  );
  return file;
}

describe("inference provider route identifier rename (#7177)", () => {
  it("patches the managed NEMOCLAW_INFERENCE_PROVIDER_ID route identifier", () => {
    const file = stageDockerfile("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=old");
    patchStagedDockerfile(
      file,
      "nvidia/nemotron-3-super-120b-a12b",
      "http://127.0.0.1:18789",
      "build-provider-id",
      "nvidia-prod",
    );
    const patched = fs.readFileSync(file, "utf-8");
    expect(patched).toContain("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference");
  });

  it("still patches the legacy NEMOCLAW_PROVIDER_KEY name during the migration window", () => {
    const file = stageDockerfile("ARG NEMOCLAW_PROVIDER_KEY=old");
    patchStagedDockerfile(
      file,
      "nvidia/nemotron-3-super-120b-a12b",
      "http://127.0.0.1:18789",
      "build-legacy",
      "nvidia-prod",
    );
    const patched = fs.readFileSync(file, "utf-8");
    expect(patched).toContain("ARG NEMOCLAW_PROVIDER_KEY=inference");
  });
});
