// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessAgentRosterJsonObject } from "@nvidia/nemoclaw-harness-contract";

import type { AgentDefinition } from "../agent-runtime/manifest-types";
import { isObjectRecord } from "../core/json-types";

// Load YAML lazily via require to match the rest of the onboard pipeline
// (see src/lib/sandbox/config.ts and src/lib/policy/index.ts). Importing
// statically would force `yaml` into the CLI cold-start path even when no
// agents manifest is supplied.
type YamlLoader = { parse(input: string): unknown };
function loadYaml(): YamlLoader {
  return require("yaml") as YamlLoader;
}

const AGENTS_MANIFEST_MAX_BYTES = 64 * 1024;

// The host transports this data through the package build boundary. Reject
// obvious credential-named values before they can reach that boundary; a
// package then applies its own native schema. Normalising names catches
// composite forms such as `accessToken` and `private_key` as well as exact
// credential names.
const CREDENTIAL_NAME_SUBSTRINGS = [
  "apikey",
  "apitoken",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
  "idtoken",
  "secretkey",
  "signingkey",
  "encryptionkey",
  "privatekey",
  "publickey",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "bearer",
];
const CREDENTIAL_NAME_EXACT = new Set(["auth", "key"]);

function isCredentialName(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, "");
  if (CREDENTIAL_NAME_EXACT.has(normalised)) return true;
  return CREDENTIAL_NAME_SUBSTRINGS.some((needle) => normalised.includes(needle));
}

function assertNoCredentialFields(value: unknown, label: string): void {
  if (isObjectRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialName(key)) {
        throw new Error(
          `agents manifest field "${label}.${key}" looks like a credential and is not allowed; pass credentials through the OpenShell provider profile instead`,
        );
      }
      assertNoCredentialFields(child, `${label}.${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertNoCredentialFields(child, `${label}[${index}]`);
    });
  }
}

export type AgentsManifestPayload = HarnessAgentRosterJsonObject;

export class AgentRosterUnsupportedError extends Error {
  override readonly name = "AgentRosterUnsupportedError";
}

type AgentRosterDefinition = Pick<
  AgentDefinition,
  "agentRosterCapability" | "displayName" | "name"
>;

/** Require the selected package to explicitly own roster onboarding. */
export function assertAgentsManifestCapability(agent: AgentRosterDefinition | null): void {
  if (agent?.agentRosterCapability?.support === "managed") return;
  const displayName = agent?.displayName ?? agent?.name ?? "selected harness";
  throw new AgentRosterUnsupportedError(
    `--agents is not supported by ${displayName}; its package does not declare managed agent roster support.`,
  );
}

/** Resolve one operator-supplied roster manifest without selecting a harness implementation. */
export function resolveAgentsManifestPath(requestedPath: string | undefined): string | null {
  if (requestedPath === undefined) return null;
  const resolved = path.resolve(requestedPath);
  if (!fs.existsSync(resolved)) throw new Error(`--agents path not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`--agents must point to a file: ${resolved}`);
  }
  return resolved;
}

/**
 * Load a bounded, credential-free mapping. The selected package adapter owns
 * its native schema, path defaults, and detailed validation.
 */
export function loadAgentsManifest(filePath: string): AgentsManifestPayload {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    // Single fs call avoids the existsSync/statSync/readFileSync TOCTOU
    // window CodeQL flags as a race (CWE-367): the manifest path can change
    // between the pre-check and the read on a shared filesystem.
    raw = fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      throw new Error(`--agents path not found: ${resolved}`);
    }
    if (nodeErr?.code === "EISDIR") {
      throw new Error(`--agents must point to a file: ${resolved}`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`--agents read error: ${reason}`);
  }
  if (Buffer.byteLength(raw, "utf8") > AGENTS_MANIFEST_MAX_BYTES) {
    throw new Error("--agents manifest exceeds the 64 KiB input boundary");
  }
  let parsed: unknown;
  try {
    parsed = loadYaml().parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`--agents YAML parse error: ${reason}`);
  }
  if (parsed === null || parsed === undefined) {
    return { agents: [] };
  }
  if (!isObjectRecord(parsed)) {
    throw new Error("agents manifest must be a YAML mapping (object) at the top level");
  }
  const out = (Object.keys(parsed).length === 0 ? { agents: [] } : parsed) as AgentsManifestPayload;
  assertNoCredentialFields(out, "agents-manifest");
  return out;
}

/**
 * Read the manifest at `filePath` and set `NEMOCLAW_EXTRA_AGENTS_JSON` so
 * the downstream Dockerfile patcher can base64-encode and bake it. The
 * patcher does not parse or shape-check the payload. The selected package
 * owns detailed schema validation, so core keeps host-side checks bounded
 * and intentionally shallow.
 */
export function applyAgentsManifestEnv(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentsManifestPayload {
  const payload = loadAgentsManifest(filePath);
  env.NEMOCLAW_EXTRA_AGENTS_JSON = JSON.stringify(payload);
  return payload;
}
