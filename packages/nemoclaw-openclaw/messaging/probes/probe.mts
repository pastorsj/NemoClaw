// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw-native messaging probes.
 *
 * NemoClaw runs this fixed package command and understands only the bounded
 * result protocol. Paths, CLI grammar, process names, and OpenClaw response
 * shapes deliberately stay inside the OpenClaw package.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const GATEWAY_LOG_PATH = "/tmp/gateway.log";
const WARNING_PATTERN =
  /credential placeholder|Bot API rejected|startup probe (?:failed|returned)|provider failed to start|bridge did not start within|invalid_auth|token_revoked|token_expired/iu;
const STARTED_PATTERN = /\bstarting provider\b|\bprovider ready\b/iu;
const NETWORK_PATTERN =
  /startup probe failed|network request for .+ failed|recoverable network error|temporarily unhealthy|UND_ERR_SOCKET/iu;

export type ProbeStatusContext = {
  readonly agent: string;
  readonly probedAt: string;
  readonly channelEnabledInRegistry: boolean;
  readonly presetApplied: boolean;
  readonly presetOnGateway: boolean | null;
};

type SignalSeverity = "ok" | "warn" | "fail" | "info";
type ReadinessCategory = "credential" | "network" | "plugin" | "policy" | "runtime";

type ProbeSignal = {
  readonly label: string;
  readonly severity: SignalSeverity;
  readonly detail: string;
  readonly hint?: string;
};

type ProbeReadiness = {
  readonly state: "ready" | "waiting" | "terminal";
  readonly category: ReadinessCategory | null;
  readonly reason: string;
  readonly retryable: boolean;
  readonly lastTransitionAt: string | null;
};

type ProbeReport = {
  readonly schemaVersion: 1;
  readonly channel: string;
  readonly agent: string;
  readonly verdict: string;
  readonly probedAt: string;
  readonly signals: readonly ProbeSignal[];
  readonly hints: readonly string[];
  readonly readiness?: ProbeReadiness;
};

export interface OpenClawProbeIo {
  readonly readTextFile: (path: string) => string | null;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => { readonly status: number | null; readonly stdout: string };
}

const SYSTEM_IO: OpenClawProbeIo = {
  readTextFile(path) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  runCommand(command, args, timeoutMs) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return { status: result.status, stdout: String(result.stdout ?? "") };
  },
};

/** Produce user-facing bridge diagnostics without exposing native data to core. */
export function probeBridgeHealth(
  channel: string,
  io: OpenClawProbeIo = SYSTEM_IO,
): {
  readonly schemaVersion: 1;
  readonly type: "messaging-bridge-health";
  readonly channel: string;
  readonly lines: readonly string[];
} {
  const config = parseObject(io.readTextFile(CONFIG_PATH));
  const channelBlock = readObjectPath(config, ["channels", channel]);
  if (readObject(channelBlock)?.enabled !== true) {
    return bridgeResult(channel, [
      `  ⚠ '${channel}' channel was not marked enabled in baked ${CONFIG_PATH} after rebuild.`,
      "    The bridge will not start. Re-run the sandbox rebuild or remove and add the channel again.",
    ]);
  }

  const logLines = String(io.readTextFile(GATEWAY_LOG_PATH) ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes(`[${channel}]`))
    .slice(-400);
  if (logLines.length === 0) {
    return bridgeResult(channel, [
      `  ⚠ '${channel}' bridge did not log a startup breadcrumb in ${GATEWAY_LOG_PATH} yet.`,
      "    Re-run channel status after the sandbox gateway settles.",
    ]);
  }
  const warnings = logLines.filter((line) => WARNING_PATTERN.test(line)).slice(-3);
  if (warnings.length > 0) {
    return bridgeResult(channel, [
      `  ⚠ '${channel}' bridge logged credential/startup warnings:`,
      ...warnings.map((line) => `    ${line}`),
      `    Verify the OpenShell provider for ${channel} and rebuild if needed.`,
    ]);
  }
  if (!logLines.some((line) => STARTED_PATTERN.test(line))) {
    return bridgeResult(channel, [
      `  ⚠ '${channel}' bridge log lines were found but no startup confirmation is available yet.`,
    ]);
  }
  const lines = [`  ✓ '${channel}' bridge startup detected in sandbox runtime log.`];
  if (channel === "telegram" && telegramAllowlistIsEmpty(channelBlock)) {
    lines.push(
      "  ⚠ Telegram direct-message allowlist is empty in baked openclaw.json.",
      "    Set TELEGRAM_ALLOWED_IDS before rebuild, or complete OpenClaw pairing before expecting DM replies.",
    );
  }
  return bridgeResult(channel, lines);
}

/** Classify OpenClaw Telegram log/process evidence into NemoClaw's generic report. */
export function probeTelegramStatus(
  context: ProbeStatusContext,
  io: OpenClawProbeIo = SYSTEM_IO,
): ProbeReport {
  const canProbe = canProbeChannel(context);
  const logLines = canProbe
    ? String(io.readTextFile(GATEWAY_LOG_PATH) ?? "")
        .split(/\r?\n/u)
        .filter((line) => line.includes("[telegram]"))
        .slice(-40)
    : [];
  const processResult = canProbe
    ? io.runCommand("pgrep", ["-fa", "openclaw|openclaw-gateway|node .*gateway"], 2_000)
    : { status: null, stdout: "" };
  const processAlive = processResult.status === 0 && processResult.stdout.trim().length > 0;
  const latestEvidence = classifyLatestTelegramEvidence(logLines);
  const policySignal = genericPolicySignal(context, "telegram");
  const registrationSignal = genericRegistrationSignal(context, "telegram");
  const signals: ProbeSignal[] = [registrationSignal, policySignal];
  if (canProbe) {
    signals.push(
      signal(
        "Bridge process",
        processAlive ? "ok" : "warn",
        processAlive
          ? "OpenClaw gateway process is running"
          : "OpenClaw gateway process was not found",
      ),
      telegramEvidenceSignal(latestEvidence),
    );
  }

  let verdict = "unknown";
  if (!context.channelEnabledInRegistry) verdict = "config_gap";
  else if (!context.presetApplied || context.presetOnGateway === false) verdict = "policy_gap";
  else if (context.presetOnGateway === null) verdict = "probe_failed";
  else if (latestEvidence === "credential") verdict = "token_rejected";
  else if (latestEvidence === "network") verdict = "unreachable";
  else if (!processAlive) verdict = "not_started";
  else if (latestEvidence === "ready") verdict = "healthy";
  else verdict = "idle";
  return report("telegram", context, verdict, signals, telegramHints(verdict));
}

/** Classify `openclaw channels status` without exposing its schema to core. */
export function probeSlackStatus(
  context: ProbeStatusContext,
  io: OpenClawProbeIo = SYSTEM_IO,
): ProbeReport {
  const canProbe = canProbeChannel(context);
  const result = canProbe
    ? io.runCommand(
        "openclaw",
        ["channels", "status", "--channel", "slack", "--probe", "--json", "--timeout", "6000"],
        7_000,
      )
    : { status: null, stdout: "" };
  const payload = result.status === 0 ? parseObject(result.stdout) : null;
  const gatewayReachable = readObject(payload)?.gatewayReachable !== false && payload !== null;
  const channelAccounts = readObject(readObject(payload)?.channelAccounts);
  const accounts = Array.isArray(channelAccounts?.slack)
    ? channelAccounts.slack.filter(isObject)
    : [];
  const account =
    accounts.find((candidate) => candidate.accountId === "default") ?? accounts[0] ?? null;
  const configured = readObject(readObject(readObject(payload)?.channels)?.slack)?.configured;
  const accountProbe = readObject(account?.probe);
  const failure = classifySlackFailure(
    normalizeString(account?.lastError) ?? normalizeString(accountProbe?.error),
  );
  const readiness = classifySlackReadiness(context, {
    gatewayReachable,
    configured,
    account,
    failure,
  });
  const signals: ProbeSignal[] = [
    genericRegistrationSignal(context, "slack"),
    genericPolicySignal(context, "slack"),
  ];
  if (canProbe) {
    signals.push(
      signal(
        "Runtime process",
        account?.running === true ? "ok" : gatewayReachable ? "warn" : "info",
        account?.running === true
          ? "Slack account runtime is running"
          : "Slack account runtime is not ready",
      ),
      signal(
        "Socket Mode transport",
        account?.connected === true ? "ok" : "warn",
        account?.connected === true ? "connected" : "not connected",
      ),
      signal(
        "Account probe",
        accountProbe?.ok === true ? "ok" : failure === "credential" ? "fail" : "info",
        accountProbe?.ok === true
          ? "Slack account probe succeeded"
          : "Slack account probe is not ready",
      ),
    );
  }
  const hints =
    readiness.state === "ready"
      ? []
      : [`Resolve the ${readiness.category ?? "runtime"} condition, then re-run channel status.`];
  return {
    ...report(
      "slack",
      context,
      readiness.state === "ready"
        ? "healthy"
        : readiness.state === "waiting"
          ? "initializing"
          : `${readiness.category ?? "runtime"}_failure`,
      signals,
      hints,
    ),
    readiness,
  };
}

function classifySlackReadiness(
  context: ProbeStatusContext,
  evidence: {
    readonly gatewayReachable: boolean;
    readonly configured: unknown;
    readonly account: Record<string, unknown> | null;
    readonly failure: ReadinessCategory | null;
  },
): ProbeReadiness {
  const lastTransitionAt = latestTimestamp(evidence.account);
  const result = (
    state: ProbeReadiness["state"],
    category: ReadinessCategory | null,
    reason: string,
  ): ProbeReadiness => ({
    state,
    category,
    reason,
    retryable: state === "waiting",
    lastTransitionAt,
  });
  if (!context.channelEnabledInRegistry)
    return result("terminal", "runtime", "channel_not_registered");
  if (!context.presetApplied || context.presetOnGateway === false)
    return result("terminal", "policy", "policy_missing");
  if (context.presetOnGateway === null || !evidence.gatewayReachable)
    return result("waiting", "network", "status_probe_unreachable");
  if (evidence.configured === false) return result("terminal", "plugin", "plugin_not_configured");
  if (!evidence.account) return result("waiting", "runtime", "account_initializing");
  if (
    evidence.account.botTokenStatus === "configured_unavailable" ||
    evidence.account.appTokenStatus === "configured_unavailable" ||
    evidence.account.configured === false ||
    evidence.failure === "credential"
  ) {
    return result("terminal", "credential", "credentials_unavailable");
  }
  if (evidence.account.enabled === false) return result("terminal", "runtime", "account_disabled");
  if (evidence.failure === "plugin") return result("terminal", "plugin", "plugin_failed");
  if (evidence.failure === "runtime") return result("terminal", "runtime", "runtime_failed");
  if (evidence.account.running !== true) return result("waiting", "runtime", "runtime_starting");
  if (evidence.account.connected !== true)
    return result("waiting", "network", "socket_mode_connecting");
  const probeOk = readObject(evidence.account.probe)?.ok;
  return probeOk === true
    ? result("ready", null, "operational")
    : result("waiting", evidence.failure ?? "runtime", "account_probe_pending");
}

function classifyLatestTelegramEvidence(
  lines: readonly string[],
): "ready" | "credential" | "network" | "unknown" {
  let result: "ready" | "credential" | "network" | "unknown" = "unknown";
  for (const line of lines) {
    if (
      /rejected startup probe with HTTP\s+(401|404)|credential placeholder.*(?:missing|mismatch|unresolved)/iu.test(
        line,
      )
    ) {
      result = "credential";
    } else if (NETWORK_PATTERN.test(line) || /startup probe returned HTTP\s+\d{3}/iu.test(line)) {
      result = "network";
    } else if (
      /provider ready|inbound update received|inbound message telegram|isolated polling ingress started/iu.test(
        line,
      )
    ) {
      result = "ready";
    }
  }
  return result;
}

function telegramEvidenceSignal(
  evidence: ReturnType<typeof classifyLatestTelegramEvidence>,
): ProbeSignal {
  if (evidence === "ready")
    return signal("Bot API reachability", "ok", "Telegram provider reported ready");
  if (evidence === "credential")
    return signal(
      "Bot API reachability",
      "fail",
      "Telegram rejected or could not resolve the credential",
    );
  if (evidence === "network")
    return signal("Bot API reachability", "warn", "Telegram provider reported a network failure");
  return signal(
    "Bot API reachability",
    "info",
    "No conclusive Telegram startup evidence is available",
  );
}

function genericRegistrationSignal(context: ProbeStatusContext, channel: string): ProbeSignal {
  return signal(
    "Channel registration",
    context.channelEnabledInRegistry ? "ok" : "fail",
    context.channelEnabledInRegistry ? `${channel} registered` : `${channel} not registered`,
  );
}

function genericPolicySignal(context: ProbeStatusContext, channel: string): ProbeSignal {
  const missing = !context.presetApplied || context.presetOnGateway === false;
  return signal(
    "Policy coverage",
    missing ? "fail" : context.presetOnGateway === true ? "ok" : "info",
    missing
      ? `${channel} policy is missing`
      : context.presetOnGateway === true
        ? `${channel} policy is loaded`
        : `${channel} policy could not be inspected`,
  );
}

function canProbeChannel(context: ProbeStatusContext): boolean {
  return (
    context.channelEnabledInRegistry && context.presetApplied && context.presetOnGateway === true
  );
}

function report(
  channel: string,
  context: ProbeStatusContext,
  verdict: string,
  signals: readonly ProbeSignal[],
  hints: readonly string[],
): ProbeReport {
  return {
    schemaVersion: 1,
    channel,
    agent: context.agent,
    verdict,
    probedAt: context.probedAt,
    signals,
    hints,
  };
}

function bridgeResult(channel: string, lines: readonly string[]) {
  return { schemaVersion: 1 as const, type: "messaging-bridge-health" as const, channel, lines };
}

function telegramAllowlistIsEmpty(value: unknown): boolean {
  const accounts = readObject(readObject(value)?.accounts);
  const account =
    readObject(accounts?.default) ?? Object.values(accounts ?? {}).find(isObject) ?? null;
  return (
    account?.dmPolicy === "allowlist" &&
    (!Array.isArray(account.allowFrom) || account.allowFrom.length === 0)
  );
}

function classifySlackFailure(value: string | null): ReadinessCategory | null {
  if (!value) return null;
  if (
    /invalid[_ -]?auth|token[_ -]?(?:revoked|expired)|not[_ -]?authed|credential|unauthor/iu.test(
      value,
    )
  )
    return "credential";
  if (/plugin|module|package|not installed|cannot find/iu.test(value)) return "plugin";
  if (/timeout|timed out|network|connect|socket|dns|econn|unreachable/iu.test(value))
    return "network";
  return "runtime";
}

function telegramHints(verdict: string): readonly string[] {
  if (verdict === "healthy") return [];
  if (verdict === "token_rejected")
    return ["Replace the Telegram credential and rebuild the sandbox."];
  if (verdict === "policy_gap")
    return ["Restore the Telegram network policy and rebuild the sandbox."];
  return ["Inspect the OpenClaw gateway log, then re-run channel status."];
}

function latestTimestamp(account: Record<string, unknown> | null): string | null {
  const values = [account?.lastStartAt, account?.lastStopAt, account?.lastProbeAt].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (values.length === 0) return null;
  return new Date(Math.max(...values)).toISOString();
}

function signal(label: string, severity: SignalSeverity, detail: string): ProbeSignal {
  return { label, severity, detail };
}

function parseObject(value: string | null): Record<string, unknown> | null {
  try {
    return readObject(JSON.parse(String(value ?? "")));
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObjectPath(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) current = readObject(current)?.[segment];
  return current;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function decodeContext(argv: readonly string[]): ProbeStatusContext {
  const marker = argv.lastIndexOf("--nemoclaw-context");
  const encoded = marker >= 0 ? argv[marker + 1] : undefined;
  if (!encoded || encoded.length > 16 * 1024)
    throw new Error("missing bounded NemoClaw status context");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  const value = readObject(parsed);
  if (
    !value ||
    typeof value.agent !== "string" ||
    typeof value.probedAt !== "string" ||
    typeof value.channelEnabledInRegistry !== "boolean" ||
    typeof value.presetApplied !== "boolean" ||
    ![true, false, null].includes(value.presetOnGateway as boolean | null)
  ) {
    throw new Error("invalid NemoClaw status context");
  }
  return value as ProbeStatusContext;
}

function runCli(argv: readonly string[]): void {
  const operation = argv[0];
  let value: unknown;
  if (operation === "bridge-health" && argv[1]) value = probeBridgeHealth(argv[1]);
  else if (operation === "telegram-status") {
    value = { type: "messaging-channel-health", report: probeTelegramStatus(decodeContext(argv)) };
  } else if (operation === "slack-status") {
    value = { type: "messaging-channel-health", report: probeSlackStatus(decodeContext(argv)) };
  } else {
    throw new Error("unsupported OpenClaw messaging probe operation");
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
