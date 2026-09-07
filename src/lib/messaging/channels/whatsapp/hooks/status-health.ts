// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `whatsapp.statusHealth` — a `phase: "status"` hook that probes the live
 * WhatsApp bridge state from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no whatsapp-specific code lives in
 * the generic status orchestrator.
 *
 * A receipt-backed package selects one of two finite operations: parse a
 * channel-status JSON command, or check two declared session files and one
 * optional configured path. NemoClaw quotes argv, bounds execution time,
 * contains paths below the package config root, and never reads credential
 * contents. Exact pre-receipt behavior is isolated in `legacy-status.ts`.
 *
 * Redaction contract: this probe never reads, stores, logs, or emits the
 * self.e164 / self.jid / self.lid values or the raw `lastError` string
 * from channel-status JSON — those can carry phone numbers. Only booleans,
 * state-string enums, and epoch timestamps make it into the report.
 */

import path from "node:path";

import type {
  HarnessMessagingCommand,
  HarnessWhatsappStatusProbe,
} from "@nvidia/nemoclaw-harness-contract";

import { shellQuote } from "../../../../core/shell-quote";
import type {
  MessagingHookContext,
  MessagingHookHandler,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import {
  evaluateWhatsappDiagnostics,
  type WhatsappHeartbeat,
  type WhatsappProbeGuidance,
  type WhatsappProbeInput,
  type WhatsappSessionLocations,
} from "./status-health-eval";
import { resolveLegacyWhatsappStatusProfile } from "./legacy-status";

export const WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID = "whatsapp.statusHealth";

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the diagnostic. WhatsApp's in-process bridge can go unresponsive when
// the Noise WebSocket is stuck; a fast hard cap keeps channels status from
// inheriting that hang.
const DEFAULT_TIMEOUT_MS = 8_000;
const SESSION_PROBE_SENTINEL = "NEMOCLAW_WHATSAPP_SESSION_V1";
const CONFIG_PROBE_SENTINEL = "NEMOCLAW_WHATSAPP_CONFIG_V1";
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_CONFIG_ROOT = /^~\/[A-Za-z0-9._-]+$/u;
/** WhatsApp uses the generic channel-health hook options unchanged. */
export type WhatsappStatusHealthHookOptions = ChannelStatusHealthHookOptions;

export function createWhatsappStatusHealthHook(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "whatsapp") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    // Without a sandbox target or an exec runner there is nothing to probe
    // (e.g. the top-level status runner does not thread an exec runner into
    // this hook).
    if (!execute || !sandboxName) return {};

    const agent = normalizeString(context.inputs?.agent) ?? "unknown";
    const statusProfile = resolveStatusProfile(context.inputs, agent);
    if (!statusProfile) return {};
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const probe = runDeclaredStatusProbe(execute, sandboxName, timeoutMs, statusProfile);

    const input: WhatsappProbeInput = {
      agent,
      paired: probe.paired,
      heartbeat: probe.heartbeat,
      heartbeatParseError: null,
      bridgeProcessAlive: probe.bridgeProcessAlive,
      recentLogSignals: probe.recentLogSignals,
      probeReachable: probe.probeReachable,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      presetApplied: Boolean(context.inputs?.presetApplied),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
      guidance: createProbeGuidance(statusProfile),
      ...(probe.sessionLocations ? { sessionLocations: probe.sessionLocations } : {}),
    };
    const report = evaluateWhatsappDiagnostics(input);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

type StatusProfile = {
  readonly configRoot: string | null;
  readonly probe: HarnessWhatsappStatusProbe;
};

function resolveStatusProfile(
  inputs: MessagingHookContext["inputs"],
  agent: string,
): StatusProfile | null {
  const declaredProbe = readStatusProbe(inputs?.statusProbe);
  const receiptBacked = inputs?.receiptBackedProfile === true;
  if (receiptBacked) {
    if (!declaredProbe) return null;
    const configRoot = readConfigRoot(inputs?.packageConfigRoot);
    if (declaredProbe.kind === "session-files" && !configRoot) return null;
    return { probe: declaredProbe, configRoot };
  }
  return resolveLegacyWhatsappStatusProfile(agent);
}

function createProbeGuidance(profile: StatusProfile): WhatsappProbeGuidance {
  const pairingCommand = formatDisplayCommand(profile.probe.pairingCommand);
  if (profile.probe.kind === "channel-status-json") return { pairingCommand };
  const paths = resolveSessionProbePaths(profile.configRoot as string, profile.probe);
  if (!paths) return { pairingCommand };
  return {
    pairingCommand,
    session: {
      primaryLabel: profile.probe.primaryLabel,
      alternateLabel: profile.probe.alternateLabel,
      primarySessionDir: paths.primarySessionDir,
      configRoot: paths.configRoot,
      ...(profile.probe.configuredSessionPath
        ? { configuredValuePath: profile.probe.configuredSessionPath.valuePath.join(".") }
        : {}),
    },
  };
}

function formatDisplayCommand(command: HarnessMessagingCommand): string {
  return command.argv
    .map((argument) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument) ? argument : shellQuote(argument),
    )
    .join(" ");
}

function readStatusProbe(value: unknown): HarnessWhatsappStatusProbe | null {
  if (!isObjectRecord(value)) return null;
  const pairingCommand = readFixedCommand(value.pairingCommand);
  if (!pairingCommand) return null;
  if (value.kind === "channel-status-json") {
    const command = readFixedCommand(value.command);
    const timeoutOption = value.timeoutOption;
    if (
      !command ||
      (timeoutOption !== undefined &&
        (typeof timeoutOption !== "string" || !/^--[a-z][a-z0-9-]*$/u.test(timeoutOption)))
    ) {
      return null;
    }
    return {
      kind: value.kind,
      command,
      pairingCommand,
      ...(typeof timeoutOption === "string" ? { timeoutOption } : {}),
    };
  }
  if (value.kind !== "session-files") return null;
  const primaryCredentialPath = readRelativePath(value.primaryCredentialPath);
  const alternateCredentialPath = readRelativePath(value.alternateCredentialPath);
  const primaryLabel = readBoundedText(value.primaryLabel);
  const alternateLabel = readBoundedText(value.alternateLabel);
  if (!primaryCredentialPath || !alternateCredentialPath || !primaryLabel || !alternateLabel) {
    return null;
  }
  let configuredSessionPath:
    | Extract<
        HarnessWhatsappStatusProbe,
        { readonly kind: "session-files" }
      >["configuredSessionPath"]
    | undefined;
  if (value.configuredSessionPath !== undefined) {
    if (!isObjectRecord(value.configuredSessionPath)) return null;
    const configPath = readRelativePath(value.configuredSessionPath.configPath);
    const valuePath = readCanonicalValuePath(value.configuredSessionPath.valuePath);
    if (!configPath || !valuePath) return null;
    configuredSessionPath = { configPath, valuePath };
  }
  return {
    kind: value.kind,
    primaryCredentialPath,
    alternateCredentialPath,
    primaryLabel,
    alternateLabel,
    pairingCommand,
    ...(configuredSessionPath ? { configuredSessionPath } : {}),
  };
}

function readFixedCommand(value: unknown): HarnessMessagingCommand | null {
  if (!isObjectRecord(value) || !Array.isArray(value.argv)) return null;
  if (value.argv.length < 1 || value.argv.length > 16) return null;
  const argv = value.argv.map(readBoundedText);
  return argv.every((argument): argument is string => argument !== null) ? { argv } : null;
}

function readCanonicalValuePath(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  return value.every(
    (segment): segment is string =>
      typeof segment === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment),
  )
    ? value
    : null;
}

function readBoundedText(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 8_192 &&
    !/[\0\r\n]/u.test(value)
    ? value
    : null;
}

function readRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256 || !SAFE_RELATIVE_PATH.test(value)) {
    return null;
  }
  return value.split("/").every((segment) => segment !== "." && segment !== "..") ? value : null;
}

function readConfigRoot(value: unknown): string | null {
  return typeof value === "string" && SAFE_CONFIG_ROOT.test(value) ? value : null;
}

function configRootToSandboxPath(configRoot: string): string | null {
  const normalized = readConfigRoot(configRoot);
  return normalized ? `/sandbox/${normalized.slice(2)}` : null;
}

function resolveContainedConfigPath(configRoot: string, relativePath: string): string | null {
  const normalized = readRelativePath(relativePath);
  if (!normalized) return null;
  const resolved = path.posix.join(configRoot, normalized);
  return resolved.startsWith(`${configRoot}/`) ? resolved : null;
}

function runDeclaredStatusProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
  profile: StatusProfile,
): ProbeResult {
  return profile.probe.kind === "channel-status-json"
    ? runChannelStatusJsonProbe(execute, sandboxName, timeoutMs, profile.probe)
    : runSessionFilesProbe(
        execute,
        sandboxName,
        timeoutMs,
        profile.probe,
        profile.configRoot as string,
      );
}

export function createWhatsappStatusHealthHookRegistration(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createWhatsappStatusHealthHook(options),
  };
}

type ChannelStatusWhatsappState = {
  readonly configured?: unknown;
  readonly statusState?: unknown;
  readonly linked?: unknown;
  readonly running?: unknown;
  readonly connected?: unknown;
  readonly healthState?: unknown;
  readonly lastInboundAt?: unknown;
  readonly lastStopAt?: unknown;
  readonly lastDisconnect?: unknown;
  readonly reconnectAttempts?: unknown;
};

type ValidatedChannelStatusWhatsappState = ChannelStatusWhatsappState & {
  readonly linked: boolean;
  readonly running: boolean;
  readonly connected: boolean;
};

type ProbeResult = {
  readonly probeReachable: boolean;
  readonly paired: boolean | null;
  readonly bridgeProcessAlive: boolean | null;
  readonly heartbeat: WhatsappHeartbeat | null;
  readonly recentLogSignals: readonly string[];
  readonly sessionLocations?: WhatsappSessionLocations;
};

const PROBE_UNREACHABLE: ProbeResult = {
  probeReachable: false,
  paired: null,
  bridgeProcessAlive: null,
  heartbeat: null,
  recentLogSignals: [],
};

/**
 * Run the package-declared status command and translate its bounded JSON
 * response into the evaluator's probe-input shape.
 */
function runChannelStatusJsonProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
  probe: Extract<HarnessWhatsappStatusProbe, { readonly kind: "channel-status-json" }>,
): ProbeResult {
  const argv = [
    ...probe.command.argv,
    ...(probe.timeoutOption ? [probe.timeoutOption, String(timeoutMs)] : []),
  ];
  const command = formatDisplayCommand({ argv });
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(sandboxName, command, timeoutMs);
  } catch {
    return PROBE_UNREACHABLE;
  }
  // A non-zero exec (timeout/kill/unhealthy sandbox) can still carry partial
  // stdout; require a clean exit before trusting the probe. Otherwise a
  // stalled status invocation could yield unparseable JSON that reads as a
  // fabricated verdict instead of classifying as probe_failed.
  if (!exec || exec.status !== 0) return PROBE_UNREACHABLE;
  const json = parseChannelStatusJson(String(exec.stdout ?? ""));
  if (!json) return PROBE_UNREACHABLE;
  const channelAccounts = readObject(json.channelAccounts);
  // Successful status responses expose live channel/account maps and omit
  // `gatewayReachable`; only the CLI's config-only failure response sets that
  // field to false. Honor an explicit reachability bit when present, while
  // accepting the canonical successful shape only when a live map exists.
  if (!isReachableGatewayStatusPayload(json, channelAccounts)) {
    return PROBE_UNREACHABLE;
  }
  const waLookup = readWhatsappState(json, channelAccounts);
  if (waLookup.kind === "invalid") return PROBE_UNREACHABLE;
  const wa = waLookup.kind === "found" ? waLookup.state : null;

  if (!wa) {
    // No authoritative WhatsApp account. The exact legacy unknown-channel
    // error means WhatsApp is not configured; otherwise the reachable gateway
    // simply did not include live WhatsApp status. Leave runtime fields null so
    // the evaluator lands on an honest "unknown" verdict in either case.
    return {
      probeReachable: true,
      paired: null,
      bridgeProcessAlive: null,
      heartbeat: null,
      recentLogSignals: [describeMissingWaChannel(json)],
    };
  }
  if (!hasRequiredWhatsappLiveness(wa)) return PROBE_UNREACHABLE;
  return mapChannelStatusWaState(wa);
}

function runSessionFilesProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
  probe: Extract<HarnessWhatsappStatusProbe, { readonly kind: "session-files" }>,
  configRoot: string,
): ProbeResult {
  const paths = resolveSessionProbePaths(configRoot, probe);
  if (!paths) return PROBE_UNREACHABLE;
  const configuredProbeTimeoutMs = Math.floor(timeoutMs / 4);
  const configProbeTimeoutMs = Math.floor(timeoutMs / 4);
  const defaultProbeTimeoutMs = timeoutMs - configProbeTimeoutMs - configuredProbeTimeoutMs;
  const defaultLocations = probeSessionFiles(
    execute,
    sandboxName,
    paths.primaryCredential,
    paths.alternateCredential,
    defaultProbeTimeoutMs,
  );
  if (!defaultLocations) return PROBE_UNREACHABLE;
  if (defaultLocations.gatewaySessionCreds !== false) {
    return sessionProbeResult(defaultLocations, "default");
  }

  // The default-path check, config read, and configured-path check share one
  // caller-supplied timeout budget. For sub-millisecond fallback budgets, keep
  // the successful default result instead of starting an unbounded extra probe.
  if (configProbeTimeoutMs < 1 || configuredProbeTimeoutMs < 1) {
    return sessionProbeResult(defaultLocations, "default");
  }
  const configured = readConfiguredSessionDir(
    execute,
    sandboxName,
    configProbeTimeoutMs,
    probe,
    paths,
  );
  if (configured.source !== "config") {
    return sessionProbeResult(defaultLocations, configured.source);
  }
  const configuredLocations = probeSessionFiles(
    execute,
    sandboxName,
    path.posix.join(configured.dir, path.posix.basename(paths.primaryCredential)),
    paths.alternateCredential,
    configuredProbeTimeoutMs,
  );
  if (!configuredLocations) return sessionProbeResult(defaultLocations, "default");
  return sessionProbeResult(configuredLocations, "config", configured.dir);
}

function sessionProbeResult(
  locations: WhatsappSessionLocations,
  gatewaySessionPathSource: SessionPathSource,
  gatewaySessionDir?: string,
): ProbeResult {
  const gatewaySession = locations.gatewaySessionCreds === true;
  return {
    probeReachable: true,
    paired: gatewaySession ? null : false,
    bridgeProcessAlive: null,
    heartbeat: null,
    recentLogSignals: [],
    sessionLocations: {
      ...locations,
      gatewaySessionPathSource,
      ...(gatewaySessionDir === undefined ? {} : { gatewaySessionDir }),
    },
  };
}

function probeSessionFiles(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  primaryCredential: string,
  alternateCredential: string,
  timeoutMs: number,
): WhatsappSessionLocations | null {
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(
      sandboxName,
      sessionFilesProbeCommand(primaryCredential, alternateCredential),
      timeoutMs,
    );
  } catch {
    return null;
  }
  if (!exec || exec.status !== 0) return null;
  return parseSessionFilesProbe(String(exec.stdout ?? ""));
}

type SessionPathSource = NonNullable<WhatsappSessionLocations["gatewaySessionPathSource"]>;

type SessionProbePaths = {
  readonly configRoot: string;
  readonly primaryCredential: string;
  readonly alternateCredential: string;
  readonly primarySessionDir: string;
  readonly alternateSessionDir: string;
  readonly configPath?: string;
};

function resolveSessionProbePaths(
  configRoot: string,
  probe: Extract<HarnessWhatsappStatusProbe, { readonly kind: "session-files" }>,
): SessionProbePaths | null {
  const absoluteRoot = configRootToSandboxPath(configRoot);
  if (!absoluteRoot) return null;
  const primaryCredential = resolveContainedConfigPath(absoluteRoot, probe.primaryCredentialPath);
  const alternateCredential = resolveContainedConfigPath(
    absoluteRoot,
    probe.alternateCredentialPath,
  );
  const configPath = probe.configuredSessionPath
    ? resolveContainedConfigPath(absoluteRoot, probe.configuredSessionPath.configPath)
    : undefined;
  if (!primaryCredential || !alternateCredential || (probe.configuredSessionPath && !configPath)) {
    return null;
  }
  return {
    configRoot: absoluteRoot,
    primaryCredential,
    alternateCredential,
    primarySessionDir: path.posix.dirname(primaryCredential),
    alternateSessionDir: path.posix.dirname(alternateCredential),
    ...(configPath ? { configPath } : {}),
  };
}

function readConfiguredSessionDir(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
  probe: Extract<HarnessWhatsappStatusProbe, { readonly kind: "session-files" }>,
  paths: SessionProbePaths,
): { readonly dir: string; readonly source: SessionPathSource } {
  const fallback = { dir: paths.primarySessionDir, source: "default" } as const;
  const configured = probe.configuredSessionPath;
  if (!configured || !paths.configPath) return fallback;
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(
      sandboxName,
      configuredSessionPathCommand(paths.configPath, configured.valuePath),
      timeoutMs,
    );
  } catch {
    return fallback;
  }
  if (!exec || exec.status !== 0) return fallback;
  const configuredDir = parseConfiguredSessionPath(String(exec.stdout ?? ""));
  if (configuredDir === undefined || configuredDir === null) return fallback;
  if (!isSupportedSessionDir(configuredDir, paths.configRoot)) {
    return { dir: paths.primarySessionDir, source: "unsupported" };
  }
  if (configuredDir === paths.primarySessionDir) return fallback;
  return { dir: configuredDir, source: "config" };
}

function configuredSessionPathCommand(configPath: string, valuePath: readonly string[]): string {
  const script = [
    "import json",
    "from pathlib import Path",
    "import yaml",
    `config = yaml.safe_load(Path(${JSON.stringify(configPath)}).read_text(encoding=\"utf-8\"))`,
    "def child(value, key):",
    "    return value.get(key) if isinstance(value, dict) else None",
    "node = config",
    ...valuePath.map((key) => `node = child(node, ${JSON.stringify(key)})`),
    `print(${JSON.stringify(CONFIG_PROBE_SENTINEL)})`,
    "print(json.dumps(node))",
  ].join("\n");
  return `python3 -c ${shellQuote(script)}`;
}

function parseConfiguredSessionPath(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2 || lines[0] !== CONFIG_PROBE_SENTINEL) return undefined;
  try {
    return JSON.parse(lines[1]);
  } catch {
    return undefined;
  }
}

function isSupportedSessionDir(value: unknown, configRoot: string): value is string {
  if (typeof value !== "string" || !value.startsWith(`${configRoot}/`)) return false;
  if (value.includes("\\") || path.posix.normalize(value) !== value) return false;
  return value
    .slice(configRoot.length + 1)
    .split("/")
    .every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== "." && segment !== "..");
}

function sessionFilesProbeCommand(primaryCredential: string, alternateCredential: string): string {
  return [
    `gateway=${shellQuote(primaryCredential)}`,
    `dashboard=${shellQuote(alternateCredential)}`,
    `printf '%s\\n' '${SESSION_PROBE_SENTINEL}'`,
    'if [ -f "$gateway" ]; then printf "%s\\n" "GATEWAY_SESSION=present"; else printf "%s\\n" "GATEWAY_SESSION=missing"; fi',
    'if [ -f "$dashboard" ]; then printf "%s\\n" "DASHBOARD_SESSION=present"; else printf "%s\\n" "DASHBOARD_SESSION=missing"; fi',
  ].join("; ");
}

function parseSessionFilesProbe(stdout: string): WhatsappSessionLocations | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.includes(SESSION_PROBE_SENTINEL)) return null;
  const gateway = readProbeBoolean(lines, "GATEWAY_SESSION");
  const dashboard = readProbeBoolean(lines, "DASHBOARD_SESSION");
  if (gateway === null || dashboard === null) return null;
  return { gatewaySessionCreds: gateway, dashboardSessionCreds: dashboard };
}

function readProbeBoolean(lines: readonly string[], key: string): boolean | null {
  const match = lines.find((line) => line === `${key}=present` || line === `${key}=missing`);
  if (match === `${key}=present`) return true;
  if (match === `${key}=missing`) return false;
  return null;
}

function hasRequiredWhatsappLiveness(
  wa: ChannelStatusWhatsappState,
): wa is ValidatedChannelStatusWhatsappState {
  return (
    typeof wa.linked === "boolean" &&
    typeof wa.running === "boolean" &&
    typeof wa.connected === "boolean"
  );
}

function mapChannelStatusWaState(wa: ValidatedChannelStatusWhatsappState): ProbeResult {
  const { linked, running, connected } = wa;
  const healthState = readStringValue(wa.healthState);
  const heartbeat: WhatsappHeartbeat | null = running
    ? {
        connectionState: channelStatusConnectionState(connected, healthState),
        lastInboundAt: epochMsToIso(wa.lastInboundAt),
        // The common status JSON does not expose a cumulative inbound counter —
        // the evaluator treats `null` here as "not reported" rather than
        // "zero", which is the accurate reading.
        messagesHandled: null,
        // Never copy the bridge's free-text `lastError` — it can carry phone
        // numbers and message bodies. If the evaluator needs error signal it
        // reads healthState/connectionState instead.
        noteCategory: null,
      }
    : null;
  return {
    probeReachable: true,
    // linked is the authoritative pairing bit; the credentials-directory
    // check that used to sit here mistook half-written state as pairing.
    paired: linked,
    // running is the authoritative liveness bit; the pgrep check that used
    // to sit here could not see the in-process bridge, and the gateway-log
    // breadcrumbs are append-only so they survived a stopped bridge.
    bridgeProcessAlive: running,
    heartbeat,
    recentLogSignals: summarizeChannelStatus(healthState, wa.reconnectAttempts),
  };
}

function channelStatusConnectionState(connected: boolean, healthState: string | null): string {
  if (connected) return "open";
  return healthState === "starting" || healthState === "stale" ? "connecting" : "close";
}

// The documented healthState enum. `readStringValue` would otherwise pass
// arbitrary external text through, so any non-enum value is mapped to a fixed
// "unknown" token before it can reach diagnostics (redaction contract).
const KNOWN_HEALTH_STATES: ReadonlySet<string> = new Set([
  "starting",
  "healthy",
  "stale",
  "stopped",
]);

// Never emit raw error text or self.* PII. Only the healthState enum and
// reconnectAttempts (a non-negative integer) are surfaced, and only when they
// carry non-healthy signal.
function summarizeChannelStatus(
  healthState: string | null,
  reconnectAttemptsRaw: unknown,
): readonly string[] {
  const parts: string[] = [];
  if (healthState !== null && healthState !== "healthy") {
    parts.push(`healthState=${KNOWN_HEALTH_STATES.has(healthState) ? healthState : "unknown"}`);
  }
  const reconnectAttempts =
    typeof reconnectAttemptsRaw === "number" && Number.isFinite(reconnectAttemptsRaw)
      ? reconnectAttemptsRaw
      : null;
  if (reconnectAttempts !== null && reconnectAttempts > 0) {
    parts.push(`reconnectAttempts=${reconnectAttempts}`);
  }
  return parts.length > 0 ? [parts.join("; ")] : [];
}

function parseChannelStatusJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    // `--json` is a strict machine-readable contract. Do not scan past an
    // arbitrary stdout preamble and then trust a later object as gateway
    // status; an exact documented prefix can be handled here if one exists.
    return null;
  }
}

function isReachableGatewayStatusPayload(
  json: Record<string, unknown>,
  channelAccounts: Record<string, unknown> | null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(json, "gatewayReachable")) {
    return json.gatewayReachable === true;
  }
  return channelAccounts !== null;
}

type WhatsappStateLookup =
  | { readonly kind: "found"; readonly state: ChannelStatusWhatsappState }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/**
 * The typed channel-status operation exposes live per-account state under
 * `channelAccounts.whatsapp` and names the authoritative account through
 * `channelDefaultAccountId.whatsapp`. Select that exact account rather than
 * trusting array order or the channel-level summary. A summary-only response
 * is outside the declared operation contract and fails closed.
 */
function readWhatsappState(
  json: Record<string, unknown>,
  channelAccounts: Record<string, unknown> | null,
): WhatsappStateLookup {
  if (!Object.prototype.hasOwnProperty.call(json, "channelAccounts")) return { kind: "invalid" };
  if (!channelAccounts) return { kind: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(channelAccounts, "whatsapp")) {
    return { kind: "missing" };
  }

  const rawAccounts = channelAccounts.whatsapp;
  if (!Array.isArray(rawAccounts)) return { kind: "invalid" };
  const accounts: Record<string, unknown>[] = [];
  for (const rawAccount of rawAccounts) {
    const account = readObject(rawAccount);
    if (!account) return { kind: "invalid" };
    accounts.push(account);
  }
  if (accounts.length === 0) return { kind: "missing" };

  const defaultAccountIds = readObject(json.channelDefaultAccountId);
  const defaultAccountId = defaultAccountIds ? readStringValue(defaultAccountIds.whatsapp) : null;
  if (!defaultAccountId) return { kind: "invalid" };
  const matches = accounts.filter(
    (account) => readStringValue(account.accountId) === defaultAccountId,
  );
  return matches.length === 1 ? { kind: "found", state: matches[0] } : { kind: "invalid" };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasUnknownChannelError(json: Record<string, unknown>): boolean {
  return readStringValue(json.error) === "unknown channel: whatsapp";
}

// The CLI can report missing WhatsApp status with the exact
// `error: "unknown channel: whatsapp"` when WhatsApp is not configured. A
// canonical successful payload can also omit that channel without an error.
// Emit fixed diagnostic strings only — never the raw error, which can carry PII.
function describeMissingWaChannel(json: Record<string, unknown>): string {
  return hasUnknownChannelError(json)
    ? "whatsapp is not configured on the gateway — live health unavailable"
    : "gateway returned no live WhatsApp status";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The largest timestamp the ECMAScript Date type can represent; beyond it
// `new Date(v).toISOString()` throws RangeError. A garbage `lastInboundAt`
// from the gateway JSON must degrade to null, not crash the status command.
const MAX_ECMASCRIPT_DATE_MS = 8_640_000_000_000_000;

function epochMsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > MAX_ECMASCRIPT_DATE_MS) return null;
  return new Date(value).toISOString();
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
