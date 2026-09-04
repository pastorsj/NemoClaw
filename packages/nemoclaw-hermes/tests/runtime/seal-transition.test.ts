// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  overwriteThroughOldFd,
  readTextFileSnapshot,
  renderManagedHermesConfig,
  runGuard,
  strictHashIsValid,
} from "../helpers/config-seal.ts";

describe.skipIf(process.platform === "win32")("Hermes restart config transaction", () => {
  it("revokes pre-open writable descriptors until restart input validation finishes", () => {
    const fixture = createRestartFixture();
    const configFd = fs.openSync(fixture.configPath, "r+");
    const envFd = fs.openSync(fixture.envPath, "r+");
    const fabricFd = fs.openSync(fixture.fabricPath, "r+");
    const configBefore = fs.fstatSync(configFd);
    const envBefore = fs.fstatSync(envFd);
    const fabricBefore = fs.fstatSync(fabricFd);

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const configSealed = fs.statSync(fixture.configPath);
      const envSealed = fs.statSync(fixture.envPath);
      const fabricSealed = fs.statSync(fixture.fabricPath);
      expect(configSealed.ino).not.toBe(configBefore.ino);
      expect(envSealed.ino).not.toBe(envBefore.ino);
      expect(fabricSealed.ino).not.toBe(fabricBefore.ino);
      expect(configSealed.uid).toBe(process.getuid!());
      expect(envSealed.uid).toBe(process.getuid!());
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(mode(fixture.fabricPath)).toBe(0o444);
      expect(configSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(envSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(mode(fixture.statePath)).toBe(0o600);
      expect(strictHashIsValid(fixture)).toBe(true);

      overwriteThroughOldFd(configFd, configBefore.size, "X");
      overwriteThroughOldFd(envFd, envBefore.size, "Y");
      overwriteThroughOldFd(fabricFd, fabricBefore.size, "F");

      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
      expect(readTextFileSnapshot(fixture.envPath)).toBe(fixture.trustedEnv);
      expect(readTextFileSnapshot(fixture.fabricPath)).toBe(fixture.trustedFabric);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.statSync(fixture.configPath).ino).toBe(configSealed.ino);
      expect(fs.statSync(fixture.envPath).ino).toBe(envSealed.ino);
      expect(fs.statSync(fixture.fabricPath).ino).toBe(fabricSealed.ino);

      const unsealed = runGuard("unseal-restart", fixture);
      expect(unsealed.status, unsealed.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(mode(fixture.fabricPath)).toBe(0o600);
      expect(fs.statSync(fixture.configPath).uid).toBe(configBefore.uid);
      expect(fs.statSync(fixture.configPath).gid).toBe(configBefore.gid);
      expect(fs.statSync(fixture.envPath).uid).toBe(envBefore.uid);
      expect(fs.statSync(fixture.envPath).gid).toBe(envBefore.gid);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
      expect(readTextFileSnapshot(fixture.envPath)).toBe(fixture.trustedEnv);
      expect(readTextFileSnapshot(fixture.fabricPath)).toBe(fixture.trustedFabric);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(envFd);
      fs.closeSync(fabricFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
