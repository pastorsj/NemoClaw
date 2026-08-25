// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import {
  type HarnessPackage,
  listBundledHarnessPackages,
  listInstalledHarnessPackages,
} from "./package-registry";

export type AgentRuntimeInstallChoice = Pick<HarnessPackage, "id" | "packageName" | "version">;

export interface RuntimeInstallSelectionDeps {
  listBundledPackages(): HarnessPackage[];
  listInstalledPackages(): HarnessPackage[];
  log(message?: string): void;
  prompt(question: string): Promise<string>;
}

function readRuntimeInstallChoice(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = readline.createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    input.once("close", () => {
      if (!answered) resolve("exit");
    });
    input.question(question, (answer) => {
      answered = true;
      input.close();
      resolve(answer);
    });
  });
}

export function listRuntimeInstallChoices(
  bundled: readonly AgentRuntimeInstallChoice[],
  installed: readonly Pick<AgentRuntimeInstallChoice, "id">[],
): AgentRuntimeInstallChoice[] {
  const installedIds = new Set(installed.map(({ id }) => id));
  return bundled
    .filter(({ id }) => !installedIds.has(id))
    .sort((left, right) => {
      if (left.id === "openclaw") return -1;
      if (right.id === "openclaw") return 1;
      return left.id.localeCompare(right.id);
    });
}

function resolveInstallMenuChoice(
  answer: string,
  choices: readonly AgentRuntimeInstallChoice[],
): AgentRuntimeInstallChoice | null | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "exit" || normalized === "quit" || normalized === "cancel") return null;
  if (normalized !== "" && !/^\d+$/.test(normalized)) return undefined;
  const index = Number.parseInt(normalized || "1", 10) - 1;
  return index >= 0 && index < choices.length ? choices[index] : undefined;
}

export async function selectAgentRuntimePackage(
  deps: RuntimeInstallSelectionDeps = {
    listBundledPackages: () => listBundledHarnessPackages(),
    listInstalledPackages: () => listInstalledHarnessPackages(),
    log: (message?: string) => console.log(message ?? ""),
    prompt: readRuntimeInstallChoice,
  },
): Promise<string | null> {
  const choices = listRuntimeInstallChoices(
    deps.listBundledPackages(),
    deps.listInstalledPackages(),
  );
  if (choices.length === 0) {
    deps.log("All bundled agent runtime packages are installed.");
    return null;
  }

  deps.log("");
  deps.log("Select an agent runtime package to install:");
  for (const [index, choice] of choices.entries()) {
    deps.log(`  ${String(index + 1)}) ${choice.id} (${choice.packageName}@${choice.version})`);
  }
  deps.log("");
  deps.log("Enter 'exit' to install later.");

  while (true) {
    const choice = resolveInstallMenuChoice(await deps.prompt("Choose [1]: "), choices);
    if (choice === null) {
      deps.log("No agent runtime package was installed.");
      return null;
    }
    if (choice) return choice.id;
    deps.log(`Choose a number from 1 to ${String(choices.length)}, or enter 'exit'.`);
  }
}

export function promptForRuntimePackage(
  log: (message?: string) => void = (message?: string) => console.log(message ?? ""),
): Promise<string | null> {
  return selectAgentRuntimePackage({
    listBundledPackages: () => listBundledHarnessPackages(),
    listInstalledPackages: () => listInstalledHarnessPackages(),
    log,
    prompt: readRuntimeInstallChoice,
  });
}
