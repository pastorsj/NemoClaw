// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type {
  HarnessSelectionQualificationDeclaration,
  HarnessSelectionQualificationRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { resolveManagedStartupSandboxInferenceConfig } from "../inference-route";
import type { SelectionDrift } from "../selection-drift";

const QUALIFIED_MARKER = "__NEMOCLAW_SELECTION_QUALIFIED__=";
const NONCE_PATTERN = /^[a-f0-9]{64}$/u;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_SELECTION_VALUE_BYTES = 4096;

export type PackageSelectionQualificationReader = (
  sandboxName: string,
  packageId: string,
  declaration: HarnessSelectionQualificationDeclaration,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
  endpointUrl: string | null,
  revalidateAuthority?: () => void,
) => SelectionDrift;

export interface PackageSelectionQualificationDependencies {
  readonly createNonce: () => string;
  readonly getGatewayName: () => string;
  readonly runCaptureOpenshell: (
    args: string[],
    options: {
      readonly ignoreError: true;
      readonly timeout: number;
      readonly killProcessTreeOnTimeout: true;
    },
  ) => string | null | undefined;
}

function unknownSelectionDrift(): SelectionDrift {
  return {
    changed: true,
    providerChanged: false,
    modelChanged: false,
    existingProvider: null,
    existingModel: null,
    unknown: true,
  };
}

function boundedSelectionValue(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_SELECTION_VALUE_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function safeEndpointUrl(value: string | null): boolean {
  if (value === null) return true;
  if (!boundedSelectionValue(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Build the credential-free selection passed to a package-owned live-state qualifier. */
export function buildSelectionQualificationRequest(input: {
  readonly packageId: string;
  readonly provider: string;
  readonly model: string;
  readonly preferredInferenceApi: string | null;
  readonly endpointUrl: string | null;
}): HarnessSelectionQualificationRequest | null {
  if (
    !PACKAGE_ID_PATTERN.test(input.packageId) ||
    !boundedSelectionValue(input.provider) ||
    !boundedSelectionValue(input.model) ||
    !safeEndpointUrl(input.endpointUrl)
  ) {
    return null;
  }
  let route: ReturnType<typeof resolveManagedStartupSandboxInferenceConfig>;
  try {
    route = resolveManagedStartupSandboxInferenceConfig(
      input.model,
      input.provider,
      input.preferredInferenceApi,
    );
  } catch {
    return null;
  }
  if (
    route.inferenceApi !== "openai-completions" &&
    route.inferenceApi !== "openai-responses" &&
    route.inferenceApi !== "anthropic-messages"
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    packageId: input.packageId,
    selection: Object.freeze({
      upstreamProvider: input.provider,
      model: input.model,
      providerKey: route.providerKey,
      baseUrl: route.inferenceBaseUrl,
      api: route.inferenceApi,
      endpointUrl: input.endpointUrl,
    }),
  });
}

function hasQualifiedMarker(output: string | null | undefined, nonce: string): boolean {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16 * 1024) return false;
  return output.trimEnd() === `${QUALIFIED_MARKER}${nonce}`;
}

/** Execute one package-declared selection qualifier and fail closed on every ambiguous result. */
export function readPackageSelectionQualification(
  input: {
    readonly sandboxName: string;
    readonly packageId: string;
    readonly declaration: HarnessSelectionQualificationDeclaration;
    readonly provider: string;
    readonly model: string;
    readonly preferredInferenceApi: string | null;
    readonly endpointUrl: string | null;
    readonly revalidateAuthority?: () => void;
  },
  dependencies: PackageSelectionQualificationDependencies,
): SelectionDrift {
  const request = buildSelectionQualificationRequest(input);
  const nonce = dependencies.createNonce();
  if (!request || !NONCE_PATTERN.test(nonce)) return unknownSelectionDrift();
  try {
    input.revalidateAuthority?.();
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    const output = dependencies.runCaptureOpenshell(
      [
        "sandbox",
        "exec",
        "--name",
        input.sandboxName,
        "--gateway",
        dependencies.getGatewayName(),
        "--",
        ...input.declaration.command,
        payload,
        nonce,
      ],
      {
        ignoreError: true,
        timeout: input.declaration.timeout_seconds * 1000,
        killProcessTreeOnTimeout: true,
      },
    );
    input.revalidateAuthority?.();
    if (!hasQualifiedMarker(output, nonce)) return unknownSelectionDrift();
    return {
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: input.provider,
      existingModel: input.model,
      unknown: false,
    };
  } catch {
    return unknownSelectionDrift();
  }
}

/** Bind the OpenShell command boundary once while retaining package data at every call site. */
export function createPackageSelectionQualificationReader(
  runCaptureOpenshell: PackageSelectionQualificationDependencies["runCaptureOpenshell"],
  getGatewayName: PackageSelectionQualificationDependencies["getGatewayName"],
): PackageSelectionQualificationReader {
  return (
    sandboxName,
    packageId,
    declaration,
    provider,
    model,
    preferredInferenceApi,
    endpointUrl,
    revalidateAuthority,
  ) =>
    readPackageSelectionQualification(
      {
        sandboxName,
        packageId,
        declaration,
        provider,
        model,
        preferredInferenceApi,
        endpointUrl,
        ...(revalidateAuthority ? { revalidateAuthority } : {}),
      },
      {
        createNonce: () => randomBytes(32).toString("hex"),
        getGatewayName,
        runCaptureOpenshell,
      },
    );
}
