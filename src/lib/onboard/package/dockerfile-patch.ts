// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HarnessStartupMaterial } from "@nvidia/nemoclaw-harness-contract";

import {
  formatSandboxBaseImageResolutionLabels,
  type SandboxBaseImageResolutionMetadata,
} from "../../sandbox-base-image";
import { encodeCorporateCaArg, resolveCorporateCa } from "../corporate-ca";
import {
  type DockerfileInstruction,
  dockerfileInstructions,
  readDockerfilePatchSnapshot,
  replaceDockerfilePatchSnapshot,
} from "../dockerfile-tool-disclosure-contract";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const CORE_OWNED_ARGUMENTS = new Set([
  "BASE_IMAGE",
  "NEMOCLAW_BUILD_ID",
  "NEMOCLAW_CORPORATE_CA_B64",
  "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER",
]);
const IMPLICIT_DOCKER_PROXY_ARGUMENTS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export interface PackageDockerfilePlan {
  readonly packageId: string;
  readonly configurationEnvironment: Readonly<Record<string, string>>;
  readonly materials: readonly HarnessStartupMaterial[];
  readonly corporateCaB64?: string;
  readonly dashboardRemoteBindPrepared: boolean;
}

export interface PatchPackageDockerfileInput {
  readonly dockerfilePath: string;
  readonly buildId: string;
  readonly baseImageRef: string | null;
  readonly baseImageResolutionMetadata?: SandboxBaseImageResolutionMetadata | null;
  readonly trustedManagedDockerfile: boolean;
  readonly plan: PackageDockerfilePlan;
  readonly environment?: NodeJS.ProcessEnv;
}

export type PatchedPackageDockerfileMetadata = {
  readonly dashboardRemoteBindPrepared: boolean;
};

function safeArgumentValue(value: string, name: string): string {
  if (value.includes("\0") || CONTROL_CHARACTER.test(value) || /[\\`][ ]*$/u.test(value)) {
    throw new Error(`Package Docker build argument ${name} must be single-line text.`);
  }
  return value;
}

function argumentInstructions(dockerfile: string, name: string): DockerfileInstruction[] {
  const pattern = new RegExp(`^ARG\\s+${name}(?:\\s*=.*)?$`, "u");
  return dockerfileInstructions(dockerfile).filter((instruction) => pattern.test(instruction.text));
}

function replaceArgument(
  dockerfile: string,
  name: string,
  value: string,
  required: boolean,
): string {
  const declarations = argumentInstructions(dockerfile, name);
  if (declarations.length === 0 && !required) return dockerfile;
  if (declarations.length !== 1) {
    throw new Error(
      `Package Dockerfile must declare exactly one ARG ${name}; found ${String(declarations.length)}.`,
    );
  }
  const declaration = declarations[0]!;
  return `${dockerfile.slice(0, declaration.start)}ARG ${name}=${safeArgumentValue(value, name)}${dockerfile.slice(declaration.end)}`;
}

function replaceGlobalBaseImage(dockerfile: string, baseImageRef: string | null): string {
  if (baseImageRef === null) return dockerfile;
  const instructions = dockerfileInstructions(dockerfile);
  const firstStage = instructions.findIndex((instruction) =>
    /^FROM(?:\s|$)/iu.test(instruction.text),
  );
  const globalBaseArguments = instructions
    .slice(0, firstStage < 0 ? instructions.length : firstStage)
    .filter((instruction) => /^ARG\s+BASE_IMAGE(?:\s*=.*)?$/u.test(instruction.text));
  if (globalBaseArguments.length !== 1) {
    throw new Error(
      `Package Dockerfile must declare exactly one global ARG BASE_IMAGE; found ${String(globalBaseArguments.length)}.`,
    );
  }
  const declaration = globalBaseArguments[0]!;
  return `${dockerfile.slice(0, declaration.start)}ARG BASE_IMAGE=${safeArgumentValue(baseImageRef, "BASE_IMAGE")}${dockerfile.slice(declaration.end)}`;
}

function patchBuildId(dockerfile: string, buildId: string): string {
  const declarations = argumentInstructions(dockerfile, "NEMOCLAW_BUILD_ID");
  if (declarations.length !== 1) {
    throw new Error(
      `Package Dockerfile must declare exactly one ARG NEMOCLAW_BUILD_ID; found ${String(declarations.length)}.`,
    );
  }
  const declaration = declarations[0]!;
  const remaining = `${dockerfile.slice(0, declaration.start)}${dockerfile.slice(declaration.end)}`;
  // A declaration that is never consumed does not need a per-run cache invalidation.
  if (!/\$(?:\{NEMOCLAW_BUILD_ID\}|NEMOCLAW_BUILD_ID\b)/u.test(remaining)) return dockerfile;
  return replaceArgument(dockerfile, "NEMOCLAW_BUILD_ID", buildId, true);
}

function managedRootStartupArgument(dockerfile: string): DockerfileInstruction | null {
  const instructions = dockerfileInstructions(dockerfile);
  const finalFromIndex = instructions.reduce(
    (last, instruction, index) => (/^FROM(?:\s|$)/iu.test(instruction.text) ? index : last),
    -1,
  );
  const finalStage = instructions.slice(finalFromIndex + 1);
  const runtimeUserArguments = finalStage.filter((instruction) =>
    /^ARG\s+NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER\s*=/.test(instruction.text),
  );
  if (runtimeUserArguments.length !== 1) return null;

  const runtimeUserArgument = runtimeUserArguments[0]!;
  const runtimeUserArgumentIndex = finalStage.indexOf(runtimeUserArgument);
  const finalUserIndex = finalStage.reduce(
    (last, instruction, index) => (/^USER(?:\s|$)/iu.test(instruction.text) ? index : last),
    -1,
  );
  const finalEntrypointIndex = finalStage.reduce(
    (last, instruction, index) => (/^ENTRYPOINT(?:\s|$)/iu.test(instruction.text) ? index : last),
    -1,
  );
  const user = /^USER\s+(.+)$/iu.exec(finalStage[finalUserIndex]?.text ?? "")?.[1];
  const entrypointText = /^ENTRYPOINT\s+(.+)$/iu.exec(
    finalStage[finalEntrypointIndex]?.text ?? "",
  )?.[1];
  let trustedEntrypoint = false;
  try {
    const entrypoint = JSON.parse(entrypointText ?? "") as unknown;
    trustedEntrypoint =
      Array.isArray(entrypoint) &&
      entrypoint.length === 1 &&
      entrypoint[0] === "/usr/local/bin/nemoclaw-start";
  } catch {
    // The package must use the fixed exec-form entrypoint for root startup.
  }
  return runtimeUserArgumentIndex < finalUserIndex &&
    finalUserIndex < finalEntrypointIndex &&
    user === "${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}" &&
    trustedEntrypoint
    ? runtimeUserArgument
    : null;
}

function expectedCorporateCaSha256(materials: readonly HarnessStartupMaterial[]): string | null {
  const declarations = materials.filter((material) => material.kind === "corporate-ca-handoff");
  if (declarations.length !== 1) {
    throw new Error(
      `Package startup plan must declare exactly one corporate CA handoff; found ${String(declarations.length)}.`,
    );
  }
  return declarations[0]!.expectedSha256;
}

function patchCorporateCa(
  dockerfile: string,
  plan: PackageDockerfilePlan,
  environment: NodeJS.ProcessEnv,
): string {
  const expectedSha256 = expectedCorporateCaSha256(plan.materials);
  if (expectedSha256 === null) {
    if (plan.corporateCaB64 !== undefined) {
      throw new Error("Package startup plan supplied an unexpected corporate CA bundle.");
    }
    return dockerfile;
  }
  const resolved =
    plan.corporateCaB64 === undefined
      ? resolveCorporateCa(environment)
      : {
          pem: Buffer.from(plan.corporateCaB64, "base64").toString("utf8"),
          sourceEnv: "receipt startup profile",
          sourcePath: "receipt startup profile",
        };
  if (!resolved) {
    throw new Error("The receipt-backed corporate CA bundle is unavailable for this image build.");
  }
  const actualSha256 = createHash("sha256").update(resolved.pem, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("The corporate CA bundle does not match the receipt-backed startup profile.");
  }
  const caArguments = argumentInstructions(dockerfile, "NEMOCLAW_CORPORATE_CA_B64").filter(
    (instruction) => /^ARG\s+NEMOCLAW_CORPORATE_CA_B64\s*=/.test(instruction.text),
  );
  if (caArguments.length !== 1) {
    throw new Error(
      `Package Dockerfile must declare exactly one assigned ARG NEMOCLAW_CORPORATE_CA_B64; found ${String(caArguments.length)}.`,
    );
  }
  const runtimeUserArgument = managedRootStartupArgument(dockerfile);
  if (!runtimeUserArgument) {
    throw new Error(
      "Package Dockerfile cannot apply a corporate CA without the managed root startup contract.",
    );
  }
  let patched = `${dockerfile.slice(0, runtimeUserArgument.start)}ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root${dockerfile.slice(runtimeUserArgument.end)}`;
  const assignedCaArgument = argumentInstructions(patched, "NEMOCLAW_CORPORATE_CA_B64").find(
    (instruction) => /^ARG\s+NEMOCLAW_CORPORATE_CA_B64\s*=/.test(instruction.text),
  )!;
  patched = `${patched.slice(0, assignedCaArgument.start)}ARG NEMOCLAW_CORPORATE_CA_B64=${encodeCorporateCaArg(resolved.pem)}${patched.slice(assignedCaArgument.end)}`;
  console.error(
    `[nemoclaw] baking corporate proxy CA from ${resolved.sourceEnv} (${resolved.sourcePath}) into the sandbox image trust`,
  );
  return patched;
}

function packageBuildArguments(plan: PackageDockerfilePlan): Readonly<Record<string, string>> {
  const argumentsToPatch: Record<string, string> = { ...plan.configurationEnvironment };
  for (const material of plan.materials) {
    if (material.kind !== "root-owned-file") continue;
    const value = material.contents.endsWith("\n")
      ? material.contents.slice(0, -1)
      : material.contents;
    const previous = argumentsToPatch[material.legacyInput];
    if (previous !== undefined && previous !== value) {
      throw new Error(
        `Package startup plan assigned conflicting values to ${material.legacyInput}.`,
      );
    }
    argumentsToPatch[material.legacyInput] = value;
  }
  return argumentsToPatch;
}

function patchPackageArguments(dockerfile: string, plan: PackageDockerfilePlan): string {
  const argumentsToPatch = packageBuildArguments(plan);
  const remoteDashboardBind = argumentsToPatch.NEMOCLAW_DASHBOARD_BIND === "0.0.0.0";
  if (remoteDashboardBind !== plan.dashboardRemoteBindPrepared) {
    throw new Error("Package dashboard build state does not match its startup profile.");
  }
  let patched = dockerfile;
  for (const [name, value] of Object.entries(argumentsToPatch).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!ENVIRONMENT_NAME.test(name) || CORE_OWNED_ARGUMENTS.has(name)) {
      throw new Error(`Package startup adapter emitted forbidden Docker build argument ${name}.`);
    }
    const required = !IMPLICIT_DOCKER_PROXY_ARGUMENTS.has(name);
    patched = replaceArgument(patched, name, value, required);
  }
  return patched;
}

/** Patch a receipt-backed package recipe without consulting legacy harness inputs. */
export function patchPackageDockerfile(
  input: PatchPackageDockerfileInput,
): PatchedPackageDockerfileMetadata {
  if (input.plan.dashboardRemoteBindPrepared && !input.trustedManagedDockerfile) {
    throw new Error("A custom package Dockerfile cannot prepare remote dashboard access.");
  }
  const snapshot = readDockerfilePatchSnapshot(input.dockerfilePath);
  let dockerfile = replaceGlobalBaseImage(snapshot.content, input.baseImageRef);
  dockerfile = patchBuildId(dockerfile, input.buildId);
  dockerfile = patchCorporateCa(dockerfile, input.plan, input.environment ?? process.env);
  dockerfile = patchPackageArguments(dockerfile, input.plan);
  const labels = formatSandboxBaseImageResolutionLabels(input.baseImageResolutionMetadata ?? null);
  if (labels) {
    dockerfile = `${dockerfile.trimEnd()}\n\n# NemoClaw sandbox-base warm-resolution metadata\n${labels}\n`;
  }
  replaceDockerfilePatchSnapshot(input.dockerfilePath, snapshot, dockerfile);
  return { dashboardRemoteBindPrepared: input.plan.dashboardRemoteBindPrepared };
}
