// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions/sandbox/authority/package", () => ({
  readPublishedSandboxAuthority: vi.fn(),
  resolveLifecycleEligibleSandboxAgent: vi.fn(),
}));
vi.mock("../gateway-runtime-action", () => ({
  resolveGatewayPortFromName: vi.fn((name: string) =>
    name === "nemoclaw" ? 8080 : Number(name.slice("nemoclaw-".length)),
  ),
  resolveSandboxGatewayName: vi.fn(() => "nemoclaw"),
}));

import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { AgentTurnEvent } from "./contracts";
import {
  readPublishedSandboxAuthority,
  resolveLifecycleEligibleSandboxAgent,
} from "../actions/sandbox/authority/package";
import {
  createSandboxSemanticTurnClient,
  resolveSandboxSemanticTurnAuthority,
  SandboxSemanticTurnClient,
  type SemanticTurnChild,
  type SemanticTurnSpawner,
} from "./semantic-turn";
import { semanticTurnBinding } from "./sandbox-authority";

const PACKAGE_IDENTITY: HarnessPackageIdentity = Object.freeze({
  kind: "agent-runtime",
  id: "example-runtime",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
});

const DECLARATION = Object.freeze({
  support: "managed" as const,
  command: Object.freeze(["/usr/local/bin/example-semantic-turn"]),
  timeout_seconds: 120,
  protocol: "semantic-turn-ndjson" as const,
});

function authority(gatewayName = "nemoclaw") {
  return {
    sandboxName: "demo-sandbox",
    packageIdentity: PACKAGE_IDENTITY,
    declaration: DECLARATION,
    gatewayName,
    gatewayPort: gatewayName === "nemoclaw" ? 8080 : Number(gatewayName.slice(9)),
    lifecycleGeneration: "generation-one",
    lifecycleLiveIdentityFingerprint: "b".repeat(64),
  } as const;
}

class FakeReadable extends EventEmitter {}

class FakeWritable extends EventEmitter {
  input = "";

  end(input: string): void {
    this.input = input;
  }
}

class FakeChild extends EventEmitter {
  readonly stderr = new FakeReadable();
  readonly stdout = new FakeReadable();
  readonly stdin = new FakeWritable();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  finish(exitCode: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode;
    this.signalCode = signal;
    this.emit("close", exitCode, signal);
  }
}

function createClient(
  child: FakeChild,
  overrides: {
    readonly confirmIdentity?: HarnessPackageIdentity;
    readonly maxStreamBytes?: number;
  } = {},
): {
  readonly client: SandboxSemanticTurnClient;
  readonly spawnChild: ReturnType<typeof vi.fn<SemanticTurnSpawner>>;
} {
  const spawnChild = vi.fn<SemanticTurnSpawner>(() => child as unknown as SemanticTurnChild);
  return {
    client: new SandboxSemanticTurnClient({
      sandboxName: "demo-sandbox",
      declaration: DECLARATION,
      packageIdentity: PACKAGE_IDENTITY,
      confirmAuthority: () => ({
        ...authority(),
        packageIdentity: overrides.confirmIdentity ?? PACKAGE_IDENTITY,
      }),
      gatewayName: null,
      resolveOpenShell: () => "/usr/local/bin/openshell",
      spawnChild,
      ...(overrides.maxStreamBytes === undefined
        ? {}
        : { maxStreamBytes: overrides.maxStreamBytes }),
    }),
    spawnChild,
  };
}

function createProcessBackedFactoryClient(child: FakeChild) {
  const lockEvents: string[] = [];
  const spawnChild = vi.fn<SemanticTurnSpawner>(() => child as unknown as SemanticTurnChild);
  const client = createSandboxSemanticTurnClient("demo-sandbox", {
    expectedAuthority: semanticTurnBinding(authority()),
    resolveAuthority: () => authority(),
    createClient: (options) =>
      new SandboxSemanticTurnClient({
        ...options,
        resolveOpenShell: () => "/usr/local/bin/openshell",
        spawnChild,
      }),
    withSandboxLock: async (_sandboxName, operation) => {
      lockEvents.push("lock-started");
      const result = await operation();
      lockEvents.push("lock-ended");
      return result;
    },
  });
  return { client, lockEvents, spawnChild };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("sandbox semantic-turn client", () => {
  it("rejects an unpublished sandbox registration before package resolution", () => {
    vi.mocked(readPublishedSandboxAuthority).mockReturnValue(null);

    expect(() => resolveSandboxSemanticTurnAuthority("demo-sandbox")).toThrow(
      "Published sandbox registration is unavailable",
    );
    expect(resolveLifecycleEligibleSandboxAgent).not.toHaveBeenCalled();
  });

  it("delivers one private turn and accepts the finite event sequence", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "host-secret-must-not-cross");
    const child = new FakeChild();
    const { client, spawnChild } = createClient(child);
    const events: unknown[] = [];

    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: (event) => events.push(event),
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      [
        "sandbox",
        "exec",
        "--name",
        "demo-sandbox",
        "--no-tty",
        "--timeout",
        "120",
        "--",
        "/usr/local/bin/example-semantic-turn",
      ],
      { env: expect.not.objectContaining({ NVIDIA_INFERENCE_API_KEY: expect.anything() }) },
    );
    expect(JSON.parse(child.stdin.input) as unknown).toEqual({
      type: "turn",
      message: "summarize the repository",
      conversationKey: "runtime:session",
      runtimeTarget: "primary",
      idempotencyKey: "turn-identifier",
    });

    child.stdout.emit("data", '{"type":"started"}\n');
    child.stdout.emit("data", '{"type":"text","text":"ready"}\n');
    child.stdout.emit("data", '{"type":"completed"}\n');
    child.finish();

    await expect(turn).resolves.toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "ready" }]);
  });

  it("rejects native fields that cross the finite event boundary", async () => {
    const child = new FakeChild();
    const { client } = createClient(child);
    const events: unknown[] = [];
    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: (event) => events.push(event),
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    child.stdout.emit("data", '{"type":"started"}\n');
    child.stdout.emit("data", '{"type":"completed","nativeRunId":"must-not-cross"}\n');
    child.finish(null, "SIGTERM");

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_protocol_error",
    });
    expect(events).toEqual([{ type: "started" }]);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("rejects output that exceeds the shared stream budget", async () => {
    const child = new FakeChild();
    const { client } = createClient(child, { maxStreamBytes: 16 });
    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    child.stdout.emit("data", '{"type":"started"}\n');
    child.finish(null, "SIGTERM");

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "response_too_large",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("preserves a terminal failure that occurs before native work starts", async () => {
    const child = new FakeChild();
    const { client } = createClient(child);
    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    child.stdout.emit("data", '{"type":"failed","reason":"agent_gateway_unavailable"}\n');
    child.finish();

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
  });

  it("stops an active command when its session closes", async () => {
    const child = new FakeChild();
    const { client } = createClient(child);
    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    client.close();
    child.finish(null, "SIGTERM");

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    await expect(
      client.runTurn({
        conversationKey: "runtime:session",
        idempotencyKey: "another-turn",
        message: "try again",
        onEvent: () => {},
        runtimeTarget: "primary",
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
  });

  it("refuses a concurrent turn while one command is active", async () => {
    const child = new FakeChild();
    const { client, spawnChild } = createClient(child);
    const first = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "first-turn",
      message: "first request",
      onEvent: () => {},
      runtimeTarget: "primary",
    });
    await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

    await expect(
      client.runTurn({
        conversationKey: "runtime:session",
        idempotencyKey: "second-turn",
        message: "second request",
        onEvent: () => {},
        runtimeTarget: "primary",
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
    expect(spawnChild).toHaveBeenCalledTimes(1);

    child.stdout.emit("data", '{"type":"started"}\n{"type":"completed"}\n');
    child.finish();
    await expect(first).resolves.toEqual({ outcome: "completed" });
  });

  it.each([
    {
      throwingEvent: "started",
      output: '{"type":"started"}\n',
      onEvent: () => {
        throw new Error("delivery failed");
      },
    },
    {
      throwingEvent: "text",
      output: '{"type":"started"}\n{"type":"text","text":"ready"}\n',
      onEvent: (event: AgentTurnEvent) => {
        const handlers: Record<AgentTurnEvent["type"], () => void> = {
          started: () => {},
          text: () => {
            throw new Error("delivery failed");
          },
        };
        handlers[event.type]();
      },
    },
  ])(
    "keeps the turn and sandbox lock active until the child closes after a $throwingEvent callback throws",
    async ({ onEvent, output }) => {
      const child = new FakeChild();
      const { client, lockEvents, spawnChild } = createProcessBackedFactoryClient(child);
      let settled = false;
      const turn = client.runTurn({
        conversationKey: "runtime:session",
        idempotencyKey: "turn-identifier",
        message: "summarize the repository",
        onEvent,
        runtimeTarget: "primary",
      });
      const observedTurn = turn.then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(child.stdin.input).not.toBe(""));

      child.stdout.emit("data", output);
      await Promise.resolve();

      expect(child.signals).toEqual(["SIGTERM"]);
      expect(settled).toBe(false);
      expect(lockEvents).toEqual(["lock-started"]);
      await expect(
        client.runTurn({
          conversationKey: "runtime:session",
          idempotencyKey: "concurrent-turn",
          message: "try again",
          onEvent: () => {},
          runtimeTarget: "primary",
        }),
      ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
      expect(spawnChild).toHaveBeenCalledTimes(1);

      child.finish(null, "SIGTERM");

      await expect(observedTurn).resolves.toEqual({
        outcome: "failed",
        reason: "agent_protocol_error",
      });
      expect(lockEvents).toEqual(["lock-started", "lock-ended"]);
    },
  );

  it("sends SIGKILL after the termination grace period without releasing the turn or lock", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { client, lockEvents } = createProcessBackedFactoryClient(child);
    let settled = false;
    const turn = client.runTurn({
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    });
    const observedTurn = turn.then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(child.stdin.input).not.toBe("");
    expect(lockEvents).toEqual(["lock-started"]);
    client.close();
    expect(child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    expect(lockEvents).toEqual(["lock-started"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);
    expect(lockEvents).toEqual(["lock-started"]);

    child.finish(null, "SIGKILL");

    await expect(observedTurn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
    expect(lockEvents).toEqual(["lock-started", "lock-ended"]);
  });

  it("refuses execution when the package receipt changes", async () => {
    const child = new FakeChild();
    const { client, spawnChild } = createClient(child, {
      confirmIdentity: { ...PACKAGE_IDENTITY, contentDigest: "b".repeat(64) },
    });

    await expect(
      client.runTurn({
        conversationKey: "runtime:session",
        idempotencyKey: "turn-identifier",
        message: "summarize the repository",
        onEvent: () => {},
        runtimeTarget: "primary",
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("uses the gateway from the same freshly revalidated sandbox authority", async () => {
    let gatewayName = "nemoclaw-19080";
    const children = [new FakeChild(), new FakeChild()];
    let childIndex = 0;
    const spawnChild = vi.fn<SemanticTurnSpawner>(
      () => children[childIndex++] as unknown as SemanticTurnChild,
    );
    const client = new SandboxSemanticTurnClient({
      sandboxName: "demo-sandbox",
      declaration: DECLARATION,
      packageIdentity: PACKAGE_IDENTITY,
      confirmAuthority: () => authority(gatewayName),
      resolveOpenShell: () => "/usr/local/bin/openshell",
      spawnChild,
    });
    const request = {
      conversationKey: "runtime:session",
      idempotencyKey: "turn-identifier",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    };

    const first = client.runTurn(request);
    await vi.waitFor(() => expect(children[0].stdin.input).not.toBe(""));
    expect(spawnChild.mock.calls[0]?.[1]).toContain("nemoclaw-19080");
    children[0].stdout.emit("data", '{"type":"started"}\n{"type":"completed"}\n');
    children[0].finish();
    await expect(first).resolves.toEqual({ outcome: "completed" });

    gatewayName = "nemoclaw-19081";
    const second = client.runTurn({ ...request, idempotencyKey: "second-turn" });
    await vi.waitFor(() => expect(children[1].stdin.input).not.toBe(""));
    expect(spawnChild.mock.calls[1]?.[1]).toContain("nemoclaw-19081");
    children[1].stdout.emit("data", '{"type":"started"}\n{"type":"completed"}\n');
    children[1].finish();
    await expect(second).resolves.toEqual({ outcome: "completed" });
  });

  it("serializes and cancels turns at the public client factory boundary", async () => {
    const lockEvents: string[] = [];
    let finishTurn: ((result: { readonly outcome: "completed" }) => void) | undefined;
    const delegate: import("./contracts").AgentTurnClient = {
      close: vi.fn(() => finishTurn?.({ outcome: "completed" })),
      runTurn: vi.fn(
        () =>
          new Promise<{ readonly outcome: "completed" }>((resolve) => {
            finishTurn = resolve;
          }),
      ),
    };
    const createDelegate = vi.fn(() => delegate);
    const client = createSandboxSemanticTurnClient("demo-sandbox", {
      resolveAuthority: () => ({
        ...authority(),
      }),
      createClient: createDelegate,
      withSandboxLock: async (_sandboxName, operation) => {
        lockEvents.push("lock-started");
        const result = await operation();
        lockEvents.push("lock-ended");
        return result;
      },
    });
    const request = {
      conversationKey: "runtime:session",
      idempotencyKey: "first-turn",
      message: "summarize the repository",
      onEvent: () => {},
      runtimeTarget: "primary",
    };

    const first = client.runTurn(request);
    await vi.waitFor(() => expect(delegate.runTurn).toHaveBeenCalledTimes(1));
    expect(lockEvents).toEqual(["lock-started"]);
    await expect(
      client.runTurn({ ...request, idempotencyKey: "concurrent-turn" }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
    expect(createDelegate).toHaveBeenCalledTimes(1);

    client.close();
    await expect(first).resolves.toEqual({ outcome: "completed" });
    expect(lockEvents).toEqual(["lock-started", "lock-ended"]);
    expect(delegate.close).toHaveBeenCalledTimes(1);
    await expect(client.runTurn({ ...request, idempotencyKey: "closed-turn" })).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
  });

  it("refuses a replacement sandbox generation before creating a package client", async () => {
    const expected = semanticTurnBinding(authority());
    const createDelegate = vi.fn();
    const client = createSandboxSemanticTurnClient("demo-sandbox", {
      expectedAuthority: expected,
      resolveAuthority: () => ({
        ...authority(),
        lifecycleGeneration: "replacement-generation",
      }),
      createClient: createDelegate,
      withSandboxLock: async (_sandboxName, operation) => operation(),
    });

    await expect(
      client.runTurn({
        conversationKey: "runtime:session",
        idempotencyKey: "turn-identifier",
        message: "summarize the repository",
        onEvent: () => {},
        runtimeTarget: "primary",
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_gateway_unavailable" });
    expect(createDelegate).not.toHaveBeenCalled();
  });
});
