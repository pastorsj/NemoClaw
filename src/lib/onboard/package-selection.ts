// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createAgentAliasMap, resolveAgentNameAlias } from "../agent/aliases";
import { requireCandidateAgentSelectable } from "../agent/candidate";
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
import { promptForAgentChoice } from "./agent-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";
import { resolveSandboxAgent } from "./sandbox-agent";
import { resolveUnpackagedOnboardAgent } from "./package/unpackaged-agent";

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
  readonly resolveUnpackagedOnboardAgent: typeof resolveUnpackagedOnboardAgent;
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
  resolveUnpackagedOnboardAgent,
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
    if (left.isDefaultOnboardingChoice !== right.isDefaultOnboardingChoice) {
      return left.isDefaultOnboardingChoice ? -1 : 1;
    }
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
    {
      storeRoot: input.storeRoot,
      env: input.environment,
      requireLifecycleEligibility: true,
    },
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
  environment: NodeJS.ProcessEnv,
): HealthyInstalledHarnessPackageRecord {
  const selectablePackages = new Map(
    inventory.available.map(({ id, aliases }) => [id, { name: id, aliases }] as const),
  );
  for (const record of inventory.installed) {
    selectablePackages.set(record.id, {
      name: record.id,
      aliases: record.state === "installed" ? record.aliases : [],
    });
  }
  const selectableIds = [...selectablePackages.keys()].sort();
  const aliases = createAgentAliasMap([...selectablePackages.values()]);
  const resolvedId = resolveAgentNameAlias(selector, selectableIds, aliases);
  if (!resolvedId) {
    throw new Error(
      `Unknown harness package '${selector}'. Known harnesses: ${selectableIds.join(", ")}.`,
    );
  }
  const selected = installed.find(({ id }) => id === resolvedId);
  if (selected) return selected;
  if (inventory.installed.some(({ id, state }) => id === resolvedId && state === "damaged")) {
    throw new OnboardHarnessIntegrityError([resolvedId]);
  }
  // An exact installed receipt is package authority. The product qualification
  // gate applies only while selecting an uninstalled repository candidate.
  requireCandidateAgentSelectable(resolvedId, environment);
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
  if (selector) return explicitInstalledPackage(selector, inventory, installed, input.environment);
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

/** Select one installed package or the remaining explicitly requested unpackaged agent. */
export async function selectOnboardHarnessPackage(
  input: SelectOnboardHarnessPackageInput,
  dependencyOverrides: Partial<SelectOnboardHarnessPackageDependencies> = {},
): Promise<OnboardHarnessPackageSelection> {
  const dependencies = { ...PRODUCTION_SELECTION_DEPENDENCIES, ...dependencyOverrides };
  const selector = explicitSelector(input);
  if (selector) {
    const unpackagedAgent = dependencies.resolveUnpackagedOnboardAgent(selector, input.environment);
    if (unpackagedAgent) {
      return Object.freeze({
        kind: "qualified-agent",
        recordedAgent: unpackagedAgent.name,
        harnessPackage: null,
        resolvedPackage: null,
        effectiveDefinition: unpackagedAgent,
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
