// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Mirror of src/lib/sandbox/hermes-upstream-header.ts. The CLI production
// tsconfig excludes package source, while the Hermes image stages this package
// config module under its own runtime path. The parity test in
// src/lib/sandbox/hermes-upstream-header.parity.test.ts catches drift.

const HEADER_VALUE_MAX_LENGTH = 128;

function sanitizeHeaderValue(value: string): string {
  // Strip any character that could break out of the `# ...` comment line or
  // smuggle YAML into the document body (newlines, carriage returns, NUL,
  // any other C0/C1 control characters). Length-cap as defence in depth so a
  // pathological registry/session value cannot push the comment block past
  // a parser's line buffer.
  const stripped = value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return stripped.length > HEADER_VALUE_MAX_LENGTH
    ? stripped.slice(0, HEADER_VALUE_MAX_LENGTH)
    : stripped;
}

export function buildHermesUpstreamHeader(config: Record<string, unknown>): string {
  const upstream = config._nemoclaw_upstream;
  if (!upstream || typeof upstream !== "object") return "";
  const u = upstream as Record<string, unknown>;
  const rawProvider = typeof u.provider === "string" ? u.provider : "";
  const rawModel = typeof u.model === "string" ? u.model : "";
  const provider = sanitizeHeaderValue(rawProvider);
  const model = sanitizeHeaderValue(rawModel);
  if (!provider && !model) return "";

  const lines = ["# Managed by NemoClaw — Hermes configuration"];
  if (provider) lines.push(`# Upstream provider: ${provider}`);
  if (model) lines.push(`# Upstream model: ${model}`);
  lines.push("# OpenShell rewrites model.base_url to the upstream endpoint at request time.");
  return `${lines.join("\n")}\n`;
}
