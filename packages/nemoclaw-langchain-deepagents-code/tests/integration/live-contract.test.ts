// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { validateHarnessManifest } from "@nvidia/nemoclaw-harness-contract/manifest-validator";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { validateFabricHarnessE2eContract } from "../../../../tools/e2e/fabric-contract.mts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Deep Agents Code live Fabric contract", () => {
  it("binds the generic live journey to its manifest and Fabric-owned descriptor", () => {
    const contract = validateFabricHarnessE2eContract(
      JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, "tests/fixtures/live-contract.json"), "utf8"),
      ),
    );
    const manifest = validateHarnessManifest(
      parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")),
      contract.packageId,
    );

    expect({
      contract,
      manifest: {
        name: manifest.name,
        headlessCommand: manifest.runtime.headless_command,
        promptTransport: manifest.runtime.prompt_transport,
        promptProtocol: manifest.runtime.prompt_protocol,
      },
      ownsDescriptor: fs.existsSync(
        path.join(PACKAGE_ROOT, "fabric", path.basename(contract.descriptorGlob)),
      ),
    }).toEqual({
      contract: {
        packageId: "langchain-deepagents-code",
        adapterId: "nvidia.fabric.langchain.deepagents",
        artifactRoot: "/sandbox/.deepagents/fabric-artifacts",
        configPath: "/sandbox/.deepagents/fabric.json",
        descriptorGlob:
          "/opt/nemoclaw-fabric-venv/share/nemo-fabric/adapters/deepagents/deepagents.fabric-adapter.json",
        descriptorPathPrefix: "/opt/nemoclaw-fabric-venv/share/nemo-fabric",
        descriptorRunnerModule: "nemo_fabric_adapters.deepagents.adapter",
      },
      manifest: {
        name: "langchain-deepagents-code",
        headlessCommand:
          "nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config /sandbox/.deepagents/fabric.json",
        promptTransport: "stdin",
        promptProtocol: "fabric-cli",
      },
      ownsDescriptor: false,
    });
  });
});
