// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { ArtifactSink } from "../../test/e2e/fixtures/artifacts.ts";
import { redactString } from "../../test/e2e/fixtures/redaction.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const GATEWAY_ALREADY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/iu;
const GATEWAY_REMOVE_UNSUPPORTED =
  /unrecognized subcommand ['"]remove['"]|unknown command ['"]remove['"]/iu;
const SANDBOX_ALREADY_ABSENT =
  /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu;
const GATEWAY_INVENTORY_ABSENT =
  /\bUnknown gateway '[^'\r\n]+'|\bNo (?:active )?gateway\b|\bNo gateway metadata found\b/iu;
const SANDBOX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,18}$/u;

export interface LiveCommandOptions {
  readonly artifactName?: string;
  /** Retain at most the last N bytes from each output stream. */
  readonly captureLimitBytes?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
}

export interface LiveCommandResult {
  readonly command: string[];
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly failure: {
    readonly kind: "exit" | "signal" | "spawn" | "timeout";
    readonly message: string;
  } | null;
  readonly output: {
    readonly stderr: LiveOutputEvidence;
    readonly stdout: LiveOutputEvidence;
  };
  readonly stdout: string;
  readonly stderr: string;
  readonly artifacts: {
    readonly stdout: string;
    readonly stderr: string;
    readonly result: string;
  };
}

export interface LiveOutputEvidence {
  readonly droppedBytes: number;
  readonly limitBytes: number;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
}

interface OutputCapture {
  append(chunk: Buffer): void;
  value(): { readonly droppedBytes: number; readonly text: string };
}

function createOutputCapture(limitBytes: number): OutputCapture {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error("captureLimitBytes must be a positive safe integer");
  }
  let droppedBytes = 0;
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return {
    append(chunk) {
      const combined = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
      if (combined.length <= limitBytes) {
        tail = combined;
        return;
      }
      let retainedStart = combined.length - limitBytes;
      while (retainedStart < combined.length && (combined[retainedStart]! & 0xc0) === 0x80) {
        retainedStart += 1;
      }
      droppedBytes += retainedStart;
      tail = Buffer.from(combined.subarray(retainedStart));
    },
    value() {
      return { droppedBytes, text: tail.toString("utf8") };
    },
  };
}

function redactTruncatedSecretPrefix(text: string, redactionValues: readonly string[]): string {
  let fragmentLength = 0;
  for (const value of redactionValues) {
    const maxLength = Math.min(value.length - 1, text.length);
    for (let length = maxLength; length > fragmentLength; length -= 1) {
      if (text.startsWith(value.slice(-length))) {
        fragmentLength = length;
        break;
      }
    }
  }
  return fragmentLength > 0 ? `[REDACTED]${text.slice(fragmentLength)}` : text;
}

function artifactLabel(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "command"
  );
}

export function liveResultText(result: Pick<LiveCommandResult, "stderr" | "stdout">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function liveOutputContainsSandbox(
  result: Pick<LiveCommandResult, "stderr" | "stdout">,
  sandboxName: string,
): boolean {
  const escaped = sandboxName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "mu").test(liveResultText(result));
}

export function requireLiveCommandSuccess(
  result: Pick<
    LiveCommandResult,
    "exitCode" | "failure" | "signal" | "stderr" | "stdout" | "timedOut"
  >,
  label: string,
): void {
  if (result.exitCode === 0 && !result.failure && !result.timedOut) return;
  const fallback = result.signal
    ? `signal=${result.signal}`
    : `exit=${result.exitCode ?? "unknown"}`;
  throw new Error(`${label} failed: ${liveResultText(result).trim() || fallback}`);
}

function requireSandboxName(name: string): string {
  if (!SANDBOX_NAME_PATTERN.test(name)) {
    throw new Error("Standalone Fabric E2E received an invalid sandbox name");
  }
  return name;
}

/** Run exact argv without a shell, redact all retained output, and write bounded evidence. */
export class LiveCommandRunner {
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();

  constructor(
    private readonly artifacts: ArtifactSink,
    private readonly redactionValues: readonly string[],
  ) {}

  /** Interrupt only commands owned by this runner so the journey can reconcile cleanup. */
  cancelActive(): void {
    for (const child of this.activeChildren) {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          continue;
        } catch {
          // The process may have exited between iteration and the group signal.
        }
      }
      child.kill("SIGKILL");
    }
  }

  async run(
    command: string,
    args: readonly string[],
    options: LiveCommandOptions = {},
  ): Promise<LiveCommandResult> {
    const startedAtMs = Date.now();
    const values = [...this.redactionValues, ...(options.redactionValues ?? [])];
    const activity = artifactLabel(options.artifactName ?? [command, ...args].join("-"));
    const captureLimitBytes = options.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
    const stdoutCapture = createOutputCapture(captureLimitBytes);
    const stderrCapture = createOutputCapture(captureLimitBytes);
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeChildren.add(child);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutCapture.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrCapture.append(chunk);
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The process may have exited between the timer and the group kill.
        }
      }
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    const completion = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError: string | null;
    }>((resolve) => {
      let settled = false;
      const finish = (result: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        spawnError: string | null;
      }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once("error", (error) =>
        finish({ exitCode: null, signal: null, spawnError: error.message }),
      );
      child.once("close", (exitCode, signal) => finish({ exitCode, signal, spawnError: null }));
    }).finally(() => {
      clearTimeout(timer);
      this.activeChildren.delete(child);
    });

    const renderCapture = (
      capture: OutputCapture,
    ): { evidence: LiveOutputEvidence; text: string } => {
      const captured = capture.value();
      const boundarySafe =
        captured.droppedBytes > 0
          ? redactTruncatedSecretPrefix(captured.text, values)
          : captured.text;
      const redacted = redactString(boundarySafe, values);
      const text =
        captured.droppedBytes > 0
          ? `[live-command omitted ${String(captured.droppedBytes)} earlier bytes; showing up to the last ${String(captureLimitBytes)} bytes]\n${redacted}`
          : redacted;
      return {
        evidence: {
          droppedBytes: captured.droppedBytes,
          limitBytes: captureLimitBytes,
          observedBytes: captured.droppedBytes + Buffer.byteLength(captured.text, "utf8"),
          retainedBytes: Buffer.byteLength(redacted, "utf8"),
          truncated: captured.droppedBytes > 0,
        },
        text,
      };
    };
    const stdoutCaptureResult = renderCapture(stdoutCapture);
    const stderrCaptureResult = renderCapture(stderrCapture);
    const stdout = stdoutCaptureResult.text;
    const stderr = stderrCaptureResult.text;
    const spawnError = completion.spawnError ? redactString(completion.spawnError, values) : null;
    const failure = spawnError
      ? { kind: "spawn" as const, message: spawnError }
      : timedOut
        ? { kind: "timeout" as const, message: `command exceeded ${String(timeoutMs)} ms` }
        : completion.signal
          ? { kind: "signal" as const, message: `command exited on ${completion.signal}` }
          : completion.exitCode !== 0
            ? { kind: "exit" as const, message: `command exited ${String(completion.exitCode)}` }
            : null;
    const evidence = {
      command: [command, ...args].map((value) => redactString(value, values)),
      durationMs: Date.now() - startedAtMs,
      exitCode: completion.exitCode,
      signal: completion.signal,
      timedOut,
      failure,
      output: {
        stderr: stderrCaptureResult.evidence,
        stdout: stdoutCaptureResult.evidence,
      },
      stdout,
      stderr,
    };
    const base = `shell/${activity}`;
    const artifacts = {
      stdout: await this.artifacts.writeText(`${base}.stdout.txt`, stdout),
      stderr: await this.artifacts.writeText(`${base}.stderr.txt`, stderr),
      result: await this.artifacts.writeJson(`${base}.result.json`, evidence),
    };
    return { ...evidence, artifacts };
  }
}

/** Public NemoClaw/OpenShell host commands used by the package qualification journey. */
export class LiveHostClient {
  constructor(
    private readonly runner: LiveCommandRunner,
    private readonly cliPath: string,
    private readonly cwd: string,
    private readonly openshellPath = process.env.OPENSHELL_BIN ?? "openshell",
  ) {}

  command(
    command: string,
    args: readonly string[] = [],
    options: LiveCommandOptions = {},
  ): Promise<LiveCommandResult> {
    return this.runner.run(command, args, { cwd: this.cwd, ...options });
  }

  nemoclaw(
    args: readonly string[] = [],
    options: LiveCommandOptions = {},
  ): Promise<LiveCommandResult> {
    return this.command(this.cliPath, args, {
      artifactName: `nemoclaw-${artifactLabel(args.join("-") || "default")}`,
      ...options,
    });
  }

  expectStatus(name: string, options: LiveCommandOptions = {}): Promise<LiveCommandResult> {
    return this.nemoclaw([requireSandboxName(name), "status"], options).then((result) => {
      requireLiveCommandSuccess(result, `nemoclaw ${name} status`);
      return result;
    });
  }

  destroySandbox(name: string, options: LiveCommandOptions = {}): Promise<LiveCommandResult> {
    return this.nemoclaw([requireSandboxName(name), "destroy", "--yes"], options);
  }

  async cleanupSandbox(name: string, options: LiveCommandOptions = {}): Promise<void> {
    const result = await this.destroySandbox(name, options);
    if (result.exitCode === 0 || SANDBOX_ALREADY_ABSENT.test(liveResultText(result))) return;
    requireLiveCommandSuccess(result, `cleanup destroy sandbox ${name}`);
  }

  async bestEffortCleanupSandbox(name: string, options: LiveCommandOptions = {}): Promise<void> {
    try {
      await this.cleanupSandbox(name, options);
    } catch {
      // Initial cleanup only removes stale resources from interrupted runs.
    }
  }

  async cleanupGatewayRegistration(
    gatewayName: string,
    options: LiveCommandOptions = {},
  ): Promise<void> {
    const remove = await this.command(
      this.openshellPath,
      ["gateway", "remove", gatewayName],
      options,
    );
    if (remove.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(liveResultText(remove))) return;
    if (!GATEWAY_REMOVE_UNSUPPORTED.test(liveResultText(remove))) {
      requireLiveCommandSuccess(remove, `cleanup gateway registration ${gatewayName}`);
    }
    const destroy = await this.command(
      this.openshellPath,
      ["gateway", "destroy", "-g", gatewayName],
      options,
    );
    if (destroy.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(liveResultText(destroy))) return;
    requireLiveCommandSuccess(destroy, `cleanup gateway registration ${gatewayName}`);
  }
}

/** OpenShell sandbox commands used by the same journey. */
export class LiveSandboxClient {
  constructor(
    private readonly runner: LiveCommandRunner,
    private readonly openshellPath = process.env.OPENSHELL_BIN ?? "openshell",
  ) {}

  private openshell(
    args: readonly string[],
    options: LiveCommandOptions = {},
  ): Promise<LiveCommandResult> {
    return this.runner.run(this.openshellPath, args, options);
  }

  exec(
    name: string,
    command: readonly string[],
    options: LiveCommandOptions = {},
  ): Promise<LiveCommandResult> {
    return this.openshell(
      ["sandbox", "exec", "-n", requireSandboxName(name), "--", ...command],
      options,
    );
  }

  private list(options: LiveCommandOptions = {}): Promise<LiveCommandResult> {
    return this.openshell(["sandbox", "list"], options);
  }

  async expectListed(name: string, options: LiveCommandOptions = {}): Promise<LiveCommandResult> {
    const result = await this.list(options);
    requireLiveCommandSuccess(result, "openshell sandbox list");
    if (!liveOutputContainsSandbox(result, requireSandboxName(name))) {
      throw new Error(`openshell sandbox list did not include '${name}'`);
    }
    return result;
  }

  async expectAbsent(name: string, options: LiveCommandOptions = {}): Promise<LiveCommandResult> {
    const result = await this.list(options);
    if (result.exitCode !== 0) {
      if (GATEWAY_INVENTORY_ABSENT.test(liveResultText(result))) return result;
      requireLiveCommandSuccess(result, "openshell sandbox list");
    }
    if (liveOutputContainsSandbox(result, requireSandboxName(name))) {
      throw new Error(`openshell sandbox list still included '${name}'`);
    }
    return result;
  }
}
