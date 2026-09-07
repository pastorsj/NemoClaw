// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  importCliOpenShellProviderProfile,
  type CapturedProviderCommandResult,
  type CliOpenShellProviderProfileResult,
} from "./provider-adapter-cli";
import { endpointlessProviderProfilePath } from "./provider-profile";

const RECEIPT_PROVIDER_PROFILE_MAX_BYTES = 64 * 1024;

export type EndpointlessProviderProfileRunner = (
  args: string[],
  options: {
    readonly ignoreError: true;
    readonly suppressOutput?: boolean;
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly timeout: number;
  },
) => {
  readonly status?: number | null;
  readonly output?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly error?: unknown;
};

function capturedResult(
  result: ReturnType<EndpointlessProviderProfileRunner>,
): CapturedProviderCommandResult {
  return {
    status: result.status ?? null,
    output: result.output,
    stdout:
      typeof result.stdout === "string" || Buffer.isBuffer(result.stdout) ? result.stdout : null,
    stderr:
      typeof result.stderr === "string" || Buffer.isBuffer(result.stderr) ? result.stderr : null,
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

/** Normalize a legacy runner and delegate the registration protocol to the CLI adapter owner. */
export function registerCheckedInProviderProfile(input: {
  readonly profilePath: string;
  /** Exact receipt-verified source. Package callers must use this immutable import boundary. */
  readonly profileSource?: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly readProfileFile?: (profilePath: string) => string;
}): CliOpenShellProviderProfileResult {
  const run = (profilePath: string, readProfileFile?: (profilePath: string) => string) =>
    importCliOpenShellProviderProfile(
      { profilePath, target: { kind: "selected" } },
      {
        readProfileFile,
        run: (args, options) => capturedResult(input.runOpenshell(args, options)),
      },
  );
  if (input.profileSource === undefined) return run(input.profilePath, input.readProfileFile);
  if (Buffer.byteLength(input.profileSource, "utf8") > RECEIPT_PROVIDER_PROFILE_MAX_BYTES) {
    return {
      ok: false,
      error: {
        kind: "validation",
        message: "The receipt-verified OpenShell provider profile is oversized.",
      },
      operation: "read",
    };
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-provider-profile-"),
  );
  const temporaryProfilePath = path.join(temporaryDirectory, "profile.yaml");
  try {
    fs.writeFileSync(temporaryProfilePath, input.profileSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return run(temporaryProfilePath, () => input.profileSource!);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export type EndpointlessProviderProfileFailureReason =
  | "export-failed"
  | "import-failed"
  | "incompatible";

/** OpenShell provider type registered for every OpenAI-surface inference route. */
export const OPENAI_GATEWAY_PROVIDER_TYPE = "openai";

export type OpenAiProviderProfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/** Return the recovery guidance for an endpointless OpenAI profile failure. */
export function endpointlessProviderProfileFailureMessages(
  reason: EndpointlessProviderProfileFailureReason,
): readonly string[] {
  if (reason === "import-failed") {
    return [
      `\n  ✗ OpenShell could not import the checked-in '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile.`,
      "    Confirm OpenShell is available and authorized, then retry this command.",
    ];
  }
  if (reason === "export-failed") {
    return [
      `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' could not be read for validation.`,
      "    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
    ];
  }
  return [
    `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless inference contract.`,
    "    Remove the conflicting profile, then retry this command.",
  ];
}

function endpointlessFailureReason(
  result: Extract<CliOpenShellProviderProfileResult, { readonly ok: false }>,
): EndpointlessProviderProfileFailureReason {
  if (result.error.kind === "command" && result.error.reason === "profile_incompatible") {
    return "incompatible";
  }
  return result.operation === "import" ? "import-failed" : "export-failed";
}

/** Validate or import the endpointless OpenAI profile through the shared CLI adapter protocol. */
export function checkOpenAiInferenceProviderProfile(deps: {
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly root?: string;
}): OpenAiProviderProfileCheck {
  const result = registerCheckedInProviderProfile({
    profilePath: endpointlessProviderProfilePath(
      deps.root ?? REPOSITORY_ROOT,
      OPENAI_GATEWAY_PROVIDER_TYPE,
    ),
    runOpenshell: deps.runOpenshell,
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    messages: endpointlessProviderProfileFailureMessages(endpointlessFailureReason(result)),
  };
}
