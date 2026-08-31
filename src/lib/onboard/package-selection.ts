// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createAgentAliasMap, resolveAgentNameAlias } from "../agent/aliases";
import type { AgentChoice, AgentDefinition } from "../agent-runtime/manifest-types";
import {
  listHarnessPackageInventory,
  type HealthyInstalledHarnessPackageRecord,
  type HarnessPackageCatalogOptions,
  type HarnessPackageInventory,
} from "../agent-runtime/package/catalog";
import {
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "../agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import { promptForAgentChoice, resolveQualifiedOnboardAgent } from "./agent-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";
import { resolveSandboxAgent } from "./sandbox-agent";

export interface SelectOnboardHarnessPackageInput {
  readonly agentFlag?: string | null;
  readonly bundledRoot: string;
  readonly canPrompt: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message?: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly storeRoot: string;
}

export interface SelectedOnboardHarnessPackage {
  readonly kind: "package";
  readonly recordedAgent: string;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly resolvedPackage: InstalledHarnessPackage;
  readonly effectiveDefinition: AgentDefinition;
}

export interface SelectedQualifiedOnboardAgent {
  readonly kind: "qualified-agent";
  readonly recordedAgent: string;
  readonly harnessPackage: null;
  readonly resolvedPackage: null;
  readonly effectiveDefinition: AgentDefinition;
}

export interface OnboardHarnessInstallGuidance {
  readonly kind: "install-required";
  readonly reason: "no-installed-harnesses";
  readonly command: "nemoclaw harness install";
  readonly message: string;
}

export type OnboardHarnessPackageSelection =
  | SelectedOnboardHarnessPackage
  | SelectedQualifiedOnboardAgent
  | OnboardHarnessInstallGuidance;

export interface SelectOnboardHarnessPackageDependencies {
  readonly listHarnessPackageInventory: (
    options: HarnessPackageCatalogOptions,
  ) => HarnessPackageInventory;
  readonly promptForAgentChoice: typeof promptForAgentChoice;
  readonly resolvePinnedHarnessPackage: typeof resolvePinnedHarnessPackage;
  readonly resolveQualifiedOnboardAgent: typeof resolveQualifiedOnboardAgent;
  readonly resolveSandboxAgent: typeof resolveSandboxAgent;
  readonly selectFromNumberedMenu: (
    rawChoice: string,
    defaultIdx: number,
    options: AgentChoice[],
  ) => AgentChoice;
}

const PRODUCTION_SELECTION_DEPENDENCIES: SelectOnboardHarnessPackageDependencies = Object.freeze({
  listHarnessPackageInventory,
  promptForAgentChoice,
  resolvePinnedHarnessPackage,
  resolveQualifiedOnboardAgent,
  resolveSandboxAgent,
  selectFromNumberedMenu: selectFromNumberedMenuOrExit,
});

export class OnboardHarnessInstallRequiredError extends Error {
  override readonly name = "OnboardHarnessInstallRequiredError";
  readonly harnessId: string;

  constructor(harnessId: string) {
    super(
      `Harness package '${harnessId}' is not installed. Run 'nemoclaw harness install ${harnessId}', then retry onboarding.`,
    );
    this.harnessId = harnessId;
  }
}

export class OnboardHarnessSelectionRequiredError extends Error {
  override readonly name = "OnboardHarnessSelectionRequiredError";
}

export class OnboardHarnessIntegrityError extends Error {
  override readonly name = "OnboardHarnessIntegrityError";
  readonly harnessIds: readonly string[];

  constructor(harnessIds: readonly string[]) {
    const orderedIds = [...harnessIds].sort();
    super(`Installed harness package integrity failed: ${orderedIds.join(", ")}.`);
    this.harnessIds = Object.freeze(orderedIds);
  }
}

function explicitSelector(input: SelectOnboardHarnessPackageInput): string | null {
  const fromFlag = input.agentFlag?.trim() ?? "";
  if (fromFlag) return fromFlag;
  const fromEnvironment = input.environment.NEMOCLAW_AGENT?.trim() ?? "";
  return fromEnvironment || null;
}

function orderInstalledPackages(
  records: readonly HealthyInstalledHarnessPackageRecord[],
): HealthyInstalledHarnessPackageRecord[] {
  return [...records].sort((left, right) => {
    if (left.isDefaultOnboardingChoice) return -1;
    if (right.isDefaultOnboardingChoice) return 1;
    return left.id.localeCompare(right.id);
  });
}

function identityMatches(left: HarnessPackageIdentity, right: HarnessPackageIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contentDigest === right.contentDigest
  );
}

function resolveExactSelection(
  selected: HealthyInstalledHarnessPackageRecord,
  input: SelectOnboardHarnessPackageInput,
  dependencies: SelectOnboardHarnessPackageDependencies,
): SelectedOnboardHarnessPackage {
  const resolvedPackage = dependencies.resolvePinnedHarnessPackage(selected.identity, {
    storeRoot: input.storeRoot,
  });
  const recordedAgent = selected.id;
  const resolvedAgent = dependencies.resolveSandboxAgent(
    {
      agent: recordedAgent,
      harnessPackage: resolvedPackage.identity,
    },
    { storeRoot: input.storeRoot, env: input.environment },
  );
  if (
    !identityMatches(resolvedPackage.identity, selected.identity) ||
    resolvedAgent.harnessPackage === null ||
    !identityMatches(resolvedAgent.harnessPackage, selected.identity) ||
    resolvedAgent.definition.packageRoot !== resolvedPackage.packageRoot
  ) {
    throw new Error("Selected harness package changed during exact resolution");
  }
  return Object.freeze({
    kind: "package",
    recordedAgent,
    harnessPackage: resolvedPackage.identity,
    resolvedPackage,
    effectiveDefinition: resolvedAgent.definition,
  });
}

function explicitInstalledPackage(
  selector: string,
  inventory: HarnessPackageInventory,
  installed: readonly HealthyInstalledHarnessPackageRecord[],
): HealthyInstalledHarnessPackageRecord {
  const availableIds = inventory.available.map(({ id }) => id);
  const aliases = createAgentAliasMap(
    inventory.available.map(({ id, aliases: packageAliases }) => ({
      name: id,
      aliases: packageAliases,
    })),
  );
  const resolvedId = resolveAgentNameAlias(selector, availableIds, aliases);
  if (!resolvedId) {
    throw new Error(
      `Unknown harness package '${selector}'. Reviewed harnesses: ${availableIds.join(", ")}.`,
    );
  }
  const selected = installed.find(({ id }) => id === resolvedId);
  if (selected) return selected;
  if (inventory.installed.some(({ id, state }) => id === resolvedId && state === "damaged")) {
    throw new OnboardHarnessIntegrityError([resolvedId]);
  }
  throw new OnboardHarnessInstallRequiredError(resolvedId);
}

async function selectFromInstalledPackages(
  input: SelectOnboardHarnessPackageInput,
  inventory: HarnessPackageInventory,
  dependencies: SelectOnboardHarnessPackageDependencies,
): Promise<HealthyInstalledHarnessPackageRecord | OnboardHarnessInstallGuidance> {
  const installed = orderInstalledPackages(
    inventory.installed.filter(
      (record): record is HealthyInstalledHarnessPackageRecord => record.state === "installed",
    ),
  );
  const selector = explicitSelector(input);
  if (selector) return explicitInstalledPackage(selector, inventory, installed);
  const damagedIds = inventory.installed
    .filter(({ state }) => state === "damaged")
    .map(({ id }) => id);
  if (damagedIds.length > 0) throw new OnboardHarnessIntegrityError(damagedIds);
  if (installed.length === 0) {
    return Object.freeze({
      kind: "install-required",
      reason: "no-installed-harnesses",
      command: "nemoclaw harness install",
      message:
        "No harnesses are installed. Run 'nemoclaw harness install' to choose one, then retry onboarding.",
    });
  }
  if (installed.length === 1) return installed[0]!;
  if (!input.canPrompt) {
    const defaultPackage = installed.find(({ isDefaultOnboardingChoice }) =>
      Boolean(isDefaultOnboardingChoice),
    );
    if (defaultPackage) return defaultPackage;
    throw new OnboardHarnessSelectionRequiredError(
      `Multiple harness packages are installed (${installed.map(({ id }) => id).join(", ")}), but no installed package is the onboarding default. Pass '--agent <id>' to select one.`,
    );
  }

  const choices: AgentChoice[] = installed.map((record) => ({
    name: record.id,
    displayName: record.displayName,
    description: record.description ?? "",
  }));
  const selectedChoice = await dependencies.promptForAgentChoice(
    {
      log: input.log,
      prompt: input.prompt,
      selectFromNumberedMenu: dependencies.selectFromNumberedMenu,
    },
    choices,
  );
  return installed.find(({ id }) => id === selectedChoice.name)!;
}

/** Select one installed standard package or one explicitly qualified repository agent. */
export async function selectOnboardHarnessPackage(
  input: SelectOnboardHarnessPackageInput,
  dependencyOverrides: Partial<SelectOnboardHarnessPackageDependencies> = {},
): Promise<OnboardHarnessPackageSelection> {
  const dependencies = { ...PRODUCTION_SELECTION_DEPENDENCIES, ...dependencyOverrides };
  const selector = explicitSelector(input);
  if (selector) {
    const qualifiedAgent = dependencies.resolveQualifiedOnboardAgent(selector, input.environment);
    if (qualifiedAgent) {
      return Object.freeze({
        kind: "qualified-agent",
        recordedAgent: qualifiedAgent.name,
        harnessPackage: null,
        resolvedPackage: null,
        effectiveDefinition: qualifiedAgent,
      });
    }
  }

  const inventory = dependencies.listHarnessPackageInventory({
    bundledRoot: input.bundledRoot,
    storeRoot: input.storeRoot,
  });
  const selected = await selectFromInstalledPackages(input, inventory, dependencies);
  return "kind" in selected ? selected : resolveExactSelection(selected, input, dependencies);
}
