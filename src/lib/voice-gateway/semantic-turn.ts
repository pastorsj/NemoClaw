// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  HarnessSemanticTurnDeclaration,
  HarnessSemanticTurnEvent,
  HarnessSemanticTurnFailureReason,
  HarnessSemanticTurnRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { buildCliOpenShellSandboxExecArgs } from "../adapters/openshell/sandbox-command-cli";
import {
  buildOpenShellSubprocessEnv,
  resolveOpenshellBinaryOrNull,
} from "../adapters/openshell/resolve-shared";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
} from "../adapters/openshell/sandbox-observer";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import { withSandboxMutationLock } from "../state/mutation-lock";
import type { AgentTurnClient, AgentTurnEvent } from "./contracts";
import {
  resolveSandboxSemanticTurnAuthority,
  semanticTurnBinding,
  semanticTurnBindingsEqual,
  type SandboxSemanticTurnAuthority,
  type SandboxSemanticTurnBinding,
} from "./sandbox-authority";

export { resolveSandboxSemanticTurnAuthority } from "./sandbox-authority";

const MAX_SEMANTIC_TURN_STREAM_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const SEMANTIC_TURN_TERMINATION_GRACE_MS = 1_000;

interface SemanticTurnReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

interface SemanticTurnWritable {
  end(input: string): void;
  once(event: "error", listener: () => void): unknown;
}

export interface SemanticTurnChild {
  readonly stderr: SemanticTurnReadable | null;
  readonly stdout: SemanticTurnReadable | null;
  readonly stdin: SemanticTurnWritable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: () => void): unknown;
  once(
    event: "close",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type SemanticTurnSpawner = (
  binary: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
) => SemanticTurnChild;

export interface SandboxSemanticTurnClientFactoryDependencies {
  readonly expectedAuthority?: SandboxSemanticTurnBinding;
  readonly resolveAuthority?: (sandboxName: string) => SandboxSemanticTurnAuthority;
  readonly createClient?: (options: SandboxSemanticTurnClientOptions) => AgentTurnClient;
  readonly withSandboxLock?: typeof withSandboxMutationLock;
}

export interface SandboxSemanticTurnClientOptions {
  readonly sandboxName: string;
  readonly declaration: Extract<HarnessSemanticTurnDeclaration, { readonly support: "managed" }>;
  readonly packageIdentity: HarnessPackageIdentity;
  readonly confirmAuthority?: () => SandboxSemanticTurnAuthority;
  readonly expectedAuthority?: SandboxSemanticTurnBinding;
  readonly gatewayName?: string | null;
  readonly resolveOpenShell?: () => string | null;
  readonly spawnChild?: SemanticTurnSpawner;
  readonly maxStreamBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseSemanticTurnEvent(line: string): HarnessSemanticTurnEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "started" || value.type === "completed") {
    return exactKeys(value, ["type"]) ? (value as HarnessSemanticTurnEvent) : null;
  }
  if (value.type === "text") {
    return exactKeys(value, ["text", "type"]) && typeof value.text === "string"
      ? (value as unknown as HarnessSemanticTurnEvent)
      : null;
  }
  if (value.type === "failed") {
    const reasons = new Set<HarnessSemanticTurnFailureReason>([
      "agent_failed",
      "agent_gateway_unavailable",
      "agent_protocol_error",
      "response_too_large",
    ]);
    return exactKeys(value, ["reason", "type"]) &&
      typeof value.reason === "string" &&
      reasons.has(value.reason as HarnessSemanticTurnFailureReason)
      ? (value as unknown as HarnessSemanticTurnEvent)
      : null;
  }
  return null;
}

function semanticTurnChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = buildOpenShellSubprocessEnv(source);
  for (const name of ["XDG_CONFIG_HOME", "OPENSHELL_WORKSPACE"] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

const defaultSpawner: SemanticTurnSpawner = (binary, args, options) =>
  spawn(binary, [...args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SemanticTurnChild;

/**
 * Execute package-native turns through one receipt-pinned OpenShell command.
 *
 * The package translates native protocol frames. Core owns the process,
 * request delivery, stream grammar, byte budget, timeout, and cancellation.
 */
export class SandboxSemanticTurnClient implements AgentTurnClient {
  private readonly options: SandboxSemanticTurnClientOptions;
  private activeChild: SemanticTurnChild | null = null;
  private terminateActiveChild: (() => void) | null = null;
  private closed = false;

  constructor(options: SandboxSemanticTurnClientOptions) {
    this.options = options;
  }

  close(): void {
    this.closed = true;
    this.terminateActiveChild?.();
  }

  async runTurn(options: {
    readonly conversationKey: string;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly runtimeTarget: string;
  }): Promise<
    | { readonly outcome: "completed" }
    | { readonly outcome: "failed"; readonly reason: HarnessSemanticTurnFailureReason }
  > {
    if (this.closed || this.activeChild) {
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }

    let current: SandboxSemanticTurnAuthority;
    try {
      current = (
        this.options.confirmAuthority ??
        (() => resolveSandboxSemanticTurnAuthority(this.options.sandboxName))
      )();
      if (
        !semanticTurnBindingsEqual(
          semanticTurnBinding(current),
          this.options.expectedAuthority ?? {
            ...semanticTurnBinding(current),
            packageIdentity: this.options.packageIdentity,
          },
        )
      ) {
        return { outcome: "failed", reason: "agent_gateway_unavailable" };
      }
    } catch {
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }

    const binary = (this.options.resolveOpenShell ?? resolveOpenshellBinaryOrNull)();
    if (!binary || !path.isAbsolute(binary)) {
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }
    const gatewayName =
      this.options.gatewayName === undefined ? current.gatewayName : this.options.gatewayName;
    const args = buildCliOpenShellSandboxExecArgs({
      sandboxName: this.options.sandboxName,
      target: gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
      command: this.options.declaration.command,
      tty: false,
      stdin: true,
      timeoutSeconds: this.options.declaration.timeout_seconds,
    });
    const request: HarnessSemanticTurnRequest = {
      type: "turn",
      message: options.message,
      conversationKey: options.conversationKey,
      runtimeTarget: options.runtimeTarget,
      idempotencyKey: options.idempotencyKey,
    };

    return new Promise((resolve) => {
      let child: SemanticTurnChild;
      try {
        child = (this.options.spawnChild ?? defaultSpawner)(binary, args, {
          env: semanticTurnChildEnvironment(),
        });
        this.activeChild = child;
      } catch {
        resolve({ outcome: "failed", reason: "agent_gateway_unavailable" });
        return;
      }

      const decoder = new StringDecoder("utf8");
      const maxStreamBytes = this.options.maxStreamBytes ?? MAX_SEMANTIC_TURN_STREAM_BYTES;
      let buffered = "";
      let streamBytes = 0;
      let started = false;
      let terminal:
        | { readonly outcome: "completed" }
        | { readonly outcome: "failed"; readonly reason: HarnessSemanticTurnFailureReason }
        | null = null;
      let protocolFailed = false;
      let settled = false;
      let terminationRequested = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const terminateChild = () => {
        if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
        terminationRequested = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // The close event remains the only authority that releases the sandbox lock.
        }
        forceKillTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // Retain the child and lock until process closure can be observed.
          }
        }, SEMANTIC_TURN_TERMINATION_GRACE_MS);
        forceKillTimer.unref();
      };
      this.terminateActiveChild = terminateChild;

      const failProtocol = (reason: HarnessSemanticTurnFailureReason = "agent_protocol_error") => {
        if (protocolFailed) return;
        protocolFailed = true;
        terminal = { outcome: "failed", reason };
        terminateChild();
      };
      const countBytes = (chunk: Buffer | string) => {
        streamBytes += Buffer.byteLength(chunk);
        if (streamBytes > maxStreamBytes) failProtocol("response_too_large");
      };
      const acceptEvent = (event: HarnessSemanticTurnEvent | null) => {
        if (!event || terminal) {
          failProtocol();
          return;
        }
        if (event.type === "started") {
          if (started) {
            failProtocol();
            return;
          }
          started = true;
          try {
            options.onEvent({ type: "started" });
          } catch {
            failProtocol();
          }
          return;
        }
        if (!started) {
          if (event.type === "failed") {
            terminal = { outcome: "failed", reason: event.reason };
            return;
          }
          failProtocol();
          return;
        }
        if (event.type === "text") {
          try {
            options.onEvent({ type: "text", text: event.text });
          } catch {
            failProtocol();
          }
          return;
        }
        terminal =
          event.type === "completed"
            ? { outcome: "completed" }
            : { outcome: "failed", reason: event.reason };
      };
      const readStdout = (chunk: Buffer | string) => {
        if (protocolFailed) return;
        countBytes(chunk);
        if (protocolFailed) return;
        buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          acceptEvent(parseSemanticTurnEvent(line));
          if (protocolFailed) return;
        }
      };

      child.stdout?.on("data", readStdout);
      child.stderr?.on("data", countBytes);
      child.once("error", () => failProtocol("agent_gateway_unavailable"));
      child.stdin?.once("error", () => failProtocol("agent_gateway_unavailable"));
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.activeChild = null;
        this.terminateActiveChild = null;
        buffered += decoder.end();
        if (buffered.length > 0) failProtocol();
        if (this.closed) {
          resolve({ outcome: "failed", reason: "agent_gateway_unavailable" });
          return;
        }
        if (protocolFailed) {
          resolve(terminal ?? { outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        if (exitCode !== 0 || signal || !terminal) {
          resolve({ outcome: "failed", reason: "agent_gateway_unavailable" });
          return;
        }
        resolve(terminal);
      });
      if (!child.stdin) {
        failProtocol("agent_gateway_unavailable");
        return;
      }
      try {
        child.stdin.end(`${JSON.stringify(request)}\n`);
      } catch {
        failProtocol("agent_gateway_unavailable");
      }
    });
  }
}

/** Construct a generic turn client from the sandbox's exact package receipt. */
export function createSandboxSemanticTurnClient(
  sandboxName: string,
  dependencies: SandboxSemanticTurnClientFactoryDependencies = {},
): AgentTurnClient {
  let delegate: AgentTurnClient | null = null;
  let active = false;
  let closed = false;
  return Object.freeze({
    close(): void {
      closed = true;
      delegate?.close();
    },
    async runTurn(options: Parameters<AgentTurnClient["runTurn"]>[0]) {
      if (closed || active) {
        return { outcome: "failed", reason: "agent_gateway_unavailable" } as const;
      }
      active = true;
      try {
        return await (dependencies.withSandboxLock ?? withSandboxMutationLock)(
          sandboxName,
          async () => {
            if (closed) {
              return { outcome: "failed", reason: "agent_gateway_unavailable" } as const;
            }
            const resolveAuthority =
              dependencies.resolveAuthority ?? resolveSandboxSemanticTurnAuthority;
            const authority = resolveAuthority(sandboxName);
            const binding = semanticTurnBinding(authority);
            if (
              dependencies.expectedAuthority &&
              !semanticTurnBindingsEqual(binding, dependencies.expectedAuthority)
            ) {
              return { outcome: "failed", reason: "agent_gateway_unavailable" } as const;
            }
            delegate = (
              dependencies.createClient ??
              ((clientOptions) => new SandboxSemanticTurnClient(clientOptions))
            )({
              sandboxName,
              declaration: authority.declaration,
              packageIdentity: authority.packageIdentity,
              expectedAuthority: binding,
              confirmAuthority: () => resolveAuthority(sandboxName),
            });
            return await delegate.runTurn(options);
          },
        );
      } catch {
        return { outcome: "failed", reason: "agent_gateway_unavailable" } as const;
      } finally {
        active = false;
        delegate = null;
      }
    },
  });
}
