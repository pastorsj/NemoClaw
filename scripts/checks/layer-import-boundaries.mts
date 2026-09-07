// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

type Violation = {
  file: string;
  line: number;
  column: number;
  rule: string;
  detail: string;
};

type ImportRef = {
  specifier: string;
  line: number;
  column: number;
};

type AgentRuntimePackageDependency = {
  packageName: string;
  packageRoot: string;
  packageId?: string;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const PACKAGES_ROOT = path.join(REPO_ROOT, "packages");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
const LEGACY_AGENT_RUNTIME_PACKAGE_IMPORTS = new Map<string, number>();
const PROVIDER_NEUTRAL_MANAGED_RUNTIME_MODULES = [
  "src/lib/actions/sandbox/connect.ts",
  "src/lib/actions/sandbox/destroy-presence.ts",
  "src/lib/actions/sandbox/launch-readiness.ts",
  "src/lib/actions/sandbox/process-recovery.ts",
  "src/lib/actions/sandbox/snapshot/backup-authority.ts",
  "src/lib/actions/sandbox/rebuild-flow-helpers.ts",
  "src/lib/actions/sandbox/sandbox-gateway-routing.ts",
  "src/lib/actions/sandbox/status-preflight.ts",
  "src/lib/actions/sandbox/status-snapshot.ts",
  "src/lib/actions/sandbox/stopped-sandbox-backup.ts",
  "src/lib/actions/sandbox/supervisor-relaunch.ts",
  "src/lib/actions/sandbox/terminal-runtime-health.ts",
  "src/lib/onboard/compute/plan.ts",
  "src/lib/onboard/docker-driver-gateway-env.ts",
  "src/lib/onboard/docker-driver-gateway-config.ts",
  "src/lib/onboard/docker-driver-gateway-local-tls.ts",
  "src/lib/onboard/docker-driver-gateway-process-identity.ts",
  "src/lib/onboard/docker-driver-gateway-runtime.ts",
  "src/lib/onboard/fatal-runtime-preflight.ts",
  "src/lib/onboard/gateway-sandbox-reachability.ts",
  "src/lib/onboard/host-gateway-process.ts",
  "src/lib/onboard/host-service-reachability.ts",
  "src/lib/onboard/managed-workload/hermes-state-volume.ts",
  "src/lib/onboard/sandbox-create/orchestration.ts",
  "src/lib/adapters/sandbox/command-transport.ts",
  "src/lib/sandbox/config.ts",
  "src/lib/sandbox/privileged-exec.ts",
  "src/lib/state/registry/lifecycle-generation.ts",
] as const;
const MANAGED_STATE_ROOT_PROVIDER_MODULES = [
  "src/lib/onboard/managed-bootstrap/docker.ts",
  "src/lib/onboard/managed-bootstrap/podman-runtime.ts",
] as const;
const HARNESS_AGNOSTIC_RUNTIME_PREFIXES = [
  "src/lib/agent-runtime/adapter/",
  "src/lib/agent-runtime/package/",
  "src/lib/voice-gateway/",
] as const;
// This module translates pre-contract registry records. Keep the exception visible until the
// compatibility reader can be removed; new package authority must stay package-ID agnostic.
const LEGACY_HARNESS_ID_MODULES = new Set(["src/lib/agent-runtime/package/identity.ts"]);
const PACKAGE_AUTHORITY_MODULES = new Set([
  "src/lib/onboard/package/package-authority.ts",
  "src/lib/sandbox/command-agent.ts",
]);
// Package authority also crosses a few typed callback boundaries. Those leaf
// modules do not import the receipt resolver themselves, so an import-only
// reverse graph cannot discover them. Keep the dataflow endpoints explicit and
// scan their decisions directly without classifying every unrelated importer.
const RECEIPT_BACKED_CALLBACK_MODULES = new Set([
  "src/lib/agent/base-image.ts",
  "src/lib/agent/onboard.ts",
  "src/lib/onboard/docker-startup-command-env.ts",
  "src/lib/onboard/providers.ts",
]);
const PACKAGE_RECEIPT_SELECTOR_FUNCTIONS = new Set([
  "activateHarnessPackage",
  "deactivateHarnessPackage",
  "readInstalledHarnessPackage",
  "removeHarnessPackage",
  "resolvePinnedHarnessPackage",
  "buildHarnessProviderBrokerPlan",
  "describeHarnessProviderBroker",
  "runHarnessProviderBrokerController",
]);

type ReceiptHarnessDecisionKind = "equality" | "lookup" | "membership" | "switch-case";

type LayerImportBoundaryOptions = {
  receiptHarnessDecisionBaseline?: ReadonlyMap<string, number>;
  receiptBackedCallbackModules?: ReadonlySet<string>;
  verifyReceiptHarnessDecisionBaseline?: boolean;
};

function receiptDecisionKey(
  file: string,
  owner: string,
  kind: ReceiptHarnessDecisionKind,
  packageId: string,
): string {
  return `${file}\0${owner}\0${kind}\0${packageId}`;
}

// The data file keeps audited compatibility debt separate from the enforcement logic.
const RECEIPT_HARNESS_DECISION_KINDS = new Set<ReceiptHarnessDecisionKind>([
  "equality",
  "lookup",
  "membership",
  "switch-case",
]);
const HARNESS_DEBT_MATCH = [
  "file",
  "function",
  "decisionKind",
  "packageId",
  "occurrences",
] as const;
const HARNESS_DEBT_PATH = path.join(REPO_ROOT, "scripts/checks/harness-debt.json");

export function parseReceiptHarnessDecisionBaseline(
  source: string,
  sourceName = "harness debt",
): ReadonlyMap<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} is not valid JSON: ${detail}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${sourceName} must contain a JSON object`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.description !== "string" || !record.description.trim()) {
    throw new Error(`${sourceName} must describe the audited debt`);
  }
  if (
    !Array.isArray(record.match) ||
    record.match.length !== HARNESS_DEBT_MATCH.length ||
    record.match.some((field, index) => field !== HARNESS_DEBT_MATCH[index])
  ) {
    throw new Error(`${sourceName} match must be ${JSON.stringify(HARNESS_DEBT_MATCH)}`);
  }
  if (!Array.isArray(record.entries)) {
    throw new Error(`${sourceName} entries must be an array`);
  }

  const baseline = new Map<string, number>();
  record.entries.forEach((entry, index) => {
    const label = `${sourceName} entry ${String(index + 1)}`;
    if (!Array.isArray(entry) || entry.length !== HARNESS_DEBT_MATCH.length) {
      throw new Error(`${label} must contain five fields`);
    }
    const [file, owner, kind, packageId, count] = entry;
    if (
      typeof file !== "string" ||
      !file.startsWith("src/") ||
      path.posix.normalize(file) !== file ||
      !/\.(?:cts|mts|ts|tsx)$/u.test(file) ||
      file.includes("\0")
    ) {
      throw new Error(`${label} has an invalid source file`);
    }
    if (typeof owner !== "string" || !owner.trim() || owner.includes("\0")) {
      throw new Error(`${label} has an invalid owning function`);
    }
    if (
      typeof kind !== "string" ||
      !RECEIPT_HARNESS_DECISION_KINDS.has(kind as ReceiptHarnessDecisionKind)
    ) {
      throw new Error(`${label} has an invalid decision kind`);
    }
    if (typeof packageId !== "string" || !packageId.trim() || packageId.includes("\0")) {
      throw new Error(`${label} has an invalid package ID`);
    }
    if (!Number.isSafeInteger(count) || (count as number) < 1) {
      throw new Error(`${label} has an invalid occurrence count`);
    }

    const key = receiptDecisionKey(file, owner, kind as ReceiptHarnessDecisionKind, packageId);
    if (baseline.has(key)) {
      throw new Error(`${label} duplicates an earlier decision`);
    }
    baseline.set(key, count as number);
  });
  return baseline;
}

const RECEIPT_HARNESS_DECISION_BASELINE = parseReceiptHarnessDecisionBaseline(
  readFileSync(HARNESS_DEBT_PATH, "utf8"),
  toRepoPath(HARNESS_DEBT_PATH),
);

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isProductionTsFile(absPath: string): boolean {
  return (
    /\.(?:cts|mts|ts|tsx)$/.test(absPath) && !/\.(?:test|spec)\.(?:cts|mts|ts|tsx)$/.test(absPath)
  );
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  const rootStats = lstatSync(dir);
  if (rootStats.isSymbolicLink()) return;
  if (rootStats.isFile()) {
    if (isProductionTsFile(dir)) yield dir;
    return;
  }
  if (!rootStats.isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(absPath);
    } else if (entry.isFile() && isProductionTsFile(absPath)) {
      yield absPath;
    }
  }
}

function sourceFileFor(absPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function position(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function collectImportRefs(sourceFile: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];

  function add(specifier: string, node: ts.Node): void {
    const pos = position(sourceFile, node);
    refs.push({ specifier, ...pos });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

function collectPreprocessedImportRefs(source: string): ImportRef[] {
  let line = 1;
  let lineStart = 0;
  let searchStart = 0;
  return ts.preProcessFile(source, true, true).importedFiles.map((ref) => {
    let newline = source.indexOf("\n", searchStart);
    while (newline >= 0 && newline < ref.pos) {
      line += 1;
      lineStart = newline + 1;
      searchStart = lineStart;
      newline = source.indexOf("\n", searchStart);
    }
    return {
      specifier: ref.fileName,
      line,
      column: ref.pos - lineStart + 1,
    };
  });
}

function resolveInternalImport(fromAbsPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromAbsPath), specifier);
  const extensions = [".ts", ".tsx", ".mts", ".cts"];
  const extension = path.extname(base);
  const replacementExtensions =
    extension === ".js"
      ? [".ts", ".tsx"]
      : extension === ".mjs"
        ? [".mts"]
        : extension === ".cjs"
          ? [".cts"]
          : [];
  const candidates = extension
    ? [
        base,
        ...replacementExtensions.map(
          (replacement) => base.slice(0, -extension.length) + replacement,
        ),
      ]
    : [
        ...extensions.map((candidate) => `${base}${candidate}`),
        ...extensions.map((candidate) => path.join(base, `index${candidate}`)),
      ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    const replacement = replacementExtensions[0];
    return toRepoPath(
      replacement
        ? base.slice(0, -extension.length) + replacement
        : extension
          ? base
          : `${base}.ts`,
    );
  }
  try {
    return toRepoPath(realpathSync(found));
  } catch {
    return toRepoPath(found);
  }
}

/** Return every internal module that directly or transitively consumes package authority. */
function collectPackageAuthorityConsumers(
  entryPaths: readonly string[],
  receiptBackedCallbackModules: ReadonlySet<string>,
): ReadonlySet<string> {
  const importsByModule = new Map<string, readonly string[]>();
  const pending = [...entryPaths];
  const queued = new Set(entryPaths.map(toRepoPath));

  while (pending.length > 0) {
    const absPath = pending.pop();
    if (!absPath || !existsSync(absPath) || !isProductionTsFile(absPath)) continue;
    const repoPath = toRepoPath(absPath);
    const source = readFileSync(absPath, "utf8");
    const sourceFile = sourceFileFor(absPath, source);
    const targets = collectImportRefs(sourceFile).flatMap((ref) => {
      const target = resolveInternalImport(absPath, ref.specifier);
      return target?.startsWith("src/") ? [target] : [];
    });
    importsByModule.set(repoPath, targets);
    for (const target of targets) {
      if (queued.has(target)) continue;
      const targetPath = path.join(REPO_ROOT, target);
      if (!existsSync(targetPath) || !isProductionTsFile(targetPath)) continue;
      queued.add(target);
      pending.push(targetPath);
    }
  }

  const importersByModule = new Map<string, Set<string>>();
  for (const [importer, targets] of importsByModule) {
    for (const target of targets) {
      const importers = importersByModule.get(target) ?? new Set<string>();
      importers.add(importer);
      importersByModule.set(target, importers);
    }
  }

  const consumers = new Set<string>();
  const pendingConsumers = [...PACKAGE_AUTHORITY_MODULES];
  while (pendingConsumers.length > 0) {
    const target = pendingConsumers.pop();
    if (!target || consumers.has(target)) continue;
    consumers.add(target);
    for (const importer of importersByModule.get(target) ?? []) {
      pendingConsumers.push(importer);
    }
  }
  for (const callbackModule of receiptBackedCallbackModules) {
    if (queued.has(callbackModule)) consumers.add(callbackModule);
  }
  return consumers;
}

function readAgentRuntimePackageDependencies(
  packagesRoot: string,
): readonly AgentRuntimePackageDependency[] {
  const packages: AgentRuntimePackageDependency[] = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      nemoclaw?: { harnessManifest?: unknown };
    };
    if (typeof metadata.nemoclaw?.harnessManifest !== "string") continue;
    if (typeof metadata.name !== "string" || !metadata.name.trim()) {
      throw new Error(
        `Agent runtime package metadata has no package name: ${toRepoPath(packageRoot)}`,
      );
    }
    const manifestPath = path.resolve(packageRoot, metadata.nemoclaw.harnessManifest);
    let packageId: string | undefined;
    if (existsSync(manifestPath)) {
      const manifest = parseYaml(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        typeof (manifest as { name?: unknown }).name === "string"
      ) {
        packageId = (manifest as { name: string }).name;
      }
    }
    packages.push({
      packageName: metadata.name,
      packageRoot: toRepoPath(realpathSync(packageRoot)),
      ...(packageId ? { packageId } : {}),
    });
  }
  return packages.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function checkHarnessAgnosticRuntimeModule(
  repoPath: string,
  sourceFile: ts.SourceFile,
  packageIds: ReadonlySet<string>,
  violations: Violation[],
): void {
  if (
    LEGACY_HARNESS_ID_MODULES.has(repoPath) ||
    !HARNESS_AGNOSTIC_RUNTIME_PREFIXES.some((prefix) => repoPath.startsWith(prefix))
  ) {
    return;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && packageIds.has(node.text)) {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "harness-contract-neutrality",
        `generic harness contract code must not encode package ID '${node.text}'`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Reject exact package IDs passed directly to receipt-store operations. */
function checkExactPackageReceiptSelector(
  repoPath: string,
  sourceFile: ts.SourceFile,
  packageIds: ReadonlySet<string>,
  violations: Violation[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const selector = node.arguments[0];
      const functionName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (
        functionName !== null &&
        PACKAGE_RECEIPT_SELECTOR_FUNCTIONS.has(functionName) &&
        ts.isStringLiteralLike(selector) &&
        packageIds.has(selector.text)
      ) {
        const pos = position(sourceFile, selector);
        addViolation(
          violations,
          repoPath,
          pos.line,
          pos.column,
          "receipt-backed-package-selector",
          `receipt-backed operation '${functionName}' must receive package authority instead of exact package ID '${selector.text}'`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function checkReceiptBackedHarnessBranch(
  repoPath: string,
  sourceFile: ts.SourceFile,
  packageAuthorityConsumers: ReadonlySet<string>,
  packageIds: ReadonlySet<string>,
  baseline: ReadonlyMap<string, number>,
  usedAllowances: Map<string, number>,
  violations: Violation[],
): void {
  if (!packageAuthorityConsumers.has(repoPath)) return;
  if (
    repoPath.includes("/__test-helpers__/") ||
    /(?:^|\/)[^/]*(?:test-fixtures?|test-helpers|test-support)(?:[.-])/u.test(repoPath)
  ) {
    return;
  }
  const isEqualityOperator = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isExactPackageId = (node: ts.Node): node is ts.StringLiteralLike =>
    ts.isStringLiteralLike(node) && packageIds.has(node.text);
  const decisionOwner = (node: ts.Node): string => {
    let current: ts.Node | undefined = node;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return current.name?.getText(sourceFile) ?? "<anonymous>";
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent;
        if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile);
        if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
      }
      current = current.parent;
    }
    return "<module>";
  };
  const allowanceKey = (
    owner: string,
    kind: ReceiptHarnessDecisionKind,
    packageId: string,
  ): string => receiptDecisionKey(repoPath, owner, kind, packageId);
  const report = (
    node: ts.Identifier | ts.StringLiteralLike,
    kind: ReceiptHarnessDecisionKind,
  ): void => {
    const owner = decisionOwner(node);
    const key = allowanceKey(owner, kind, node.text);
    const allowance = baseline.get(key) ?? 0;
    const used = usedAllowances.get(key) ?? 0;
    if (used < allowance) {
      usedAllowances.set(key, used + 1);
      return;
    }
    const pos = position(sourceFile, node);
    addViolation(
      violations,
      repoPath,
      pos.line,
      pos.column,
      "receipt-backed-harness-neutrality",
      `receipt-backed production code must use package metadata instead of branching on package ID '${node.text}' (${kind} decision in '${owner}')`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isEqualityOperator(node.operatorToken.kind) &&
      (isExactPackageId(node.left) || isExactPackageId(node.right))
    ) {
      if (isExactPackageId(node.left)) report(node.left, "equality");
      if (isExactPackageId(node.right)) report(node.right, "equality");
    } else if (ts.isCaseClause(node) && isExactPackageId(node.expression)) {
      report(node.expression, "switch-case");
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      ts.isArrayLiteralExpression(node.expression.expression)
    ) {
      for (const element of node.expression.expression.elements) {
        if (isExactPackageId(element)) report(element, "membership");
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "get" || node.expression.name.text === "has") &&
      node.arguments.length > 0 &&
      isExactPackageId(node.arguments[0])
    ) {
      report(node.arguments[0], "lookup");
    } else if (ts.isElementAccessExpression(node) && isExactPackageId(node.argumentExpression)) {
      report(node.argumentExpression, "lookup");
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "Map" || node.expression.text === "Set") &&
      node.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(node.arguments[0])
    ) {
      for (const element of node.arguments[0].elements) {
        if (node.expression.text === "Set" && isExactPackageId(element)) {
          report(element, "membership");
        } else if (
          node.expression.text === "Map" &&
          ts.isArrayLiteralExpression(element) &&
          element.elements.length > 0 &&
          isExactPackageId(element.elements[0])
        ) {
          report(element.elements[0], "lookup");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function checkReceiptHarnessDecisionBaseline(
  baseline: ReadonlyMap<string, number>,
  usedAllowances: ReadonlyMap<string, number>,
  violations: Violation[],
): void {
  for (const [key, expectedCount] of baseline) {
    const actualCount = usedAllowances.get(key) ?? 0;
    if (actualCount === expectedCount) continue;
    const [file, owner, kind, packageId] = key.split("\0");
    addViolation(
      violations,
      toRepoPath(HARNESS_DEBT_PATH),
      1,
      1,
      "receipt-backed-harness-debt",
      `package ID '${packageId}' expects ${String(expectedCount)} ${kind} decision occurrence(s) in '${owner}' at ${file}, but found ${String(actualCount)}`,
    );
  }
}

function importedAgentRuntimePackage(
  fromAbsPath: string,
  specifier: string,
  packages: readonly AgentRuntimePackageDependency[],
): AgentRuntimePackageDependency | null {
  for (const dependency of packages) {
    if (
      specifier === dependency.packageName ||
      specifier.startsWith(`${dependency.packageName}/`)
    ) {
      return dependency;
    }
  }
  const target = resolveInternalImport(fromAbsPath, specifier);
  if (!target) return null;
  return (
    packages.find(
      (dependency) =>
        target === dependency.packageRoot || target.startsWith(`${dependency.packageRoot}/`),
    ) ?? null
  );
}

function checkAgentRuntimePackageImports(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  packages: readonly AgentRuntimePackageDependency[],
  usedLegacyImports: Map<string, number>,
  violations: Violation[],
): void {
  for (const ref of imports) {
    const dependency = importedAgentRuntimePackage(absPath, ref.specifier, packages);
    if (!dependency) continue;
    const exceptionKey = `${repoPath}\0${ref.specifier}`;
    const exceptionLimit = LEGACY_AGENT_RUNTIME_PACKAGE_IMPORTS.get(exceptionKey) ?? 0;
    const exceptionUseCount = usedLegacyImports.get(exceptionKey) ?? 0;
    if (exceptionUseCount < exceptionLimit) {
      usedLegacyImports.set(exceptionKey, exceptionUseCount + 1);
      continue;
    }
    addViolation(
      violations,
      repoPath,
      ref.line,
      ref.column,
      "core-no-agent-runtime-package-imports",
      `core source must use the typed agent runtime package contract instead of importing ${dependency.packageName}`,
    );
  }
}

function isDomainFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/domain/");
}

function isAdapterFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/adapters/");
}

function isCommandFile(repoPath: string): boolean {
  return repoPath.startsWith("src/commands/");
}

function isMessagingManifestFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/messaging/manifest/");
}

function isActionFile(repoPath: string): boolean {
  if (repoPath.startsWith("src/lib/actions/")) return true;
  return /(^|\/)[^/]+-actions?\.(?:cts|mts|ts|tsx)$/.test(repoPath);
}

function importTargetsForbiddenLayer(
  fromAbsPath: string,
  ref: ImportRef,
  forbiddenPrefixes: readonly string[],
  forbiddenActionFiles = false,
): string | null {
  const target = resolveInternalImport(fromAbsPath, ref.specifier);
  if (!target) return null;
  if (forbiddenPrefixes.some((prefix) => target.startsWith(prefix))) return target;
  if (forbiddenActionFiles && isActionFile(target)) return target;
  return null;
}

function addViolation(
  violations: Violation[],
  file: string,
  line: number,
  column: number,
  rule: string,
  detail: string,
): void {
  violations.push({ file, line, column, rule, detail });
}

function checkDomainFile(
  absPath: string,
  repoPath: string,
  sourceFile: ts.SourceFile,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not import @oclif/core",
      );
    }
    if (ref.specifier === "node:child_process" || ref.specifier === "child_process") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not spawn child processes",
      );
    }
    const target = importTargetsForbiddenLayer(
      absPath,
      ref,
      ["src/lib/adapters/", "src/commands/", "src/lib/cli/"],
      true,
    );
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        `domain must not import ${target}`,
      );
    }
  }
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "exit"
    ) {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "domain-purity",
        "domain must not call process.exit",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function checkActionFile(
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "actions-no-oclif",
        "actions must not import @oclif/core",
      );
    }
  }
}

function checkAdapterFile(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    const target = importTargetsForbiddenLayer(absPath, ref, ["src/commands/"], true);
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "adapters-no-workflows",
        `adapters must not import command/action layer module ${target}`,
      );
    }
  }
}

function checkNoBinLibShimImport(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    const target = resolveInternalImport(absPath, ref.specifier);
    if (target?.startsWith("bin/lib/") && !target.endsWith(".json")) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "src-no-bin-lib-shims",
        `src must import implementation modules directly instead of packaged shim ${target}`,
      );
    }
  }
}

function checkMessagingManifestFile(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  const forbiddenFragments = [
    "gateway",
    "state/registry",
    "credentials",
    "node:fs",
    "node:child_process",
    "child_process",
    "adapters/openshell",
    "src/commands",
    "lib/actions",
  ];

  for (const ref of imports) {
    if (ref.specifier === "fs" || ref.specifier.startsWith("fs/")) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "messaging-manifest-purity",
        "messaging manifest modules must not import fs",
      );
      continue;
    }
    const target = resolveInternalImport(absPath, ref.specifier);
    const haystack = `${ref.specifier}\n${target ?? ""}`;
    const fragment = forbiddenFragments.find((candidate) => haystack.includes(candidate));
    if (fragment) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "messaging-manifest-purity",
        `messaging manifest modules must not import ${fragment}`,
      );
    }
  }
}

function checkCommandFile(
  absPath: string,
  repoPath: string,
  sourceFile: ts.SourceFile,
  violations: Violation[],
): void {
  const identifierBases = new Set<string>();
  const namespaceBases = new Map<string, ReadonlySet<string>>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier.text;
    const resolvedModule = resolveInternalImport(absPath, moduleSpecifier);
    const exportedBases =
      moduleSpecifier === "@oclif/core"
        ? new Set(["Command"])
        : resolvedModule === "src/lib/cli/nemoclaw-oclif-command.ts"
          ? new Set(["NemoClawCommand"])
          : resolvedModule === "src/lib/cli/internal-command.ts"
            ? new Set(["NemoClawInternalCommand"])
            : null;
    if (!exportedBases) continue;

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const importedName = binding.propertyName?.text ?? binding.name.text;
        if (exportedBases.has(importedName)) identifierBases.add(binding.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBases.set(bindings.name.text, exportedBases);
    }
  }

  function isCommandBase(expression: ts.ExpressionWithTypeArguments): boolean {
    const base = expression.expression;
    if (ts.isIdentifier(base)) return identifierBases.has(base.text);
    return (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      namespaceBases.get(base.expression.text)?.has(base.name.text) === true
    );
  }

  const commandClassCount = sourceFile.statements.filter(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(isCommandBase),
      ),
  ).length;
  if (commandClassCount !== 1) {
    addViolation(
      violations,
      repoPath,
      1,
      1,
      "one-command-per-file",
      `command files must define exactly one registered oclif command class; found ${commandClassCount}`,
    );
  }
}

export function findLayerImportBoundaryViolations(
  root = SRC_ROOT,
  packagesRoot = PACKAGES_ROOT,
  options: LayerImportBoundaryOptions = {},
): Violation[] {
  const violations: Violation[] = [];
  const agentRuntimePackages = readAgentRuntimePackageDependencies(packagesRoot);
  const packageIds = new Set(
    agentRuntimePackages
      .map((dependency) => dependency.packageId)
      .filter((packageId): packageId is string => packageId !== undefined),
  );
  const usedLegacyAgentRuntimeImports = new Map<string, number>();
  const productionFiles = [...walk(root)];
  const packageAuthorityConsumers = collectPackageAuthorityConsumers(
    productionFiles,
    options.receiptBackedCallbackModules ?? RECEIPT_BACKED_CALLBACK_MODULES,
  );
  const receiptHarnessDecisionBaseline =
    options.receiptHarnessDecisionBaseline ?? RECEIPT_HARNESS_DECISION_BASELINE;
  const usedReceiptHarnessDecisionAllowances = new Map<string, number>();
  for (const absPath of productionFiles) {
    const repoPath = toRepoPath(absPath);
    const domainFile = isDomainFile(repoPath);
    const actionFile = isActionFile(repoPath);
    const adapterFile = isAdapterFile(repoPath);
    const messagingManifestFile = isMessagingManifestFile(repoPath);
    const commandFile = isCommandFile(repoPath);
    const source = readFileSync(absPath, "utf8");
    const sourceFile = sourceFileFor(absPath, source);
    const imports = collectImportRefs(sourceFile);
    checkAgentRuntimePackageImports(
      absPath,
      repoPath,
      imports,
      agentRuntimePackages,
      usedLegacyAgentRuntimeImports,
      violations,
    );
    checkHarnessAgnosticRuntimeModule(repoPath, sourceFile, packageIds, violations);
    checkExactPackageReceiptSelector(repoPath, sourceFile, packageIds, violations);
    checkReceiptBackedHarnessBranch(
      repoPath,
      sourceFile,
      packageAuthorityConsumers,
      packageIds,
      receiptHarnessDecisionBaseline,
      usedReceiptHarnessDecisionAllowances,
      violations,
    );
    if (!domainFile && !actionFile && !adapterFile && !messagingManifestFile && !commandFile) {
      checkNoBinLibShimImport(absPath, repoPath, collectPreprocessedImportRefs(source), violations);
      continue;
    }
    checkNoBinLibShimImport(absPath, repoPath, imports, violations);
    if (domainFile) {
      checkDomainFile(absPath, repoPath, sourceFile, imports, violations);
    }
    if (actionFile) checkActionFile(repoPath, imports, violations);
    if (adapterFile) checkAdapterFile(absPath, repoPath, imports, violations);
    if (messagingManifestFile) {
      checkMessagingManifestFile(absPath, repoPath, imports, violations);
    }
    if (commandFile) checkCommandFile(absPath, repoPath, sourceFile, violations);
  }
  const verifyReceiptHarnessDecisionBaseline =
    options.verifyReceiptHarnessDecisionBaseline ?? path.resolve(root) === SRC_ROOT;
  if (verifyReceiptHarnessDecisionBaseline) {
    checkReceiptHarnessDecisionBaseline(
      receiptHarnessDecisionBaseline,
      usedReceiptHarnessDecisionAllowances,
      violations,
    );
  }
  return violations;
}

export function findManagedRuntimeBoundaryViolations(packagesRoot = PACKAGES_ROOT): Violation[] {
  const violations: Violation[] = [];
  const managedAgentIds = new Set(
    readAgentRuntimePackageDependencies(packagesRoot)
      .map(({ packageId }) => packageId)
      .filter((packageId): packageId is string => packageId !== undefined),
  );
  const isProviderImplementationImport = (specifier: string): boolean =>
    /(?:^|\/)runtime-provider\/(?:docker|podman)(?:[-/.]|$)/.test(specifier);
  const isProviderName = (node: ts.Node): boolean =>
    ts.isStringLiteralLike(node) && (node.text === "docker" || node.text === "podman");
  const isEqualityOperator = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  for (const repoPath of PROVIDER_NEUTRAL_MANAGED_RUNTIME_MODULES) {
    const absPath = path.join(REPO_ROOT, repoPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const isProviderIdentity = (node: ts.Node): boolean => {
      const expression = node.getText(sourceFile);
      // OPENSHELL_DRIVERS is the upstream gateway driver's configuration,
      // not NemoClaw's opaque runtime-provider identity.
      return (
        !/OPENSHELL_DRIVERS/.test(expression) &&
        /(?:provider|engine|openshellDriver|sandboxDriver|driver)/i.test(expression)
      );
    };
    const report = (node: ts.Node, detail: string): void => {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "managed-runtime-neutrality",
        detail,
      );
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isProviderImplementationImport(node.moduleSpecifier.text)
      ) {
        report(
          node.moduleSpecifier,
          "generic managed runtime code must not import a provider implementation",
        );
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) &&
          node.expression.text === "isPodmanGatewayRuntimeEnabled") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "isPodmanGatewayRuntimeEnabled"))
      ) {
        report(node.expression, "generic managed runtime code must not branch on native Podman");
      }
      if (
        ts.isBinaryExpression(node) &&
        isEqualityOperator(node.operatorToken.kind) &&
        ((isProviderName(node.left) && isProviderIdentity(node.right)) ||
          (isProviderName(node.right) && isProviderIdentity(node.left)))
      ) {
        report(node, "generic managed runtime code must not compare an opaque provider identity");
      }
      if (
        ts.isCaseClause(node) &&
        isProviderName(node.expression) &&
        ts.isSwitchStatement(node.parent.parent) &&
        isProviderIdentity(node.parent.parent.expression)
      ) {
        report(
          node.expression,
          "generic managed runtime code must not switch on an opaque provider identity",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const managedBootstrapFiles = [
    ...walk(path.join(SRC_ROOT, "lib/onboard/managed-bootstrap")),
  ].filter((absPath) => !path.basename(absPath).includes("test-fixture"));
  const podmanProviderFiles = [...walk(path.join(SRC_ROOT, "lib/onboard/runtime-provider"))].filter(
    (absPath) => path.basename(absPath).startsWith("podman"),
  );
  for (const absPath of [...managedBootstrapFiles, ...podmanProviderFiles]) {
    const repoPath = toRepoPath(absPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const report = (node: ts.Node, detail: string): void => {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "managed-state-root-neutrality",
        detail,
      );
    };
    for (const ref of collectImportRefs(sourceFile)) {
      const target = resolveInternalImport(absPath, ref.specifier);
      if (
        podmanProviderFiles.includes(absPath) &&
        target &&
        /(?:^|\/)(?:hermes|openclaw)(?:[-/.]|$)/u.test(target)
      ) {
        addViolation(
          violations,
          repoPath,
          ref.line,
          ref.column,
          "managed-state-root-neutrality",
          `Podman provider code must not import agent implementation ${target}`,
        );
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && managedAgentIds.has(node.text)) {
        report(node, "managed bootstrap and Podman provider code must not encode agent IDs");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const repoPath of MANAGED_STATE_ROOT_PROVIDER_MODULES) {
    const absPath = path.join(REPO_ROOT, repoPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const ownsGenericStateRootPreparation = collectImportRefs(sourceFile).some(
      (ref) =>
        resolveInternalImport(absPath, ref.specifier) ===
        "src/lib/onboard/managed-bootstrap/state-root-authority.ts",
    );
    if (!ownsGenericStateRootPreparation) {
      addViolation(
        violations,
        repoPath,
        1,
        1,
        "managed-state-root-neutrality",
        "managed provider bootstrap must consume the generic state-root authority operation",
      );
    }
  }
  return violations;
}

/**
 * Keep publishable harness images from reaching back into core for native
 * harness behavior. Generic build infrastructure may still be composed by the
 * host, but gateway control and messaging application must ship with the
 * package whose Dockerfile executes them.
 */
export function findPackageImageBoundaryViolations(packagesRoot = PACKAGES_ROOT): Violation[] {
  const violations: Violation[] = [];
  if (!existsSync(packagesRoot)) return violations;
  const packageDependencies = readAgentRuntimePackageDependencies(packagesRoot);
  const packageIds = packageDependencies
    .map(({ packageId }) => packageId)
    .filter((packageId): packageId is string => packageId !== undefined);

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);

    for (const absPath of walk(packageRoot)) {
      const packageRelativePath = path.relative(packageRoot, absPath);
      const pathSegments = packageRelativePath.split(path.sep);
      if (
        pathSegments.some((segment) => segment === "test" || segment === "tests") ||
        /^vitest(?:\.|$)/u.test(path.basename(absPath))
      ) {
        continue;
      }

      const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
      for (const ref of collectImportRefs(sourceFile)) {
        if (!ref.specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(absPath), ref.specifier);
        const targetRelativePath = path.relative(packageRoot, target);
        if (
          targetRelativePath !== ".." &&
          !targetRelativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(targetRelativePath)
        ) {
          continue;
        }
        addViolation(
          violations,
          toRepoPath(absPath),
          ref.line,
          ref.column,
          "package-source-locality",
          `package production source must not import outside its package root: ${ref.specifier}`,
        );
      }
    }

    const dockerfile = path.join(packagesRoot, entry.name, "Dockerfile");
    if (!existsSync(dockerfile) || !lstatSync(dockerfile).isFile()) continue;
    const source = readFileSync(dockerfile, "utf8");
    source.split(/\r?\n/u).forEach((line, index) => {
      const copy = /^\s*COPY(?:\s+--[^\s]+)*\s+(.+)$/iu.exec(line);
      if (!copy) return;
      const sources = copy[1].trim().split(/\s+/u).slice(0, -1);
      for (const copiedSource of sources) {
        if (
          copiedSource === "scripts/managed-gateway-control.py" ||
          copiedSource === "src/lib/messaging" ||
          copiedSource.startsWith("src/lib/messaging/")
        ) {
          addViolation(
            violations,
            toRepoPath(dockerfile),
            index + 1,
            Math.max(1, line.indexOf(copiedSource) + 1),
            "package-image-native-ownership",
            `publishable harness image must use a package-owned native artifact instead of ${copiedSource}`,
          );
        }
      }
    });

    const packageJsonPath = path.join(packageRoot, "package.json");
    const sharedRuntimeArtifacts = [
      {
        artifact: "managed-gateway",
        path: "runtime/managed-gateway-control.py",
      },
      {
        artifact: "messaging-build",
        path: "messaging/messaging-build.mts",
      },
    ].filter(({ path: artifactPath }) => existsSync(path.join(packageRoot, artifactPath)));
    if (sharedRuntimeArtifacts.length > 0 && existsSync(packageJsonPath)) {
      const packageJsonSource = readFileSync(packageJsonPath, "utf8");
      const packageJson = JSON.parse(packageJsonSource) as {
        readonly dependencies?: Readonly<Record<string, unknown>>;
        readonly devDependencies?: Readonly<Record<string, unknown>>;
        readonly scripts?: Readonly<Record<string, unknown>>;
      };
      const scripts = packageJson.scripts ?? {};
      const buildRuntime =
        typeof scripts["build:runtime"] === "string" ? scripts["build:runtime"] : "";
      const checkRuntime =
        typeof scripts["check:runtime"] === "string" ? scripts["check:runtime"] : "";
      const allScripts = Object.values(scripts)
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      for (const forbiddenSource of [
        "scripts/packages/build-managed-gateway-runtime",
        "scripts/packages/build-messaging-runtime",
        "scripts/runtime/managed-gateway-runtime",
        "src/lib/messaging/applier/build/messaging-build-applier",
      ]) {
        if (!allScripts.includes(forbiddenSource)) continue;
        addViolation(
          violations,
          toRepoPath(packageJsonPath),
          1,
          1,
          "package-image-runtime-materializer",
          `package runtime scripts must not reach into NemoClaw core source ${forbiddenSource}`,
        );
      }
      const contractDependency =
        packageJson.dependencies?.["@nvidia/nemoclaw-harness-contract"] ??
        packageJson.devDependencies?.["@nvidia/nemoclaw-harness-contract"];
      if (typeof contractDependency !== "string" || contractDependency.length === 0) {
        addViolation(
          violations,
          toRepoPath(packageJsonPath),
          1,
          1,
          "package-image-runtime-materializer",
          "shared runtime artifacts require @nvidia/nemoclaw-harness-contract",
        );
      }
      for (const { artifact, path: artifactPath } of sharedRuntimeArtifacts) {
        const command = `nemoclaw-materialize-runtime ${artifact} ${artifactPath}`;
        if (!buildRuntime.includes(command) || !checkRuntime.includes(`${command} --check`)) {
          addViolation(
            violations,
            toRepoPath(packageJsonPath),
            1,
            1,
            "package-image-runtime-materializer",
            `shared runtime artifact ${artifactPath} must be built and checked with ${command}`,
          );
        }
      }
    }

    const packageId = packageDependencies.find(
      ({ packageRoot }) => path.basename(packageRoot) === entry.name,
    )?.packageId;
    const profilePath = path.join(packagesRoot, entry.name, "runtime/managed-gateway-profile.py");
    if (packageId && existsSync(profilePath) && lstatSync(profilePath).isFile()) {
      const profile = readFileSync(profilePath, "utf8");
      for (const otherPackageId of packageIds) {
        if (otherPackageId === packageId) continue;
        const escapedId = otherPackageId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const match = new RegExp(`(^|[^a-z0-9-])${escapedId}([^a-z0-9-]|$)`, "iu").exec(profile);
        if (!match) continue;
        const prefix = profile.slice(0, match.index + match[1].length);
        addViolation(
          violations,
          toRepoPath(profilePath),
          prefix.split(/\r?\n/u).length,
          1,
          "package-image-native-ownership",
          `managed gateway profile for ${packageId} must not encode package ${otherPackageId}`,
        );
      }
    }
  }
  return violations;
}

function main(): void {
  const violations = [
    ...findLayerImportBoundaryViolations(),
    ...findManagedRuntimeBoundaryViolations(),
    ...findPackageImageBoundaryViolations(),
  ];
  if (violations.length > 0) {
    const formatted = violations
      .map(
        (violation) =>
          `${violation.file}:${String(violation.line)}:${String(violation.column)} ${violation.rule}: ${violation.detail}`,
      )
      .join("\n");
    console.error(`Layer import boundary violations:\n${formatted}`);
    process.exit(1);
  }
  console.log("Layer import boundaries passed.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main();
}
