// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CredentialEnvCleanupPlan = {
  readonly credentialBindings: readonly { readonly providerEnvKey?: unknown }[];
  readonly agentRender?: readonly { readonly kind: string; readonly target: string }[];
};

const EXPORT_PREFIX = /^export[ \t]+/;

export function readEnvLineKey(line: string): string | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim().replace(EXPORT_PREFIX, "").trim();
  return key.length > 0 ? key : null;
}

function ownedCredentialEnvKeys(plan: CredentialEnvCleanupPlan): ReadonlySet<string> {
  return new Set(
    plan.credentialBindings.flatMap((binding) =>
      typeof binding.providerEnvKey === "string" && binding.providerEnvKey.length > 0
        ? [binding.providerEnvKey]
        : [],
    ),
  );
}

export function staleCredentialEnvKeys(
  plan: CredentialEnvCleanupPlan,
  rendered: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...ownedCredentialEnvKeys(plan)].filter((key) => !rendered.has(key)));
}

export function migrationOnlyEnvTargets(
  plan: CredentialEnvCleanupPlan,
  renderedTargets: ReadonlySet<string>,
): readonly string[] {
  if (ownedCredentialEnvKeys(plan).size === 0) return [];
  const targets = (plan.agentRender ?? [])
    .filter((entry) => entry.kind === "env-lines")
    .map((entry) => entry.target);
  return [...new Set(targets)].filter((target) => !renderedTargets.has(target));
}
