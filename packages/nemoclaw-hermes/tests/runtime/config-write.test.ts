// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  gatewayConfigStubRoot,
  mode,
  renderManagedHermesConfig,
  RUNTIME_CONFIG_GUARD,
  runGuard,
  runWriteConfig,
  strictHashIsValid,
  writeMutationLock,
} from "../helpers/config-seal.ts";

function runRacedFabricWrite(
  fixture: ReturnType<typeof createRestartFixture>,
  expectedDigest: string,
  content: string,
) {
  const wrapper = String.raw`
import importlib.util
import os
import sys

source, python_root, hermes_dir, hash_file, state_file, expected_digest = sys.argv[1:]
sys.path.insert(0, python_root)
spec = importlib.util.spec_from_file_location("nemoclaw_config_write_race", source)
if spec is None or spec.loader is None:
    raise SystemExit("could not load Hermes config guard")
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
real_atomic_replace = guard._atomic_replace
fabric_path = os.path.join(hermes_dir, "fabric.json")
injected = False

def raced_atomic_replace(path, data, **kwargs):
    global injected
    if path == fabric_path and b"must-roll-back" in data and not injected:
        injected = True
        os.chmod(path, 0o600)
        with open(path, "ab") as handle:
            handle.write(b"raced")
            handle.flush()
            os.fsync(handle.fileno())
        guard._atomic_replace = real_atomic_replace
    return real_atomic_replace(path, data, **kwargs)

guard._atomic_replace = raced_atomic_replace
try:
    guard.write_config_transaction(
        hermes_dir,
        hash_file,
        state_file,
        expected_digest,
        sys.stdin.buffer.read(),
    )
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)
raise SystemExit(0)
`;
  return spawnSync(
    "python3",
    [
      "-c",
      wrapper,
      RUNTIME_CONFIG_GUARD,
      gatewayConfigStubRoot(fixture.root),
      fixture.hermesDir,
      fixture.hashPath,
      fixture.statePath,
      expectedDigest,
    ],
    { encoding: "utf-8", input: content, timeout: 90_000 },
  );
}

function preFabricHashInputs(fixture: ReturnType<typeof createRestartFixture>): string {
  const configDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
  const envDigest = createHash("sha256").update(fixture.trustedEnv).digest("hex");
  const mcpDigest = createHash("sha256").update("{}").digest("hex");
  return [
    `${configDigest}  ${fixture.configPath}`,
    `${envDigest}  ${fixture.envPath}`,
    `# nemoclaw-hermes-mcp-state-v1 intended=${mcpDigest} applied=${mcpDigest}`,
    "",
  ].join("\n");
}

function replaceSealedFile(pathname: string, content: string, mode: number): void {
  const temporary = `${pathname}.pre-fabric-fixture`;
  fs.writeFileSync(temporary, content, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, pathname);
}

function inodeMetadata(pathname: string): Record<string, number> {
  const metadata = fs.statSync(pathname);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o7777,
    uid: metadata.uid,
    gid: metadata.gid,
  };
}

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
  it("atomically binds a host config write to the bytes that were read and refreshes both hashes", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const updatedConfig = renderManagedHermesConfig(
      "trusted-model-v2",
      "https://inference-next.local/v1",
    );

    try {
      const updated = runWriteConfig(fixture, expectedDigest, updatedConfig);

      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(updatedConfig);
      const fabric = JSON.parse(fs.readFileSync(fixture.fabricPath, "utf-8"));
      expect(fabric.models.default).toEqual({
        provider: "custom",
        model: "trusted-model-v2",
        api_key_env: "HERMES_FABRIC_API_KEY",
        base_url: "https://inference-next.local/v1",
      });
      expect(fabric.harness).toEqual({
        adapter_id: "nvidia.nemoclaw.hermes",
        resolution: "preinstalled",
      });
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(mode(fixture.fabricPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("projects only the non-secret route into Fabric", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const updatedConfig = `${renderManagedHermesConfig("credential-safe-model")}${[
      "platforms:",
      "  telegram:",
      "    bot_token: raw-credential-canary",
      "",
    ].join("\n")}`;

    try {
      const updated = runWriteConfig(fixture, expectedDigest, updatedConfig);

      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toContain("raw-credential-canary");
      const fabricText = fs.readFileSync(fixture.fabricPath, "utf-8");
      const fabric = JSON.parse(fabricText);
      expect(fabric.models.default.model).toBe("credential-safe-model");
      expect(fabric.models.default.api_key_env).toBe("HERMES_FABRIC_API_KEY");
      expect(fabricText).not.toContain("raw-credential-canary");
      expect(fabricText).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back native and Fabric routes when Fabric changes during the transaction", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");

    try {
      const updated = runRacedFabricWrite(
        fixture,
        expectedDigest,
        renderManagedHermesConfig("must-roll-back", "https://raced.invalid/v1"),
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("refusing raced runtime config path");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.fabricPath, "utf-8")).toBe(fixture.trustedFabric);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(strictBefore);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a managed route with credentials in its base URL before sealing", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");

    try {
      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        renderManagedHermesConfig("unsafe-route", "https://token@inference.local/v1"),
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("without credentials");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.fabricPath, "utf-8")).toBe(fixture.trustedFabric);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(strictBefore);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts exactly 16 MiB at the size guard before validating filesystem state", () => {
    const fixture = createRestartFixture();
    const configAtLimit = "a".repeat(16 * 1024 * 1024);
    fs.rmSync(fixture.root, { recursive: true, force: true });

    const updated = runWriteConfig(fixture, "0".repeat(64), configAtLimit);

    expect(updated.status).not.toBe(0);
    expect(updated.stderr).not.toContain("refusing oversized Hermes config input");
    expect(updated.stderr).toContain("No such file or directory");
  });

  it("rejects Hermes configuration input larger than 16 MiB without creating restart state", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const oversizedConfig = "a".repeat(16 * 1024 * 1024 + 1);

    try {
      const updated = runWriteConfig(fixture, expectedDigest, oversizedConfig);

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("refusing oversized Hermes config input");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to launder a stale host read and leaves the trusted config unchanged", () => {
    const fixture = createRestartFixture();
    const staleDigest = createHash("sha256").update("attacker-controlled read\n").digest("hex");

    try {
      const updated = runWriteConfig(
        fixture,
        staleDigest,
        renderManagedHermesConfig("attacker-derived-model"),
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config changed after the host read");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes restart sealing against a host-held config mutation lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o770);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a dead mutation lock published before seal state creation", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    try {
      const lockPath = writeMutationLock(fixture, token);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      const recovered = spawnSync(
        "python3",
        [
          RUNTIME_CONFIG_GUARD,
          "recover-prestate-lock",
          "--hermes-dir",
          fixture.hermesDir,
          "--state-file",
          fixture.statePath,
          "--startup-owner",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout.trim()).toBe("recovered=1");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a host config transaction while another Hermes mutation owns the lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        renderManagedHermesConfig("should-not-commit"),
      );
      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back a config-write phase killed after rename but before strict hash refresh", () => {
    const fixture = createRestartFixture();

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      state.phase = "config-write-prepared";
      state.config_write = {
        original_config_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
        original_fabric_sha256: createHash("sha256").update(fixture.trustedFabric).digest("hex"),
      };
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(fixture.statePath, 0o600);

      const replacement = path.join(fixture.hermesDir, ".config.crash-test");
      fs.writeFileSync(replacement, renderManagedHermesConfig("interrupted-write"), {
        mode: 0o444,
      });
      fs.chmodSync(replacement, 0o444);
      fs.renameSync(replacement, fixture.configPath);
      const fabricReplacement = path.join(fixture.hermesDir, ".fabric.crash-test");
      const interruptedFabric = JSON.parse(fixture.trustedFabric);
      interruptedFabric.models.default.model = "interrupted-write";
      fs.writeFileSync(fabricReplacement, `${JSON.stringify(interruptedFabric, null, 2)}\n`, {
        mode: 0o444,
      });
      fs.chmodSync(fabricReplacement, 0o444);
      fs.renameSync(fabricReplacement, fixture.fabricPath);
      expect(strictHashIsValid(fixture)).toBe(false);

      const recovered = runGuard("unseal-restart", fixture);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.fabricPath, "utf-8")).toBe(fixture.trustedFabric);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.fabricPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed with restore guidance for an exact pre-Fabric prepared journal", () => {
    const fixture = createRestartFixture();
    const credentialCanary = "raw-pre-fabric-recovery-credential";

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const legacyHash = preFabricHashInputs(fixture);
      fs.writeFileSync(fixture.hashPath, legacyHash, { mode: 0o600 });
      replaceSealedFile(fixture.compatHashPath, legacyHash, 0o444);

      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      state.phase = "config-write-prepared";
      state.config_write = {
        original_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
      };
      delete state.files["fabric.json"];
      state.files[".config-hash"].trusted_base64 = Buffer.from(legacyHash).toString("base64");
      state.files[".config-hash"].sealed = inodeMetadata(fixture.compatHashPath);
      expect(Object.keys(state.files).sort()).toEqual([".config-hash", ".env", "config.yaml"]);
      expect(state.config_write).toEqual({
        original_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
      });
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(fixture.statePath, 0o600);

      replaceSealedFile(
        fixture.configPath,
        renderManagedHermesConfig("interrupted-pre-fabric-write"),
        0o444,
      );
      replaceSealedFile(
        fixture.fabricPath,
        `${JSON.stringify({ credential: credentialCanary, model: "untrusted" })}\n`,
        0o444,
      );

      const recovered = runGuard("unseal-restart", fixture);
      expect(recovered.status).not.toBe(0);
      expect(recovered.stderr).toContain("restore a trusted backup or rebuild the sandbox");
      expect(recovered.stderr).not.toContain(credentialCanary);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toContain(
        "interrupted-pre-fabric-write",
      );
      expect(fs.readFileSync(fixture.fabricPath, "utf-8")).toContain(credentialCanary);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(legacyHash);
      expect(fs.readFileSync(fixture.compatHashPath, "utf-8")).toBe(legacyHash);
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
