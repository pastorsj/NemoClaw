// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";

import type {
  HarnessMessagingBuildFileTemplate,
  HarnessMessagingChannelProfile,
  HarnessMessagingCredentialProvider,
  HarnessMessagingHookOperation,
  HarnessMessagingSupportedIntegration,
  HarnessWhatsappStatusProbe,
} from "@nvidia/nemoclaw-harness-contract";

import {
  HARNESS_MESSAGING_ADAPTER_CONTRACT,
  type HarnessMessagingDisabledIntegration,
  type HarnessMessagingProfileReference,
  validateHarnessMessagingBuildProfile,
  validateHarnessMessagingChannelProfiles,
} from "./adapter/messaging";
import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import { readObject, readString, readStringArray } from "./manifest-readers";
import type { ManifestRecord } from "./manifest-types";
import type { HarnessPackageStoreOptions } from "./package/store";
import { resolvePinnedHarnessPackage } from "./package/store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "./package/tree";
import type { HarnessPackageIdentity } from "./package/types";
import { assertMessagingCredentialProviderProfileMatches } from "./messaging-provider";

export type ReceiptBoundMessagingCredentialProvider = HarnessMessagingCredentialProvider &
  Readonly<{ profileSha256: string }>;

export type ReceiptBoundMessagingChannelProfile = Omit<
  HarnessMessagingChannelProfile,
  "credentialProvider"
> &
  Readonly<{ credentialProvider?: ReceiptBoundMessagingCredentialProvider }>;

/** Core projection enriched with receipt-verified provider-profile identity. */
export type HarnessMessagingIntegration =
  | HarnessMessagingDisabledIntegration
  | (Omit<HarnessMessagingSupportedIntegration, "channels"> &
      Readonly<{ channels: readonly ReceiptBoundMessagingChannelProfile[] }>);

interface DeclaredMessagingIntegration {
  readonly support: "channels" | "disabled";
  readonly channelIds: readonly string[];
}

const PROFILE_MAX_BYTES = 128 * 1024;
const PROVIDER_PROFILE_MAX_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class HarnessMessagingModuleError extends Error {
  override readonly name = "HarnessMessagingModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function messagingModuleFailure(error: unknown): never {
  if (error instanceof HarnessMessagingModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessMessagingModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessMessagingModuleError(
    "Installed harness messaging adapter failed",
    "invalid-adapter",
    { cause: error },
  );
}

function readMessagingDeclaration(manifest: ManifestRecord): DeclaredMessagingIntegration {
  const messaging = readObject(manifest, "messaging");
  const support = readString(messaging ?? {}, "support");
  if (support === "disabled") {
    return Object.freeze({ support, channelIds: Object.freeze([]) });
  }
  const channels = readStringArray(messaging ?? {}, "channels");
  if (support !== "channels" || !channels || channels.length === 0) {
    throw new HarnessMessagingModuleError(
      "Installed harness package has an invalid messaging declaration",
    );
  }
  return Object.freeze({ support, channelIds: Object.freeze([...channels]) });
}

function requireDeclarationAgreement(
  identity: HarnessPackageIdentity,
  declaration: DeclaredMessagingIntegration,
  integration: HarnessMessagingProfileReference | HarnessMessagingDisabledIntegration,
): void {
  if (integration.packageId !== identity.id) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging adapter does not match its package identity",
    );
  }
  if (
    declaration.support === "disabled"
      ? integration.kind !== "disabled"
      : integration.kind !== "channels" ||
        !isDeepStrictEqual(integration.channelIds, declaration.channelIds)
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging adapter does not match its manifest declaration",
    );
  }
}

function readChannelProfiles(
  identity: HarnessPackageIdentity,
  profilePath: string,
  options: HarnessPackageStoreOptions,
) {
  const installed = resolvePinnedHarnessPackage(identity, options);
  const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
  if (tree.contentDigest !== identity.contentDigest) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile failed integrity validation",
    );
  }
  const authority = getPackageTreeAuthority(tree);
  const relativePath = path.posix.join(
    path.posix.dirname(installed.packageManifest.envelope.manifest),
    profilePath,
  );
  const entry = authority.entries.find((candidate) => candidate.relativePath === relativePath);
  if (!entry || entry.type !== "file" || entry.stat.size > BigInt(PROFILE_MAX_BYTES)) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile is missing or oversized",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(readVerifiedFile(entry, PROFILE_MAX_BYTES)));
  } catch (error) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging profile must be valid JSON",
      "invalid-adapter",
      { cause: error },
    );
  }
  const profiles = validateHarnessMessagingChannelProfiles(parsed);
  const providerProfileDigests = new Map<HarnessMessagingCredentialProvider, string>();
  validateChannelProfileSemantics(profiles, (profile) => {
    const providerPath = path.posix.join(
      path.posix.dirname(installed.packageManifest.envelope.manifest),
      profile.profilePath,
    );
    const providerEntry = authority.entries.find(
      (candidate) => candidate.relativePath === providerPath,
    );
    if (
      !providerEntry ||
      providerEntry.type !== "file" ||
      providerEntry.stat.size > BigInt(PROVIDER_PROFILE_MAX_BYTES)
    ) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging credential provider profile is missing or oversized",
      );
    }
    let providerBytes: Buffer;
    let providerSource: string;
    try {
      providerBytes = readVerifiedFile(providerEntry, PROVIDER_PROFILE_MAX_BYTES);
      providerSource = UTF8_DECODER.decode(providerBytes);
    } catch (error) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging credential provider profile is invalid",
        "invalid-adapter",
        { cause: error },
      );
    }
    try {
      assertMessagingCredentialProviderProfileMatches(profile, providerSource);
    } catch (error) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging credential provider profile disagrees with its declaration",
        "invalid-adapter",
        { cause: error },
      );
    }
    providerProfileDigests.set(profile, createHash("sha256").update(providerBytes).digest("hex"));
  });
  assertTreeAuthority(authority);
  return Object.freeze(
    profiles.map((profile): ReceiptBoundMessagingChannelProfile => {
      const { credentialProvider, ...profileWithoutCredentialProvider } = profile;
      if (!credentialProvider) return Object.freeze(profileWithoutCredentialProvider);
      const profileSha256 = providerProfileDigests.get(credentialProvider);
      if (!profileSha256) {
        throw new HarnessMessagingModuleError(
          "Installed harness messaging provider profile has no receipt-bound identity",
        );
      }
      return Object.freeze({
        ...profileWithoutCredentialProvider,
        credentialProvider: Object.freeze({ ...credentialProvider, profileSha256 }),
      });
    }),
  );
}

function validateChannelProfileSemantics(
  profiles: readonly HarnessMessagingChannelProfile[],
  validateCredentialProvider: (
    provider: NonNullable<HarnessMessagingChannelProfile["credentialProvider"]>,
  ) => void,
): void {
  const channelIds = new Set<string>();
  const providerProfileIds = new Set<string>();
  for (const profile of profiles) {
    if (channelIds.has(profile.channelId)) {
      throw new HarnessMessagingModuleError(
        `Installed harness messaging profile repeats channel '${profile.channelId}'`,
      );
    }
    channelIds.add(profile.channelId);
    if (profile.credentialProvider) {
      if (providerProfileIds.has(profile.credentialProvider.profileId)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile repeats credential provider '${profile.credentialProvider.profileId}'`,
        );
      }
      providerProfileIds.add(profile.credentialProvider.profileId);
      validateCredentialProvider(profile.credentialProvider);
    }
    const visibilityKeys = new Set<string>();
    for (const entry of profile.config.visibility) {
      const key = entry.key ?? entry.inputId;
      if (visibilityKeys.has(key)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile repeats config visibility key '${key}'`,
        );
      }
      visibilityKeys.add(key);
      if (
        (entry.kind === "structured" && (!entry.path || entry.envKey !== undefined)) ||
        (entry.kind === "env" && (!entry.envKey || entry.path !== undefined))
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has invalid config visibility source '${key}'`,
        );
      }
      if (
        path.posix.isAbsolute(entry.target) ||
        entry.target.includes("\\") ||
        entry.target.split("/").includes("..") ||
        (entry.targetInputId
          ? entry.target.split("{{input}}").length !== 2
          : entry.target.includes("{{input}}"))
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has unsafe config visibility target '${entry.target}'`,
        );
      }
    }
    for (const statePath of profile.config.statePaths ?? []) {
      if (!isSafePackageStatePath(statePath)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has unsafe state path '${statePath}'`,
        );
      }
    }
    const renderIds = new Set<string>();
    for (const render of profile.config.renders) {
      if (renderIds.has(render.id)) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile repeats render '${render.id}'`,
        );
      }
      renderIds.add(render.id);
      if (
        path.posix.isAbsolute(render.target) ||
        render.target.includes("\\") ||
        render.target.split("/").includes("..")
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has unsafe target '${render.target}'`,
        );
      }
      if (
        render.kind === "json-fragment" &&
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(render.path)
      ) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has invalid config path '${render.path}'`,
        );
      }
      if (render.kind === "env-lines" && render.lines.some((line) => /[\r\n]/u.test(line))) {
        throw new HarnessMessagingModuleError(
          `Installed harness messaging profile has a multiline env value in '${render.id}'`,
        );
      }
    }
    const statusProbe = profile.lifecycle.statusProbe;
    const usesWhatsappStatusHook = profile.lifecycle.hookIds.includes("whatsapp-status-health");
    if ((statusProbe !== undefined || usesWhatsappStatusHook) && profile.channelId !== "whatsapp") {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging status probe is assigned to the wrong channel",
      );
    }
    if (usesWhatsappStatusHook !== (statusProbe !== undefined)) {
      throw new HarnessMessagingModuleError(
        "Installed harness WhatsApp status hook requires one status probe",
      );
    }
    if (statusProbe) validateStatusProbe(statusProbe);
    validateHookOperations(profile);
  }
}

function validateHookOperations(profile: HarnessMessagingChannelProfile): void {
  const selectedHookIds = new Set(profile.lifecycle.hookIds);
  const operationHookIds = new Set<string>();
  for (const operation of profile.lifecycle.hookOperations ?? []) {
    if (!selectedHookIds.has(operation.hookId) || operationHookIds.has(operation.hookId)) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging hook operation must name one selected hook exactly once",
      );
    }
    operationHookIds.add(operation.hookId);
    if (operation.kind === "sandbox-command") {
      validateFixedCommands([operation.command]);
      if ((operation.output === "channel-health") !== (operation.context === "channel-health")) {
        throw new HarnessMessagingModuleError(
          "Installed harness channel-health command must consume the bounded status context",
        );
      }
      continue;
    }
    if (operation.kind === "config-prompt") continue;
    validateBuildFileOperation(operation);
  }
}

function validateBuildFileOperation(
  operation: Extract<HarnessMessagingHookOperation, { readonly kind: "build-files" }>,
): void {
  const inputIds = new Set(operation.inputIds);
  const outputIds = new Set<string>();
  for (const output of operation.outputs) {
    if (outputIds.has(output.id)) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file operation repeats an output",
      );
    }
    outputIds.add(output.id);
    if ((output.content === undefined) === (output.merge === undefined)) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file template must declare content or merge",
      );
    }
    validateBuildFilePathTemplate(output.pathTemplate, inputIds);
    validateBuildFileTemplateValue(output, inputIds);
  }
}

function validateBuildFilePathTemplate(pathTemplate: string, inputIds: ReadonlySet<string>): void {
  if (
    path.posix.isAbsolute(pathTemplate) ||
    pathTemplate.includes("\\") ||
    /[\0\r\n]/u.test(pathTemplate)
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging build-file template has an unsafe path",
    );
  }
  const renderedShape = pathTemplate.replace(/\{\{input:([^{}]+)\}\}/gu, (_match, inputId) => {
    if (!inputIds.has(String(inputId))) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file path references an undeclared input",
      );
    }
    return "value";
  });
  if (
    renderedShape.includes("{{") ||
    renderedShape
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging build-file template has an invalid path",
    );
  }
}

function validateBuildFileTemplateValue(
  output: HarnessMessagingBuildFileTemplate,
  inputIds: ReadonlySet<string>,
): void {
  const pending: unknown[] = [output.content !== undefined ? output.content : output.merge];
  let nodes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > 4096) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file template is too complex",
      );
    }
    if (typeof value === "string" && value.includes("{{")) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file values must use typed input markers",
      );
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(record, "$input")) {
      const keys = Object.keys(record);
      if (
        (keys.length !== 1 && !(keys.length === 2 && record.optional === true)) ||
        typeof record.$input !== "string" ||
        !inputIds.has(record.$input)
      ) {
        throw new HarnessMessagingModuleError(
          "Installed harness messaging build-file template has an invalid input marker",
        );
      }
      continue;
    }
    if (Object.hasOwn(record, "$generated")) {
      if (Object.keys(record).length !== 1 || record.$generated !== "iso-timestamp") {
        throw new HarnessMessagingModuleError(
          "Installed harness messaging build-file template has an invalid generated marker",
        );
      }
      continue;
    }
    if (Object.hasOwn(record, "optional")) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file template has a misplaced optional marker",
      );
    }
    for (const key of Object.keys(record)) validateBuildFileTemplateKey(key, inputIds);
    pending.push(...Object.values(record));
  }
}

function validateBuildFileTemplateKey(key: string, inputIds: ReadonlySet<string>): void {
  const renderedShape = key.replace(/\{\{input:([^{}]+)\}\}/gu, (_match, inputId) => {
    if (!inputIds.has(String(inputId))) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging build-file key references an undeclared input",
      );
    }
    return "value";
  });
  if (
    renderedShape.includes("{{") ||
    /[\0\r\n]/u.test(renderedShape) ||
    ["__proto__", "constructor", "prototype"].includes(renderedShape)
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging build-file template has an invalid object key",
    );
  }
}

function validateStatusProbe(probe: HarnessWhatsappStatusProbe): void {
  validateFixedCommands([
    probe.pairingCommand,
    ...(probe.kind === "channel-status-json" ? [probe.command] : []),
  ]);
  if (probe.kind !== "session-files") return;
  const relativePaths = [
    probe.primaryCredentialPath,
    probe.alternateCredentialPath,
    ...(probe.configuredSessionPath ? [probe.configuredSessionPath.configPath] : []),
  ];
  if (
    relativePaths.some((relativePath) => !isSafePackageStatePath(relativePath)) ||
    probe.primaryCredentialPath === probe.alternateCredentialPath
  ) {
    throw new HarnessMessagingModuleError(
      "Installed harness messaging status probe has an unsafe or repeated session path",
    );
  }
  for (const label of [probe.primaryLabel, probe.alternateLabel]) {
    if (label.trim().length === 0 || /[\0\r\n]/u.test(label)) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging status probe has an invalid session label",
      );
    }
  }
}

function validateFixedCommands(commands: readonly { readonly argv: readonly string[] }[]): void {
  for (const command of commands) {
    if (
      command.argv.some((argument) => argument.trim().length === 0 || /[\0\r\n]/u.test(argument))
    ) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging status probe has an invalid command argument",
      );
    }
  }
}

function isSafePackageStatePath(statePath: string): boolean {
  return (
    !path.posix.isAbsolute(statePath) &&
    !statePath.includes("\\") &&
    statePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Resolve one immutable messaging profile from an exact installed package receipt. */
export function loadHarnessMessagingIntegration(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessMessagingIntegration {
  let declaration: DeclaredMessagingIntegration | null = null;
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_MESSAGING_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_MESSAGING_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        declaration = readMessagingDeclaration(manifest);
      },
    });
    if (declaration === null) {
      throw new HarnessMessagingModuleError(
        "Installed harness package has no messaging declaration",
      );
    }
    const described = adapter.describeIntegration({ packageId: identity.id });
    requireDeclarationAgreement(identity, declaration, described);
    if (described.kind === "disabled") return described;
    validateHarnessMessagingBuildProfile(described.build);
    const channels = readChannelProfiles(identity, described.profilePath, options);
    const channelById = new Map(channels.map((profile) => [profile.channelId, profile]));
    if (
      channelById.size !== described.channelIds.length ||
      described.channelIds.some((channelId) => !channelById.has(channelId))
    ) {
      throw new HarnessMessagingModuleError(
        "Installed harness messaging profile does not match its adapter declaration",
      );
    }
    return Object.freeze({
      kind: "channels",
      packageId: identity.id,
      build: described.build,
      channels: described.channelIds.map((channelId) => channelById.get(channelId)!),
    });
  } catch (error) {
    messagingModuleFailure(error);
  }
}
