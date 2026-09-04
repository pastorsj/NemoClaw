// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock";
import {
  prepareHermesPortableSandboxRemoval,
  recoverHermesPortableSandboxLifecycle,
  stopHermesPortableSandboxLifecycle,
} from "./hermes-portable-lifecycle";
import {
  activeReceipt,
  CONTAINER_ID,
  IMAGE,
  LABELS,
  lifecycleContext,
  lifecycleDeps,
  poisonUnexpectedCommand,
  POLICY,
  SANDBOX,
  SANDBOX_ID,
  sandboxListJson,
  stateDir,
} from "./__test-helpers__/portable-fixture";

describe("Hermes portable lifecycle", () => {
  it("proves the exact stopped Podman container and OpenShell Error phase after stopping one full ID (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([
      [["container", "stop", CONTAINER_ID], 40_000],
    ]);
    expect(captureOpenShell).toHaveReturnedWith({
      status: 0,
      stdout: sandboxListJson(SANDBOX_ID, "Error"),
      stderr: "",
    });
  });

  it("accepts the exact already-stopped Podman container and OpenShell Error phase without another stop (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "already-stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("accepts the exact already-stopped Podman container and OpenShell Stopped phase (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false, {
      sandboxPhase: () => "Stopped",
    });

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "already-stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects OpenShell Stopped while the receipt-owned container is running (#9203)", () => {
    const receipt = activeReceipt();
    const beforeStop = vi.fn();
    const { deps, podman } = lifecycleDeps(receipt, true, {
      sandboxPhase: () => "Stopped",
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), beforeStop, deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell Stopped phase disagrees with the running receipt container");
    expect(beforeStop).not.toHaveBeenCalled();
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects an already-stopped container when OpenShell remains Ready (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:list"
        ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Ready"), stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects a stopped container when OpenShell remains Ready (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:list"
        ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Ready"), stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("reconciles a receipt-owned stopping state without another stop command (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);
    let inspectionCount = 0;
    podman.mockImplementation((args: readonly string[]) => {
      inspectionCount += args[1] === "inspect" ? 1 : 0;
      const status = inspectionCount < 4 ? "stopping" : "exited";
      return args[1] === "inspect"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Image: IMAGE,
                Name: receipt.container.name,
                Config: { Labels: LABELS },
                State: { Running: false, Paused: false, Status: status },
                HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
              },
            ]),
            stderr: "",
          }
        : poisonUnexpectedCommand("podman", args);
    });
    let now = 0;

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () =>
        stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), {
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("fails closed when OpenShell same-name identity changes (#9203)", () => {
    const receipt = activeReceipt();
    const { deps } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson("replacement", "Ready"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: replacement\n`,
              stderr: "",
            },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
  });

  it("fails closed when the exact OpenShell sandbox is no longer Ready (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Creating"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\n`,
              stderr: "",
            },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman).not.toHaveBeenCalled();
  });

  it.each(["Ready", "Stopped", "Error"] as const)(
    "removes one exact %s sandbox and rejects a same-name replacement on retry (#9608)",
    (phase) => {
      const receipt = activeReceipt();
      const { deps, podman } = lifecycleDeps(receipt, phase === "Ready");
      const originalPodman = podman.getMockImplementation()!;
      let sandboxPresent = true;
      let containerPresent = true;
      let replacement = false;
      const live = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${phase}\n`;
      podman.mockImplementation((args: readonly string[]) => {
        switch (args[0]) {
          case "container":
            return args[1] === "inspect" && !containerPresent
              ? { status: 125, stdout: "", stderr: "no such container" }
              : originalPodman(args);
          case "ps":
            return { status: 0, stdout: containerPresent ? `${CONTAINER_ID}\n` : "", stderr: "" };
          default:
            return originalPodman(args);
        }
      });
      deps.captureOpenShell = vi.fn((args: readonly string[]) => {
        const command = args.slice(0, 2).join(":");
        switch (command) {
          case "policy:get":
            return { status: 0, stdout: POLICY, stderr: "" };
          case "sandbox:list":
            return {
              status: 0,
              stdout: args.includes("json")
                ? sandboxPresent
                  ? sandboxListJson(SANDBOX_ID, phase)
                  : "[]"
                : live,
              stderr: "",
            };
          case "sandbox:delete":
            sandboxPresent = false;
            containerPresent = false;
            return { status: 0, stdout: "", stderr: "" };
          case "sandbox:get":
            return replacement
              ? {
                  status: 0,
                  stdout: `Name: ${SANDBOX}\nID: replacement\nPhase: Ready\n`,
                  stderr: "",
                }
              : sandboxPresent
                ? { status: 0, stdout: live, stderr: "" }
                : {
                    status: 1,
                    stdout: "",
                    stderr: `Error: sandbox '${SANDBOX}' not found`,
                  };
          default:
            return poisonUnexpectedCommand("OpenShell", args);
        }
      });

      withMcpLifecycleLockSync(
        SANDBOX,
        () => {
          const prepared = prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          });
          expect(prepared.present).toBe(true);
          prepared.removeAndVerify();
          prepared.verifyAbsent();
          expect(
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }).present,
          ).toBe(false);

          replacement = true;
          expect(() =>
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }),
          ).toThrow("OpenShell sandbox identity disagrees");
        },
        { stateDir: path.join(stateDir, "state") },
      );
      expect(
        deps.captureOpenShell.mock.calls.filter(([args]) => args[1] === "delete"),
      ).toHaveLength(1);
    },
  );

  it("rejects rendered absence text when the JSON sandbox list is malformed (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) => {
      const command = args.slice(0, 2).join(":");
      switch (command) {
        case "sandbox:get":
          return { status: 1, stdout: "", stderr: `sandbox ${SANDBOX} not found` };
        case "sandbox:list":
          return { status: 0, stdout: "warning: stale cache", stderr: "" };
        default:
          return poisonUnexpectedCommand("OpenShell", args);
      }
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("cannot prove the current OpenShell sandbox");
    expect(podman).not.toHaveBeenCalled();
  });
});
