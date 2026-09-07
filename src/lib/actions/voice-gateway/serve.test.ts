// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { assertVoiceGatewayEnabled, runVoiceGatewayServe } from "./serve";

const OPTIONS = {
  runtimeIdentity: "voice-runtime-local",
  runtimeProfile: "voice-runtime-pinned",
  sandbox: "demo-sandbox",
  sandboxAuthority: {
    sandboxName: "demo-sandbox",
    packageIdentity: {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "1.2.3",
      contentDigest: "a".repeat(64),
    },
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-one",
    lifecycleLiveIdentityFingerprint: "b".repeat(64),
  },
  agent: "main",
  turnTimeoutMs: 120_000,
};

describe("experimental voice gateway service gate", () => {
  it.each([undefined, "", "0", "true", "01"])("rejects feature value %s", (value) => {
    expect(() =>
      assertVoiceGatewayEnabled({
        NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: value,
      }),
    ).toThrow("disabled");
  });

  it("checks the exact feature gate before reading either credential (#8378)", async () => {
    const readBearerDescriptor = vi.fn();
    const createServer = vi.fn();

    await expect(
      runVoiceGatewayServe(OPTIONS, {
        env: {
          NEMOCLAW_EXPERIMENTAL_OTHER_CAPABILITY: "1",
          NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "0",
        },
        readBearerDescriptor,
        createServer,
      }),
    ).rejects.toThrow("disabled");
    expect(readBearerDescriptor).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });
});

describe("voice gateway listener lifetime", () => {
  it("binds loopback, logs only trusted labels, and closes on SIGTERM (#8378)", async () => {
    class FakeServer extends EventEmitter {
      listening = false;
      listenArgs: unknown[] = [];

      listen(...args: unknown[]): this {
        this.listenArgs = args.slice(0, 2);
        this.listening = true;
        const callback = args.at(-1) as () => void;
        callback();
        return this;
      }

      close(callback?: (error?: Error) => void): this {
        this.listening = false;
        callback?.();
        return this;
      }
    }

    const server = new FakeServer();
    const processEvents = new EventEmitter();
    const log = vi.fn();
    const readBearerDescriptor = vi.fn(() => "deployment-secret");
    const createServer = vi.fn(() => server as unknown as Server);

    const running = runVoiceGatewayServe(OPTIONS, {
      env: { NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "1" },
      readBearerDescriptor,
      createServer,
      processEvents,
      log,
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(readBearerDescriptor).toHaveBeenCalledWith(3);
    expect(server.listenArgs).toEqual([18800, "127.0.0.1"]);
    expect(createServer).toHaveBeenCalledWith({
      deploymentCredential: "deployment-secret",
      service: expect.anything(),
    });
    expect(log).toHaveBeenCalledWith({
      event: "voice_gateway",
      state: "listening",
      runtimeIdentity: "voice-runtime-local",
      runtimeProfile: "voice-runtime-pinned",
      sandbox: "demo-sandbox",
      agent: "main",
    });

    processEvents.emit("SIGTERM");
    await running;

    expect(server.listening).toBe(false);
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ state: "stopped" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
