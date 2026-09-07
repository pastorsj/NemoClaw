// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { validateHarnessManifest } from "@nvidia/nemoclaw-harness-contract/manifest-validator";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { validateFabricHarnessE2eContract } from "../../../../tools/e2e/fabric-contract.mts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Hermes live Fabric contract", () => {
  it("binds the generic live journey to its manifest and package-owned descriptor", () => {
    const contract = validateFabricHarnessE2eContract(
      JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, "tests/fixtures/live-contract.json"), "utf8"),
      ),
    );
    const manifest = validateHarnessManifest(
      parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")),
      contract.packageId,
    );
    const descriptor = JSON.parse(
      fs.readFileSync(
        path.join(PACKAGE_ROOT, "fabric", path.basename(contract.descriptorGlob)),
        "utf8",
      ),
    ) as { adapter_id?: unknown; runner?: { module?: unknown } };

    expect({
      contract,
      manifest: {
        name: manifest.name,
        headlessCommand: manifest.runtime.headless_command,
        promptTransport: manifest.runtime.prompt_transport,
        promptProtocol: manifest.runtime.prompt_protocol,
      },
      descriptor: {
        adapterId: descriptor.adapter_id,
        runnerModule: descriptor.runner?.module,
      },
    }).toEqual({
      contract: {
        packageId: "hermes",
        adapterId: "nvidia.nemoclaw.hermes",
        artifactRoot: "/sandbox/.hermes/fabric-artifacts",
        configPath: "/sandbox/.hermes/fabric.json",
        descriptorGlob: "/usr/local/share/nemoclaw/hermes.fabric-adapter.json",
        descriptorPathPrefix: "/usr/local/share/nemoclaw",
        descriptorRunnerModule: "nemoclaw_hermes_fabric.adapter",
        processMarkers: ["nemo_fabric_adapters.hermes"],
      },
      manifest: {
        name: "hermes",
        headlessCommand:
          "nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config /sandbox/.hermes/fabric.json",
        promptTransport: "stdin",
        promptProtocol: "fabric-cli",
      },
      descriptor: {
        adapterId: "nvidia.nemoclaw.hermes",
        runnerModule: "nemoclaw_hermes_fabric.adapter",
      },
    });
  });
});
