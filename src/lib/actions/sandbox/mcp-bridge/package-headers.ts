// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpAttachedCredentialRevision } from "../mcp-bridge-provider-readiness";

const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";

function credentialPlaceholder(
  entry: { readonly env: readonly string[] },
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const envName = entry.env[0];
  if (!envName) return null;
  const revision = credentialRevision ? `${credentialRevision}_` : "";
  return `openshell:resolve:env:${revision}${envName}`;
}

export function authorizationValue(
  entry: { readonly env: readonly string[] },
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const placeholder = credentialPlaceholder(entry, credentialRevision);
  return placeholder ? `${DEFAULT_AUTH_SCHEME} ${placeholder}` : null;
}

/** Build opaque resolver headers without reading host credential values. */
export function entryHeaders(
  entry: { readonly env: readonly string[] },
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, string> {
  const authorization = authorizationValue(entry, credentialRevision);
  return authorization ? { [DEFAULT_AUTH_HEADER]: authorization } : {};
}
