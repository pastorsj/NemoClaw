// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AvailableHarnessPackageRecord, HarnessPackageInventory } from "./package-catalog";

export type HarnessPackagePromptResult =
  | { readonly kind: "selected"; readonly id: string }
  | { readonly kind: "exit"; readonly reason: "operator" | "eof" | "all-installed" };

export interface HarnessPackagePromptInput {
  readonly inventory: HarnessPackageInventory;
  readonly log: (message?: string) => void;
  readonly prompt: (question: string) => Promise<string>;
}

function availablePackagesToInstall(
  inventory: HarnessPackageInventory,
): readonly AvailableHarnessPackageRecord[] {
  const installedIds = new Set(inventory.installed.map(({ id }) => id));
  const available = inventory.available.filter(({ id }) => !installedIds.has(id));
  const openClawIndex = available.findIndex(({ id }) => id === "openclaw");
  if (openClawIndex <= 0) return available;
  return [
    available[openClawIndex]!,
    ...available.slice(0, openClawIndex),
    ...available.slice(openClawIndex + 1),
  ];
}

function isEndOfInput(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EOF"
  );
}

function selectedPackage(
  answer: string,
  packages: readonly AvailableHarnessPackageRecord[],
): AvailableHarnessPackageRecord | null | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "exit" || normalized === "quit" || normalized === "0") return null;
  const selection = normalized === "" ? 1 : Number(normalized);
  return Number.isInteger(selection) && selection >= 1 && selection <= packages.length
    ? packages[selection - 1]!
    : undefined;
}

/** Select one reviewed package that does not already have local installation state. */
export async function promptForHarnessPackage(
  input: HarnessPackagePromptInput,
): Promise<HarnessPackagePromptResult> {
  const packages = availablePackagesToInstall(input.inventory);
  if (packages.length === 0) return { kind: "exit", reason: "all-installed" };

  input.log("Choose a harness package to install:");
  packages.forEach((available, index) => {
    input.log(`  ${index + 1}) ${available.displayName} (${available.id})`);
  });
  input.log("  0) Exit");

  while (true) {
    let answer: string;
    try {
      answer = await input.prompt("Choose [1]: ");
    } catch (error) {
      if (isEndOfInput(error)) return { kind: "exit", reason: "eof" };
      throw error;
    }

    const selected = selectedPackage(answer, packages);
    if (selected === null) return { kind: "exit", reason: "operator" };
    if (selected !== undefined) return { kind: "selected", id: selected.id };
    input.log(`Choose a number from 1 to ${packages.length}, or enter 0 to exit.`);
  }
}
