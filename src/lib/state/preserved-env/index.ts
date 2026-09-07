// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingPlan,
} from "../../messaging/manifest/types";

export interface PreservedEnvInventory {
  readonly path: string;
  readonly patterns: readonly string[];
  readonly render_target: string;
  readonly legacy_render_target_optional?: boolean;
}

export interface PreservedEnvFile {
  readonly path: string;
  readonly assignments: readonly string[];
  readonly renderTarget?: string;
}

export const HERMES_PRESERVED_ENV_INVENTORY: readonly PreservedEnvInventory[] = [
  {
    path: ".env",
    patterns: ["*_HOME_CHANNEL", "*_HOME_CHANNEL_NAME", "*_HOME_CHANNEL_THREAD_ID"],
    render_target: "~/.hermes/.env",
    legacy_render_target_optional: true,
  },
];
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_ENV_KEY_RE = /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u;
const ENV_PATTERN_RE = /^[A-Z0-9_*]+$/;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_ENV_ASSIGNMENT_BYTES = 8192;

function envPatternRegex(pattern: string): RegExp {
  if (
    !ENV_PATTERN_RE.test(pattern) ||
    !pattern.includes("*") ||
    pattern.replaceAll("*", "").length === 0
  ) {
    throw new Error(`Invalid preserved environment pattern '${pattern}'`);
  }
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function isPreservedEnvKey(key: string, patterns: readonly string[]): boolean {
  return ENV_KEY_RE.test(key) && patterns.some((pattern) => envPatternRegex(pattern).test(key));
}

export function extractPreservedEnvAssignments(
  contents: string,
  inventory: PreservedEnvInventory,
): string[] {
  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error(`Preserved environment source '${inventory.path}' is too large`);
  }

  const assignments: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    if (!isPreservedEnvKey(key, inventory.patterns)) continue;
    if (seen.has(key)) {
      throw new Error(`Preserved environment source '${inventory.path}' repeats key '${key}'`);
    }
    if (/[\u0000-\u001f\u007f]/.test(line)) {
      throw new Error(`Preserved environment key '${key}' contains control characters`);
    }
    const assignment = `${key}=${match[2] ?? ""}`;
    if (Buffer.byteLength(assignment, "utf8") > MAX_ENV_ASSIGNMENT_BYTES) {
      throw new Error(`Preserved environment key '${key}' is too large`);
    }
    seen.add(key);
    assignments.push(assignment);
  }
  return assignments;
}

export function validatePreservedEnvFiles(
  files: unknown,
  inventories: readonly PreservedEnvInventory[],
): files is PreservedEnvFile[] {
  if (!Array.isArray(files)) return false;
  const inventoryByPath = new Map(inventories.map((inventory) => [inventory.path, inventory]));
  const seenPaths = new Set<string>();
  return files.every((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => key !== "path" && key !== "assignments" && key !== "renderTarget",
      ) ||
      typeof record.path !== "string" ||
      (record.renderTarget !== undefined && typeof record.renderTarget !== "string") ||
      !Array.isArray(record.assignments) ||
      seenPaths.has(record.path)
    ) {
      return false;
    }
    const inventory = inventoryByPath.get(record.path);
    if (
      !inventory ||
      (record.renderTarget === undefined
        ? !inventory.legacy_render_target_optional
        : record.renderTarget !== inventory.render_target)
    ) {
      return false;
    }
    const seenKeys = new Set<string>();
    for (const assignment of record.assignments) {
      if (
        typeof assignment !== "string" ||
        /[\r\n\u0000]/.test(assignment) ||
        Buffer.byteLength(assignment, "utf8") > MAX_ENV_ASSIGNMENT_BYTES
      ) {
        return false;
      }
      const separator = assignment.indexOf("=");
      if (separator <= 0) return false;
      const key = assignment.slice(0, separator);
      if (!isPreservedEnvKey(key, inventory.patterns) || seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
    }
    seenPaths.add(record.path);
    return true;
  });
}

export function mergePreservedEnvironmentIntoMessagingPlan(
  plan: SandboxMessagingPlan,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): SandboxMessagingPlan;
export function mergePreservedEnvironmentIntoMessagingPlan(
  plan: null,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): null;
export function mergePreservedEnvironmentIntoMessagingPlan(
  plan: SandboxMessagingPlan | null,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): SandboxMessagingPlan | null {
  if (!plan || !preservedFiles || preservedFiles.length === 0) {
    return plan;
  }
  const enabledChannels = plan.channels.filter((channel) => channel.active && !channel.disabled);
  const preservedRenders = preservedFiles.flatMap((file, index) => {
    const target =
      file.renderTarget ??
      (plan.packageBuild === undefined && plan.agent === "hermes" && file.path === ".env"
        ? "~/.hermes/.env"
        : null);
    if (
      !target ||
      !isCanonicalHomeRenderTarget(target) ||
      file.assignments.some((assignment) => {
        const separator = assignment.indexOf("=");
        const key = separator > 0 ? assignment.slice(0, separator) : "";
        return (
          !ENV_KEY_RE.test(key) ||
          SECRET_ENV_KEY_RE.test(key) ||
          /[\r\n\u0000]/u.test(assignment) ||
          Buffer.byteLength(assignment, "utf8") > MAX_ENV_ASSIGNMENT_BYTES
        );
      })
    ) {
      throw new Error("Invalid preserved environment assignments");
    }
    if (file.assignments.length === 0) return [];
    if (enabledChannels.length === 0) {
      throw new Error("Cannot restore preserved environment without an enabled messaging channel");
    }
    const activeChannel =
      enabledChannels.find((channel) =>
        plan.agentRender.some(
          (render) =>
            render.channelId === channel.channelId &&
            render.kind === "env-lines" &&
            render.agent === plan.agent &&
            render.target === target,
        ),
      ) ?? enabledChannels[0];
    const renderId = `preserved-environment-${String(index + 1)}`;
    const render: SandboxMessagingEnvLinesRenderPlan = {
      channelId: activeChannel.channelId,
      renderId,
      hookId: renderId,
      handler: "common.staticOutputs",
      kind: "env-lines",
      agent: plan.agent,
      target,
      lines: file.assignments,
      templateRefs: [],
    };
    return [render];
  });
  if (preservedRenders.length === 0) return plan;
  return {
    ...plan,
    // Preserved values are applied first. A current manifest render for the
    // same key remains authoritative because the env merger processes it later.
    agentRender: [...preservedRenders, ...plan.agentRender],
  };
}

function isCanonicalHomeRenderTarget(target: string): boolean {
  if (!target.startsWith("~/") || target.includes("\\")) return false;
  const segments = target.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/u.test(segment),
    )
  );
}
