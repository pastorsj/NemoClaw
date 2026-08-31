// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const MCPORTER_VERSION = "0.7.3";
const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";

function mcporterAvailabilityProbe(sandboxName) {
  return {
    command: "command -v mcporter",
    failureMessage: `mcporter is not available in sandbox '${sandboxName}'. Rebuild with a NemoClaw image that includes mcporter@${MCPORTER_VERSION}.`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pythonJsonLiteral(value) {
  return JSON.stringify(JSON.stringify(value));
}

function openClawMcporterRoot(configDir = DEFAULT_OPENCLAW_CONFIG_DIR) {
  return `${configDir.replace(/\/+$/, "")}/workspace`;
}

const OPENCLAW_MCPORTER_ROOT = openClawMcporterRoot();

/**
 * mcporter@0.7.3 synthesizes one accept header in `config get --json` output.
 * Treat only that header and a bounded revision of the expected credential
 * placeholder as equivalent to the package-owned registration intent.
 */
function mcporterHeadersMatchExpected(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualHeaders = actual;
  for (const [name, value] of Object.entries(expected)) {
    if (actualHeaders[name] === value) continue;
    const canonicalPrefix = "Bearer openshell:resolve:env:";
    const envName = value.startsWith(canonicalPrefix) ? value.slice(canonicalPrefix.length) : "";
    const actualValue = actualHeaders[name];
    if (
      name.toLowerCase() !== "authorization" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(envName) ||
      typeof actualValue !== "string"
    ) {
      return false;
    }
    const escapedEnvName = envName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (
      !new RegExp(
        `^${canonicalPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}v[0-9]{1,20}_${escapedEnvName}$`,
        "u",
      ).test(actualValue)
    ) {
      return false;
    }
  }
  const extraNames = Object.keys(actualHeaders).filter((name) => !Object.hasOwn(expected, name));
  if (extraNames.length === 0) return true;
  if (extraNames.length !== 1) return false;
  const [extraName] = extraNames;
  return (
    extraName.toLowerCase() === "accept" &&
    actualHeaders[extraName] === "application/json, text/event-stream"
  );
}

function mcporterHeaderMatcherSource() {
  return `const mcporterHeadersMatchExpected = ${mcporterHeadersMatchExpected.toString()};`;
}

function mcporterArgs(root, ...args) {
  return ["mcporter", "--root", root, ...args];
}

function buildRegisterCommand(entry, replaceExisting = false, root = OPENCLAW_MCPORTER_ROOT) {
  const args = mcporterArgs(root, "config", "add", entry.server, "--url", entry.url);
  const authorization = entry.headers.Authorization;
  if (authorization) args.push("--header", `Authorization=${authorization}`);
  args.push("--scope", "project");
  const addCommand = args.map(shellQuote).join(" ");
  if (replaceExisting) return addCommand;
  const getCommand = mcporterArgs(root, "config", "get", entry.server, "--json")
    .map(shellQuote)
    .join(" ");
  return [
    `if ${getCommand} >/dev/null 2>&1; then`,
    `  echo ${shellQuote(`MCP server '${entry.server}' already exists in mcporter config and is not managed by NemoClaw.`)} >&2`,
    "  exit 2",
    "fi",
    addCommand,
  ].join("\n");
}

function buildRemoveCommand(entry, force = false, root = OPENCLAW_MCPORTER_ROOT) {
  const payload = { ...entry, force, root };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    mcporterHeaderMatcherSource(),
    'const detail = (result) => `${result.stderr || ""}\\n${result.stdout || ""}`;',
    "const isAbsent = (result) => result.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(detail(result));",
    "const isMissingConfig = (result, configPath) => result.status !== 0 && /ENOENT: no such file or directory/i.test(detail(result)) && detail(result).includes(configPath);",
    'const projectDir = path.join(expected.root, "config");',
    'const xdgHome = path.isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");',
    'const xdgDir = path.join(xdgHome, "mcporter");',
    'const legacyHomeDir = path.join(os.homedir(), ".mcporter");',
    'const configPaths = [...new Set([projectDir, xdgDir, legacyHomeDir].filter(Boolean).flatMap((dir) => [path.join(dir, "mcporter.json"), path.join(dir, "mcporter.jsonc")]))];',
    "const ownedPaths = [];",
    "for (const configPath of configPaths) {",
    '  const get = spawnSync("mcporter", ["--root", expected.root, "config", "--config", configPath, "get", expected.server, "--json"], { encoding: "utf8" });',
    "  if (get.error) { console.error(get.error.message); process.exit(3); }",
    "  if (isAbsent(get) || isMissingConfig(get, configPath)) continue;",
    "  if (get.status !== 0) { console.error(detail(get).trim()); process.exit(3); }",
    "  let actual = null; try { actual = JSON.parse(get.stdout); } catch {}",
    '  const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    '  const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    "  if (!registered && !expected.force) { console.error(`Refusing to remove modified mcporter MCP server '${expected.server}' from ${configPath}. Use --force to remove it.`); process.exit(2); }",
    "  ownedPaths.push(configPath);",
    "}",
    "for (const configPath of ownedPaths) {",
    '  const remove = spawnSync("mcporter", ["--root", expected.root, "config", "--config", configPath, "remove", expected.server], { encoding: "utf8" });',
    "  if (remove.stdout) process.stdout.write(remove.stdout);",
    "  if (remove.stderr) process.stderr.write(remove.stderr);",
    "  if (remove.error) { console.error(remove.error.message); process.exit(3); }",
    "  if (remove.status !== 0 && !isAbsent(remove)) process.exit(remove.status === null ? 3 : remove.status);",
    "}",
    'const effective = spawnSync("mcporter", ["--root", expected.root, "config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (effective.error) { console.error(effective.error.message); process.exit(3); }",
    "if (isAbsent(effective)) process.exit(0);",
    "if (effective.status !== 0) { console.error(detail(effective).trim()); process.exit(3); }",
    "console.error(`mcporter MCP server '${expected.server}' still resolves after managed configuration cleanup.`);",
    "process.exit(2);",
    "NODE",
  ].join("\n");
}

function buildInspectCommand(entry, failOnMismatch, root = OPENCLAW_MCPORTER_ROOT) {
  const payload = { ...entry, failOnMismatch, root };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const result = spawnSync("mcporter", ["--root", expected.root, "config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (result.error) { console.error(result.error.message); process.exit(3); }",
    "if (result.status !== 0) {",
    '  const detail = `${result.stderr || ""}\\n${result.stdout || ""}`;',
    "  if (/not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(detail)) { console.log('absent'); process.exit(0); }",
    "  console.error(detail.trim() || `mcporter config get exited ${result.status}`);",
    "  process.exit(3);",
    "}",
    "let actual = null;",
    "try { actual = JSON.parse(result.stdout); } catch {}",
    'const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    mcporterHeaderMatcherSource(),
    'const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    'console.log(registered ? "registered" : "mismatch");',
    "if (!registered && expected.failOnMismatch) process.exit(2);",
    "NODE",
  ].join("\n");
}

function buildMcpRegistrationCommand(request) {
  return buildRegisterCommand(
    request.entry,
    request.replaceExisting,
    request.configRoot || OPENCLAW_MCPORTER_ROOT,
  );
}

function buildMcpRemovalCommand(request) {
  return buildRemoveCommand(
    request.entry,
    request.force,
    request.configRoot || OPENCLAW_MCPORTER_ROOT,
  );
}

module.exports = {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  MCPORTER_VERSION,
  OPENCLAW_MCPORTER_ROOT,
  buildInspectCommand,
  buildMcpRegistrationCommand,
  buildMcpRemovalCommand,
  buildRegisterCommand,
  buildRemoveCommand,
  mcporterHeaderMatcherSource,
  mcporterHeadersMatchExpected,
  mcporterAvailabilityProbe,
  openClawMcporterRoot,
};
