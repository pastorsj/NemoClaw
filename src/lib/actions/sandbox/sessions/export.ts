// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import type {
  HarnessSessionAdapterHostModule,
  HarnessSessionExportIndexOutput,
  HarnessSessionExportPlan,
  HarnessSessionExportPlanRequest,
} from "../../../agent-runtime/session-module";
import { CLI_NAME } from "../../../cli/branding";
import {
  runWithDeferredSandboxLifecycleExit,
  deferSandboxLifecycleExit,
} from "../../../core/process-exit";
import { shellQuote } from "../../../core/shell-quote";
import { resolveHostPathFromCwd } from "../host-path";
import { WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { assertDownloadedFile } from "./download-verify";
import {
  exportLegacySandboxSessions,
  type SessionExportEntry,
  type SessionsExportFormat,
  type SessionsExportOptions,
  type SessionsExportResult,
} from "./legacy-export";
import {
  assertSessionCommandAvailable,
  confirmSessionCommandAuthority,
  ensureLiveSessionSandbox,
  resolveSessionCommandAuthority,
  type SessionCommandAuthority,
  withSessionCommandLock,
} from "./command-authority";

export type {
  SessionExportEntry,
  SessionsExportFormat,
  SessionsExportOptions,
  SessionsExportResult,
} from "./legacy-export";

const SESSION_INDEX_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_EXPORTED_SESSIONS = 10_000;
const MAX_EXPORTED_FILES = 20_000;
const MAX_FILE_NAME_LENGTH = 255;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_SANDBOX_PATH = /^\/sandbox\/[A-Za-z0-9._/-]+$/u;
const STAGING_DIRECTORY = "/sandbox/.nemoclaw-staging";

function stopSessionExport(message: string): never {
  throw new Error(message);
}

function createStagingFiles(): HarnessSessionExportPlanRequest["stagingFiles"] {
  const suffix = randomBytes(12).toString("hex");
  return Object.freeze({
    tar: `${STAGING_DIRECTORY}/sessions-export-${suffix}.tgz`,
    jsonl: `${STAGING_DIRECTORY}/sessions-export-${suffix}.jsonl`,
  });
}

function buildExportRequest(options: SessionsExportOptions): HarnessSessionExportPlanRequest {
  return {
    agent: options.agent ?? null,
    keys: options.keys ?? [],
    format: options.format === "tar" ? "tar" : "dir",
    includeTrajectory: options.includeTrajectory === true,
    stagingFiles: createStagingFiles(),
  };
}

function buildSessionExportPlan(
  authority: SessionCommandAuthority,
  request: HarnessSessionExportPlanRequest,
): HarnessSessionExportPlan {
  try {
    return authority.adapter.buildSessionExportPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionExport(
      `The installed harness could not build a session-export plan: ${detail}`,
    );
  }
}

function confirmSessionExportPlan(
  sandboxName: string,
  authority: SessionCommandAuthority,
  request: HarnessSessionExportPlanRequest,
  expectedPlan: HarnessSessionExportPlan,
) {
  const adapter = confirmSessionCommandAuthority(sandboxName, authority.identity);
  let currentPlan: HarnessSessionExportPlan;
  try {
    currentPlan = adapter.buildSessionExportPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionExport(`The installed harness session-export plan changed: ${detail}`);
  }
  if (!isDeepStrictEqual(currentPlan, expectedPlan)) {
    stopSessionExport("The installed harness session-export plan changed before mutation.");
  }
  return adapter;
}

function requireSafeSandboxPath(value: string, label: string): string {
  if (
    !SAFE_SANDBOX_PATH.test(value) ||
    path.posix.normalize(value) !== value ||
    value.includes("/../") ||
    value.endsWith("/..")
  ) {
    return stopSessionExport(`The installed harness returned an unsafe ${label}.`);
  }
  return value;
}

function requireSafeFileName(value: string): string {
  if (
    value.length > MAX_FILE_NAME_LENGTH ||
    !SAFE_FILE_NAME.test(value) ||
    value === "." ||
    value === ".."
  ) {
    return stopSessionExport(
      `Refusing to export: the installed harness returned unsafe file name '${value}'.`,
    );
  }
  return value;
}

function validateExportSelection(
  selection: Extract<HarnessSessionExportIndexOutput, { readonly kind: "selection" }>,
): void {
  if (selection.sessions.length > MAX_EXPORTED_SESSIONS) {
    stopSessionExport(`Refusing to export more than ${MAX_EXPORTED_SESSIONS} sessions.`);
  }
  if (selection.relativeFiles.length > MAX_EXPORTED_FILES) {
    stopSessionExport(`Refusing to export more than ${MAX_EXPORTED_FILES} files.`);
  }
  const files = new Set<string>();
  for (const file of selection.relativeFiles) {
    requireSafeFileName(file);
    if (files.has(file)) stopSessionExport(`Refusing duplicate session export file '${file}'.`);
    files.add(file);
  }
  const ids = new Set<string>();
  for (const session of selection.sessions) {
    requireSafeFileName(session.sessionId);
    if (ids.has(session.sessionId)) {
      stopSessionExport(`Refusing duplicate exported session id '${session.sessionId}'.`);
    }
    ids.add(session.sessionId);
  }
}

function captureSessionIndex(sandboxName: string, command: readonly string[]): string {
  const result = captureOpenshell(["sandbox", "exec", "--name", sandboxName, "--", ...command], {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: SESSION_INDEX_CAPTURE_MAX_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to list sessions in sandbox '${sandboxName}' (exit ${result.status}). Verify the sandbox is live with \`${CLI_NAME} ${sandboxName} status\`.`,
    );
  }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    throw new Error("Session index output exceeded NemoClaw's 64 MiB capture boundary.");
  }
  return typeof result.stdout === "string" ? result.stdout : result.output;
}

function interpretExportIndex(
  adapter: HarnessSessionAdapterHostModule,
  plan: Extract<HarnessSessionExportPlan, { readonly kind: "indexed-files" }>,
  request: HarnessSessionExportPlanRequest,
  output: string,
): Extract<HarnessSessionExportIndexOutput, { readonly kind: "selection" }> {
  let interpreted: HarnessSessionExportIndexOutput;
  try {
    interpreted = adapter.interpretSessionExportIndex({
      output,
      agent: plan.agent,
      selectedKeys: plan.selectedKeys,
      includeTrajectory: request.includeTrajectory,
      hiddenSessionIdPrefix: WARMUP_SESSION_ID_PREFIX,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionExport(
      `The installed harness could not interpret its session index: ${detail}`,
    );
  }
  if (interpreted.kind === "refused") stopSessionExport(interpreted.reason);
  validateExportSelection(interpreted);
  if (interpreted.relativeFiles.length === 0) {
    stopSessionExport(`Refusing to export: '${plan.agent}' has no sessions to bundle.`);
  }
  return interpreted;
}

function createHostStagingPath(hostDestination: string, prefix: string) {
  const absoluteDestination = path.resolve(hostDestination);
  const directory = fs.mkdtempSync(path.join(path.dirname(absoluteDestination), prefix));
  return Object.freeze({
    directory,
    file: path.join(directory, path.basename(absoluteDestination)),
  });
}

function removeHostStagingDirectory(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `  Warning: failed to remove local staging directory '${directory}': ${(error as Error).message}. It may contain session data; remove it manually.`,
    );
  }
}

function removeRemoteStagingFile(sandboxName: string, remoteFile: string): void {
  const cleanup = runOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "rm", "-f", remoteFile],
    { ignoreError: true },
  );
  if (cleanup.status !== 0) {
    console.warn(
      `  Warning: failed to remove in-sandbox session staging file '${remoteFile}' from sandbox '${sandboxName}' (exit ${cleanup.status}). Remove it manually with \`${CLI_NAME} sandbox exec --name ${shellQuote(sandboxName)} -- rm -f ${shellQuote(remoteFile)}\`.`,
    );
  }
}

function hardenAndPublish(stagingFile: string, destination: string): void {
  fs.chmodSync(stagingFile, 0o600);
  fs.renameSync(stagingFile, destination);
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function secureRemoteCommand(command: readonly string[], remoteFile: string): string {
  if (command.at(-1) !== remoteFile) {
    stopSessionExport(
      "The installed harness native export command did not target its staging file.",
    );
  }
  const invocation = command.map(shellQuote).join(" ");
  return `umask 077 && mkdir -p ${shellQuote(STAGING_DIRECTORY)} && chmod 700 ${shellQuote(STAGING_DIRECTORY)} && ${invocation} && chmod 600 ${shellQuote(remoteFile)}`;
}

function tarCommand(sourceDirectory: string, remoteFile: string, files: readonly string[]): string {
  const argv = buildSandboxTarArgv({
    sourceDir: sourceDirectory,
    tarballRemote: remoteFile,
    resolvedFiles: files,
  });
  return `umask 077 && mkdir -p ${shellQuote(STAGING_DIRECTORY)} && chmod 700 ${shellQuote(STAGING_DIRECTORY)} && ${argv.map(shellQuote).join(" ")} && chmod 600 ${shellQuote(remoteFile)}`;
}

/** Build the core-owned archive argv after every package file name is validated. */
export function buildSandboxTarArgv(input: {
  readonly sourceDir: string;
  readonly tarballRemote: string;
  readonly resolvedFiles: readonly string[];
}): string[] {
  return [
    "tar",
    "-czf",
    input.tarballRemote,
    "-C",
    input.sourceDir,
    "--",
    ...input.resolvedFiles.map((file) => `./${file}`),
  ];
}

function downloadRemoteFile(input: {
  readonly sandboxName: string;
  readonly remoteFile: string;
  readonly hostDestination: string;
  readonly allowEmpty: boolean;
}): number | null {
  const staging = createHostStagingPath(input.hostDestination, ".sessions-export-");
  try {
    const download = runOpenshell(
      ["sandbox", "download", input.sandboxName, input.remoteFile, staging.file],
      { ignoreError: true, stdio: "inherit" },
    );
    assertDownloadedFile(download, staging.file, {
      remoteLabel: input.remoteFile,
      sandboxName: input.sandboxName,
      requireNonEmpty: !input.allowEmpty,
    });
    hardenAndPublish(staging.file, input.hostDestination);
  } finally {
    removeHostStagingDirectory(staging.directory);
  }
  return fileSize(input.hostDestination);
}

function resolveHostDestination(
  options: SessionsExportOptions,
  agent: string,
  format: SessionsExportFormat,
): string {
  if (options.out?.trim()) return resolveHostPathFromCwd(options.out.trim());
  if (format === "jsonl") return resolveHostPathFromCwd(`sessions-${options.sandboxName}.jsonl`);
  if (format === "tar") {
    return resolveHostPathFromCwd(`sessions-${options.sandboxName}-${agent}.tgz`);
  }
  return resolveHostPathFromCwd(`sessions-${options.sandboxName}/`);
}

function sessionEntriesForFiles(
  sessions: readonly { readonly key: string; readonly sessionId: string }[],
  hostDestination: string,
  format: "dir" | "tar",
): SessionExportEntry[] {
  return sessions.map((session) => {
    if (format === "tar") {
      return { ...session, path: null, sizeBytes: null };
    }
    const localPath = path.join(hostDestination, `${session.sessionId}.jsonl`);
    return { ...session, path: localPath, sizeBytes: fileSize(localPath) };
  });
}

function renderExportResult(result: SessionsExportResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result));
    return;
  }
  const size = result.bundleBytes === null ? "" : ` (${result.bundleBytes} byte(s))`;
  const scope =
    result.selectedKeys === "all"
      ? `all sessions for '${result.agent}' (${result.resolvedSessionIds.length} session(s))`
      : `${result.selectedKeys.length} key(s) for '${result.agent}'`;
  console.error(`  Exported ${scope} to ${result.hostDest}${size}`);
}

function executeIndexedExport(input: {
  readonly options: SessionsExportOptions;
  readonly authority: SessionCommandAuthority;
  readonly request: HarnessSessionExportPlanRequest;
  readonly plan: Extract<HarnessSessionExportPlan, { readonly kind: "indexed-files" }>;
}): SessionsExportResult {
  const sourceDirectory = requireSafeSandboxPath(input.plan.sourceDirectory, "session source path");
  const currentAdapter = confirmSessionExportPlan(
    input.options.sandboxName,
    input.authority,
    input.request,
    input.plan,
  );
  const output = captureSessionIndex(input.options.sandboxName, input.plan.indexCommand);
  const selection = interpretExportIndex(currentAdapter, input.plan, input.request, output);
  // The index command is read-only, but archive/download publication is not.
  // Close package and plan drift again at that mutation edge.
  confirmSessionExportPlan(input.options.sandboxName, input.authority, input.request, input.plan);

  const hostDestination = resolveHostDestination(
    input.options,
    input.plan.agent,
    input.plan.format,
  );
  let bundleBytes: number | null = null;
  if (input.plan.format === "tar") {
    const remoteFile = input.request.stagingFiles.tar;
    requireSafeSandboxPath(remoteFile, "tar staging path");
    const archive = runOpenshell(
      [
        "sandbox",
        "exec",
        "--name",
        input.options.sandboxName,
        "--",
        "sh",
        "-c",
        tarCommand(sourceDirectory, remoteFile, selection.relativeFiles),
      ],
      { ignoreError: true, stdio: "inherit" },
    );
    try {
      if (archive.status !== 0) {
        throw new Error(
          `Failed to archive sessions in sandbox '${input.options.sandboxName}' (exit ${archive.status}).`,
        );
      }
      bundleBytes = downloadRemoteFile({
        sandboxName: input.options.sandboxName,
        remoteFile,
        hostDestination,
        allowEmpty: false,
      });
    } finally {
      removeRemoteStagingFile(input.options.sandboxName, remoteFile);
    }
  } else {
    fs.mkdirSync(hostDestination, { recursive: true });
    const stagingDirectory = fs.mkdtempSync(path.join(hostDestination, ".sessions-export-"));
    try {
      for (const file of selection.relativeFiles) {
        const stagingFile = path.join(stagingDirectory, file);
        const download = runOpenshell(
          [
            "sandbox",
            "download",
            input.options.sandboxName,
            `${sourceDirectory}/${file}`,
            stagingFile,
          ],
          { ignoreError: true, stdio: "inherit" },
        );
        assertDownloadedFile(download, stagingFile, {
          remoteLabel: file,
          sandboxName: input.options.sandboxName,
        });
        hardenAndPublish(stagingFile, path.join(hostDestination, file));
      }
    } finally {
      removeHostStagingDirectory(stagingDirectory);
    }
  }

  const result: SessionsExportResult = {
    sandboxName: input.options.sandboxName,
    agent: input.plan.agent,
    format: input.plan.format,
    selectedKeys: input.plan.selectedKeys === "all" ? "all" : [...input.plan.selectedKeys],
    resolvedSessionIds: selection.sessions.map((session) => session.sessionId),
    resolvedFiles: [...selection.relativeFiles],
    hostDest: hostDestination,
    bundleBytes,
    sessions: sessionEntriesForFiles(selection.sessions, hostDestination, input.plan.format),
  };
  renderExportResult(result, input.options.json === true);
  return result;
}

function executeNativeFileExport(input: {
  readonly options: SessionsExportOptions;
  readonly authority: SessionCommandAuthority;
  readonly request: HarnessSessionExportPlanRequest;
  readonly plan: Extract<HarnessSessionExportPlan, { readonly kind: "native-file" }>;
}): SessionsExportResult {
  const remoteFile = requireSafeSandboxPath(input.plan.remoteFile, "native export staging path");
  if (remoteFile !== input.request.stagingFiles.jsonl) {
    stopSessionExport("The installed harness returned an unapproved native export staging path.");
  }
  const nativeCommand = secureRemoteCommand(input.plan.command, remoteFile);
  confirmSessionExportPlan(input.options.sandboxName, input.authority, input.request, input.plan);
  const hostDestination = resolveHostDestination(input.options, input.plan.agent, "jsonl");
  const hostParent = path.dirname(path.resolve(hostDestination));
  const hostProbe = fs.mkdtempSync(path.join(hostParent, ".sessions-export-probe-"));
  removeHostStagingDirectory(hostProbe);
  try {
    const nativeExport = runOpenshell(
      ["sandbox", "exec", "--name", input.options.sandboxName, "--", "sh", "-c", nativeCommand],
      { ignoreError: true, stdio: "inherit" },
    );
    if (nativeExport.status !== 0) {
      throw new Error(
        `Failed to export sessions in sandbox '${input.options.sandboxName}' (exit ${nativeExport.status}).`,
      );
    }
    const bundleBytes = downloadRemoteFile({
      sandboxName: input.options.sandboxName,
      remoteFile,
      hostDestination,
      allowEmpty: input.plan.allowEmpty,
    });
    const result: SessionsExportResult = {
      sandboxName: input.options.sandboxName,
      agent: input.plan.agent,
      format: "jsonl",
      selectedKeys: "all",
      resolvedSessionIds: [],
      resolvedFiles: [path.basename(hostDestination)],
      hostDest: hostDestination,
      bundleBytes,
      sessions: [],
    };
    renderExportResult(result, input.options.json === true);
    return result;
  } finally {
    removeRemoteStagingFile(input.options.sandboxName, remoteFile);
  }
}

export async function exportSandboxSessions(
  options: SessionsExportOptions,
): Promise<SessionsExportResult> {
  const authority = resolveSessionCommandAuthority(options.sandboxName);
  if (authority === null) return exportLegacySandboxSessions(options);

  return runWithDeferredSandboxLifecycleExit(() =>
    withSessionCommandLock(options.sandboxName, async () => {
      assertSessionCommandAvailable(options.sandboxName, "sandbox:sessions:export");
      const request = buildExportRequest(options);
      const plan = buildSessionExportPlan(authority, request);
      if (plan.kind === "unsupported" || plan.kind === "refused") {
        return stopSessionExport(plan.reason);
      }

      // Unsupported packages fail before this liveness probe or any host path mutation.
      await ensureLiveSessionSandbox(options.sandboxName, {
        allowNonReadyPhase: true,
        exit: deferSandboxLifecycleExit,
      });
      return plan.kind === "indexed-files"
        ? executeIndexedExport({ options, authority, request, plan })
        : executeNativeFileExport({ options, authority, request, plan });
    }),
  );
}
