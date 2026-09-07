// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Parses local Dockerfile COPY and ADD sources and rejects unhandled forms. */

import fs from "node:fs";
import path from "node:path";

interface LogicalDockerfileInstruction {
  lineNumber: number;
  text: string;
}

export interface DirectDockerfileContextSource {
  lineNumber: number;
  source: string;
}

export interface MissingDockerfileContextSource extends DirectDockerfileContextSource {
  dockerfileLabel: string;
}

function logicalDockerfileInstructions(
  text: string,
  dockerfileLabel: string,
): LogicalDockerfileInstruction[] {
  const instructions: LogicalDockerfileInstruction[] = [];
  let currentParts: string[] = [];
  let currentLineNumber = 0;
  let sawInstruction = false;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      if (!sawInstruction) {
        const escapeDirective = /^#\s*escape\s*=\s*(\S+)\s*$/iu.exec(line);
        if (escapeDirective && escapeDirective[1] !== "\\") {
          throw new Error(
            `Unsupported ${dockerfileLabel} escape directive at line ${lineIndex + 1}: ${rawLine}`,
          );
        }
      }
      continue;
    }

    sawInstruction = true;
    if (currentParts.length === 0) currentLineNumber = lineIndex + 1;

    const continued = line.endsWith("\\");
    const part = continued ? line.slice(0, -1).trimEnd() : line;
    if (!part) {
      throw new Error(
        `Unsupported ${dockerfileLabel} continuation at line ${lineIndex + 1}: ${rawLine}`,
      );
    }
    currentParts.push(part);

    if (!continued) {
      const instruction = currentParts.join(" ");
      if (instruction.split(/\s+/u).some((token) => token.startsWith("<<"))) {
        throw new Error(
          `Unsupported ${dockerfileLabel} heredoc instruction at line ${currentLineNumber}: ${instruction}`,
        );
      }
      instructions.push({ lineNumber: currentLineNumber, text: instruction });
      currentParts = [];
      currentLineNumber = 0;
    }
  }

  if (currentParts.length > 0) {
    throw new Error(`Dangling ${dockerfileLabel} continuation at line ${currentLineNumber}`);
  }
  return instructions;
}

function unsupportedDirectContextForm(
  instruction: LogicalDockerfileInstruction,
  dockerfileLabel: string,
  keyword: "ADD" | "COPY",
): never {
  throw new Error(
    `Unsupported direct ${dockerfileLabel} ${keyword} form at line ${instruction.lineNumber}: ${instruction.text}`,
  );
}

function parseDirectContextOperands(
  tokens: string[],
  instruction: LogicalDockerfileInstruction,
  dockerfileLabel: string,
  keyword: "ADD" | "COPY",
): string[] | null {
  let operandIndex = 0;
  let copiesFromStage = false;
  while (operandIndex < tokens.length && tokens[operandIndex]?.startsWith("--")) {
    const flag = tokens[operandIndex]!;
    if (/^--from=.+$/iu.test(flag)) {
      if (keyword !== "COPY") unsupportedDirectContextForm(instruction, dockerfileLabel, keyword);
      copiesFromStage = true;
      operandIndex += 1;
      continue;
    }
    const handledDirectFlag =
      /^--(?:chown|chmod)=.+$/iu.test(flag) ||
      /^--(?:link|parents)(?:=(?:true|false))?$/iu.test(flag) ||
      (keyword === "ADD" && /^--checksum=sha256:[a-f0-9]{64}$/u.test(flag));
    if (!handledDirectFlag) unsupportedDirectContextForm(instruction, dockerfileLabel, keyword);
    operandIndex += 1;
  }

  const operands = tokens.slice(operandIndex);
  if (operands[0]?.startsWith("[")) {
    unsupportedDirectContextForm(instruction, dockerfileLabel, keyword);
  }
  if (operands.length < 2 || operands.some((operand) => operand.startsWith("--"))) {
    unsupportedDirectContextForm(instruction, dockerfileLabel, keyword);
  }
  return copiesFromStage ? null : operands;
}

function validateDirectContextSource(
  source: string,
  instruction: LogicalDockerfileInstruction,
  dockerfileLabel: string,
  keyword: "ADD" | "COPY",
): void {
  const withoutTrailingSlash = source.replace(/\/+$/u, "");
  const parts = withoutTrailingSlash.split("/");
  const invalidSource =
    !withoutTrailingSlash ||
    path.posix.isAbsolute(source) ||
    source.includes("\\") ||
    /[$"'{}]/u.test(source) ||
    source.includes("**") ||
    source.startsWith("--") ||
    parts.some((part) => !part || part === "." || part === "..");
  if (invalidSource) {
    throw new Error(
      `Unsupported direct ${dockerfileLabel} ${keyword} source at line ${instruction.lineNumber}: ${source}`,
    );
  }
}

export function directDockerfileContextSources(
  dockerfilePath: string,
  dockerfileLabel = path.basename(dockerfilePath),
): DirectDockerfileContextSource[] {
  const text = fs.readFileSync(dockerfilePath, "utf8");
  const sources: DirectDockerfileContextSource[] = [];

  for (const instruction of logicalDockerfileInstructions(text, dockerfileLabel)) {
    const instructionMatch = /^(\S+)\b([\s\S]*)$/u.exec(instruction.text);
    if (!instructionMatch) continue;
    const keyword = instructionMatch[1].toUpperCase();
    if (keyword !== "ADD" && keyword !== "COPY") continue;

    const contextForm = instructionMatch[2].trim();
    const tokens = contextForm.split(/\s+/u).filter(Boolean);
    if (!contextForm) {
      unsupportedDirectContextForm(instruction, dockerfileLabel, keyword);
    }

    const operands = parseDirectContextOperands(tokens, instruction, dockerfileLabel, keyword);
    if (operands === null) continue;

    for (const source of operands.slice(0, -1)) {
      if (keyword === "ADD" && /^https:\/\//iu.test(source)) continue;
      validateDirectContextSource(source, instruction, dockerfileLabel, keyword);
      sources.push({ lineNumber: instruction.lineNumber, source });
    }
  }

  return sources;
}

function sourceExistsInContext(contextRoot: string, source: string): boolean {
  if (/[*?[\]]/u.test(source)) {
    return fs.globSync(source, { cwd: contextRoot }).length > 0;
  }
  return fs.existsSync(path.join(contextRoot, ...source.split("/")));
}

export function missingDockerfileContextSources(
  dockerfilePath: string,
  contextRoot: string,
  dockerfileLabel = path.basename(dockerfilePath),
): MissingDockerfileContextSource[] {
  return directDockerfileContextSources(dockerfilePath, dockerfileLabel)
    .filter(({ source }) => !sourceExistsInContext(contextRoot, source))
    .map((source) => ({ ...source, dockerfileLabel }));
}

export function formatMissingDockerfileContextSources(
  missingSources: readonly MissingDockerfileContextSource[],
): string {
  return [
    "The optimized build context does not contain every local Dockerfile COPY or ADD source.",
    "Review each missing source before you add it to stageOptimizedSandboxBuildContext.",
    "",
    ...missingSources.map(
      ({ dockerfileLabel, lineNumber, source }) =>
        `${dockerfileLabel}:${lineNumber} missing ${source}`,
    ),
  ].join("\n");
}
