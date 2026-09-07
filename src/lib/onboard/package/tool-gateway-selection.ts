// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessToolGatewayCapability,
  HarnessToolGatewayDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import {
  compatibleHarnessToolGateways,
  formatHarnessToolGatewaySelections,
  normalizeHarnessToolGatewaySelections,
  parseHarnessToolGatewayRequest,
  resolveHarnessToolGatewayCapability,
} from "../../agent-runtime/tool-gateway";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import type { HarnessPackageStoreOptions } from "../../agent-runtime/package/store";

type RawInput = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
  ref?: () => void;
  unref?: () => void;
};

export interface PackageToolGatewaySelectionDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: (message: string) => Promise<string>;
  readonly note: (message: string) => void;
  readonly log: (message?: string) => void;
  readonly isNonInteractive: () => boolean;
  readonly input?: RawInput;
  readonly output?: NodeJS.WriteStream;
  /** Test and embedded-runtime package-store override. */
  readonly packageStore?: HarnessPackageStoreOptions;
}

export type PackageToolGatewaySelectionResult =
  | { readonly kind: "unsupported"; readonly selections: readonly [] }
  | { readonly kind: "managed"; readonly selections: readonly string[] };

function gatewayChoice(
  gateways: readonly HarnessToolGatewayDeclaration[],
  input: string,
): HarnessToolGatewayDeclaration | null {
  const index = /^[0-9]+$/u.test(input) ? Number(input) - 1 : -1;
  if (index >= 0) return gateways[index] ?? null;
  const normalized = input.toLowerCase();
  return (
    gateways.find(
      (gateway) =>
        gateway.id === normalized ||
        gateway.aliases.includes(normalized) ||
        gateway.label.toLowerCase() === normalized,
    ) ?? null
  );
}

async function selectFromLinePrompt(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
  gateways: readonly HarnessToolGatewayDeclaration[],
  initial: readonly string[],
  deps: PackageToolGatewaySelectionDeps,
): Promise<string[]> {
  deps.log("");
  deps.log(`  ${capability.selection_label}:`);
  gateways.forEach((gateway, index) => {
    const marker = initial.includes(gateway.id) ? "[✓]" : "[ ]";
    deps.log(`    ${String(index + 1)}) ${marker} ${gateway.label} — ${gateway.description}`);
  });
  deps.log("");
  deps.log("  Enter comma-separated numbers/names, Enter for current selection, or 'none'.");
  const answer = (await deps.prompt(`  ${capability.selection_prompt}: `)).trim();
  if (!answer) return [...initial];
  if (/^(?:none|no|skip)$/iu.test(answer)) return [];
  const selected: string[] = [];
  for (const part of answer
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const gateway = gatewayChoice(gateways, part);
    if (!gateway) throw new Error(`Unknown managed tool selection '${part}'`);
    if (!selected.includes(gateway.id)) selected.push(gateway.id);
  }
  return selected;
}

async function selectFromTerminalKeys(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
  gateways: readonly HarnessToolGatewayDeclaration[],
  initial: readonly string[],
  deps: PackageToolGatewaySelectionDeps,
): Promise<string[]> {
  const selected = new Set(initial);
  const input = deps.input ?? (process.stdin as RawInput);
  const output = deps.output ?? process.stdout;
  const linesAbovePrompt = gateways.length + 3;
  let firstDraw = true;
  const showList = (): void => {
    if (!firstDraw) output.write(`\r\x1b[${String(linesAbovePrompt)}A\x1b[J`);
    firstDraw = false;
    output.write("\n");
    output.write(`  ${capability.selection_label}:\n`);
    gateways.forEach((gateway, index) => {
      const marker = selected.has(gateway.id) ? "[✓]" : "[ ]";
      output.write(
        `    [${String(index + 1)}] ${marker} ${gateway.label} — ${gateway.description}\n`,
      );
    });
    output.write("\n");
    output.write(
      `  Press 1-${String(gateways.length)} to toggle, a for all/none, Enter when done: `,
    );
  };
  showList();

  await new Promise<void>((resolve, reject) => {
    let rawModeEnabled = false;
    let finished = false;
    const cleanup = (): void => {
      input.removeListener("data", onData);
      if (rawModeEnabled) input.setRawMode?.(false);
      input.pause();
      input.unref?.();
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (character === "\r" || character === "\n") return finish();
        if (character === "a" || character === "A") {
          if (selected.size === gateways.length) selected.clear();
          else gateways.forEach(({ id }) => selected.add(id));
          showList();
          continue;
        }
        const index = Number.parseInt(character, 10) - 1;
        const gateway = gateways[index];
        if (!gateway) continue;
        if (selected.has(gateway.id)) selected.delete(gateway.id);
        else selected.add(gateway.id);
        showList();
      }
    };
    input.ref?.();
    input.setEncoding("utf8");
    input.resume();
    if (input.setRawMode) {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });
  return gateways.filter(({ id }) => selected.has(id)).map(({ id }) => id);
}

/** Run the generic selection workflow from the exact receipt-pinned package declaration. */
export async function selectPackageToolGateways(
  identity: HarnessPackageIdentity,
  authenticationMethod: string,
  existingSelections: unknown,
  deps: PackageToolGatewaySelectionDeps,
): Promise<PackageToolGatewaySelectionResult> {
  const capability = resolveHarnessToolGatewayCapability(identity, deps.packageStore);
  if (!capability) return { kind: "unsupported", selections: [] };
  const compatible = compatibleHarnessToolGateways(capability, authenticationMethod);
  const requested = parseHarnessToolGatewayRequest(capability, deps.env);
  if (compatible.length === 0) {
    if (requested && requested.length > 0) deps.note(`  ${capability.incompatible_auth_message}`);
    return { kind: "managed", selections: [] };
  }
  const compatibleIds = new Set(compatible.map(({ id }) => id));
  if (requested) {
    const incompatible = requested.find((id) => !compatibleIds.has(id));
    if (incompatible) {
      throw new Error(
        `Managed tool gateway '${incompatible}' does not support authentication method '${authenticationMethod}'`,
      );
    }
    if (requested.length > 0) {
      deps.note(
        `  [env] Managed tools: ${formatHarnessToolGatewaySelections(capability, requested)}`,
      );
    }
    return { kind: "managed", selections: requested };
  }
  const existing = normalizeHarnessToolGatewaySelections(capability, existingSelections).filter(
    (id) => compatibleIds.has(id),
  );
  if (existing.length > 0) return { kind: "managed", selections: existing };
  if (deps.isNonInteractive()) return { kind: "managed", selections: [] };

  const initial = compatible
    .filter(({ default_selected: selected }) => selected)
    .map(({ id }) => id);
  const input = deps.input ?? (process.stdin as RawInput);
  const output = deps.output ?? process.stdout;
  const selections =
    input.isTTY && output.isTTY && compatible.length <= 9
      ? await selectFromTerminalKeys(capability, compatible, initial, deps)
      : await selectFromLinePrompt(capability, compatible, initial, deps);
  if (selections.length === 0) deps.log("  Skipping managed tools.");
  return { kind: "managed", selections };
}
