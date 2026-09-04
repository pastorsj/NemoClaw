// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import { fingerprintOpenShellSandboxLiveIdentity } from "../../../adapters/openshell/sandbox-identity";
import type { HermesPortableOpenShellExecutableAuthority } from "../../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthorityDeps, PodmanExecutableStat } from "../../../adapters/podman";
import type { SandboxEntry } from "../../../state/registry";
import { currentHermesPortableAgentDefinition } from "../../docker-startup-command-env";
import { hermesPortableContainerInternals } from "../hermes-portable-container";
import { resolveHermesPortableStartupContract } from "../hermes-portable-contract";
import { hermesPortableLifecycleInternals } from "../hermes-portable-lifecycle";
import type { HermesPortablePodmanExecutableAuthority } from "../hermes-portable-podman-authority";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "../hermes-portable-receipt";

export const SANDBOX = "alpha";
export const GATEWAY = "nemoclaw";
export const GENERATION = "generation-1";
export const CONTAINER_ID = "a".repeat(64);
export const IMAGE = "b".repeat(64);
export const SANDBOX_ID = "sandbox-id-1";
export const POLICY = "version: 1\nnetwork_policies: {}\n";
const LIVE = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: Ready\n`;
export const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": SANDBOX,
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

export function sandboxListJson(sandboxId: string, phase: string): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: SANDBOX,
      labels: {},
      resource_version: 1,
      created_at: "2026-01-01T00:00:00Z",
      phase,
      current_policy_version: 1,
    },
  ]);
}

export let stateDir: string;
let policyPath: string;

function startupArgv() {
  return [
    "env",
    "HERMES_BUNDLED_PLUGINS=/opt/hermes/plugins",
    "HERMES_HOME=/sandbox/.hermes",
    "HERMES_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

export function poisonUnexpectedCommand(scope: string, args: readonly string[]): never {
  throw new Error(`unexpected ${scope} command: ${args.join(" ")}`);
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function openshellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.106",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

export function podmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: String(bytes.byteLength),
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

export function podmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  const stat = (filePath: string): PodmanExecutableStat => ({
    dev: 1n,
    ino:
      filePath === "/usr/bin/podman"
        ? 30n
        : filePath === "/usr/bin"
          ? 40n
          : filePath === "/usr"
            ? 41n
            : 42n,
    mode: filePath === "/usr/bin/podman" ? 0o100755n : 0o40755n,
    uid: 0n,
    size: filePath === "/usr/bin/podman" ? BigInt(bytes.byteLength) : 0n,
    mtimeNs: 31n,
    ctimeNs: 32n,
    isDirectory: () => filePath !== "/usr/bin/podman",
    isFile: () => filePath === "/usr/bin/podman",
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: stat,
    readFile: () => bytes,
    realpath: (filePath) => filePath,
  };
}

export function activeReceipt(homeDir = "/home/test"): HermesPortableConfiguredReceipt {
  const uid = process.getuid!();
  const socketPath = `/run/user/${String(uid)}/podman/podman.sock`;
  const transactionId = randomUUID();
  const policy = publishHermesPortableDurablePolicySource({
    sandboxName: SANDBOX,
    transactionId,
    stateDir,
    source: captureHermesPortablePolicySource(policyPath),
    hooks: { assertLifecycleLock: () => undefined },
  });
  const pending: HermesPortablePendingReceipt = {
    schemaVersion: 7,
    agent: "hermes",
    phase: "pending",
    transactionId,
    createIntentSha256: "c".repeat(64),
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir,
      configHome: path.join(homeDir, ".config"),
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath,
    },
    openshellExecutableAuthority: openshellExecutableAuthority(),
    podmanExecutableAuthority: podmanExecutableAuthority(),
    socketAuthority: {
      device: "1",
      inode: "2",
      mode: String(0o140600),
      ownerUid: String(uid),
      socketPath,
      directoryChain: directoryChain(path.dirname(socketPath)).map((directory, index) => ({
        device: "1",
        inode: String(index + 3),
        mode: String(index === 0 ? 0o40700 : 0o40755),
        ownerUid: String(index === 0 ? uid : 0),
        path: directory,
      })),
    },
    startup: resolveHermesPortableStartupContract({
      agent: currentHermesPortableAgentDefinition(),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    }),
    policy,
  };
  const first = publishHermesPortableLifecycleReceipt(pending, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const { policy: _policy, ...transaction } = pending;
  const configuring: HermesPortableConfiguredReceipt = {
    ...transaction,
    phase: "configuring",
    previousPhaseSha256: first.sha256,
    container: {
      containerId: CONTAINER_ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${IMAGE}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(LABELS),
      name: `openshell-default--${SANDBOX}-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    },
  };
  const second = publishHermesPortableLifecycleReceipt(configuring, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const active: HermesPortableConfiguredReceipt = {
    ...configuring,
    phase: "active",
    previousPhaseSha256: second.sha256,
    container: { ...configuring.container, restartPolicy: "unless-stopped" },
  };
  publishHermesPortableLifecycleReceipt(active, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  return active;
}

export function lifecycleDeps(
  receipt: HermesPortableConfiguredReceipt,
  initiallyRunning = true,
  options: {
    readonly livePolicy?: string;
    readonly registry?: Partial<SandboxEntry>;
    readonly sandboxPhase?: (running: boolean) => string;
    readonly failPostStartInspectOnce?: boolean;
  } = {},
) {
  let running = initiallyRunning;
  let postStartInspectFailurePending = false;
  const sandboxPhase = () => options.sandboxPhase?.(running) ?? (running ? "Ready" : "Error");
  const podman = vi.fn((args: readonly string[]) => {
    const actions = {
      inspect: () => {
        const failThisInspection = postStartInspectFailurePending;
        postStartInspectFailurePending = false;
        return failThisInspection
          ? { status: 1, stdout: "", stderr: "post-start inspection failed" }
          : {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: CONTAINER_ID,
                  Image: IMAGE,
                  Name: receipt.container.name,
                  Config: { Labels: LABELS },
                  State: {
                    Running: running,
                    Paused: false,
                    Status: running ? "running" : "exited",
                  },
                  HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
                },
              ]),
              stderr: "",
            };
      },
      exec: () => ({ status: 0, stdout: "200\n", stderr: "" }),
      start: () => {
        running = true;
        postStartInspectFailurePending = options.failPostStartInspectOnce === true;
        return { status: 0, stdout: "", stderr: "" };
      },
      stop: () => {
        running = false;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const action = actions[args[1] as keyof typeof actions];
    return action?.() ?? poisonUnexpectedCommand("podman", args);
  });
  const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(LIVE)!;
  const captureOpenShell = vi.fn((args: readonly string[]) => {
    const sandboxExecOutput = args.includes(hermesPortableLifecycleInternals.healthWaitProgram)
      ? "schema=1 result=ready attempts=1 notReady=0 timeouts=0 errors=0 lastFailure=none probeMs=0 sleepMs=0\n"
      : args.includes("python3")
        ? "200\n"
        : "";
    const responses = {
      "policy:get": { status: 0, stdout: options.livePolicy ?? POLICY, stderr: "" },
      "sandbox:list": {
        status: 0,
        stdout: sandboxListJson(SANDBOX_ID, sandboxPhase()),
        stderr: "",
      },
      "sandbox:get": {
        status: 0,
        stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${sandboxPhase()}\n`,
        stderr: "",
      },
      "sandbox:exec": { status: 0, stdout: sandboxExecOutput, stderr: "" },
    };
    return (
      responses[args.slice(0, 2).join(":") as keyof typeof responses] ??
      poisonUnexpectedCommand("OpenShell", args)
    );
  });
  const launchOpenShell = vi.fn();
  const captureSocketAuthority = vi.fn(() => ({ ...receipt.socketAuthority, inode: "102" }));
  const captureOpenShellExecutableAuthority = vi.fn(() => receipt.openshellExecutableAuthority);
  const capturePodmanExecutableAuthority = vi.fn(() => receipt.podmanExecutableAuthority);
  const assertOpenShellExecutableAuthority = vi.fn(() => "/usr/bin/openshell");
  const assertOpenShellExecutableFileAuthority = vi.fn(() => "/usr/bin/openshell");
  const capturePodmanExecutableFileAuthority = vi.fn(() => receipt.podmanExecutableAuthority);
  return {
    deps: {
      stateDir,
      env: {
        HOME: receipt.runtimeAuthority.homeDir,
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
        XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
      },
      readRegistry: () =>
        ({
          name: SANDBOX,
          agent: "hermes",
          openshellDriver: "docker",
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
          openshellVersion: "0.0.106",
          ...options.registry,
        }) as SandboxEntry,
      captureOpenShell,
      launchOpenShell,
      assertOpenShellExecutableAuthority,
      operatingAuthority: {
        env: {
          HOME: receipt.runtimeAuthority.homeDir,
          PATH: "/usr/bin",
          XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
        },
        captureSocketAuthority,
        captureOpenShellExecutableAuthority,
        capturePodmanExecutableAuthority,
        assertOpenShellExecutableFileAuthority,
        capturePodmanExecutableFileAuthority,
      },
      container: { podman, assertSocketAuthority: vi.fn() },
      sleep: vi.fn(),
    },
    podman,
    captureOpenShell,
    launchOpenShell,
    captureSocketAuthority,
    captureOpenShellExecutableAuthority,
    capturePodmanExecutableAuthority,
    assertOpenShellExecutableAuthority,
    assertOpenShellExecutableFileAuthority,
    capturePodmanExecutableFileAuthority,
  };
}

export function lifecycleContext() {
  return {
    agent: "hermes",
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    openshellDriver: "docker",
    provider: "ollama",
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lifecycle-"));
  policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
