// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import type {
  HarnessWebSearchCapability,
  HarnessWebSearchProviderBinding,
} from "@nvidia/nemoclaw-harness-contract";
import {
  assertWebSearchVerificationMatchesProviderProfile,
  resolvePackageCredentialProviderProfile,
} from "../agent-runtime/provider-profile";
import { packageWebSearchProviderBinding } from "../agent-runtime/web-search";
import { shellQuote } from "../core/shell-quote";

export type WebSearchVerifyProvider = "brave" | "tavily";

export type WebSearchVerifyAgent =
  | {
      name?: string | null;
      packageRoot?: string;
      web_search?: HarnessWebSearchCapability;
    }
  | null
  | undefined;

export type WebSearchVerifyDeps = {
  runCaptureOpenshell: (
    args: string[],
    options: { ignoreError: true; timeout: number },
  ) => string | null;
  cliName: () => string;
  webSearchEnvFor: (provider: WebSearchVerifyProvider) => string;
  webSearchLabelFor: (provider: WebSearchVerifyProvider) => string;
  log?: (message?: string) => void;
  warn?: (message?: string) => void;
};

export type WebSearchEnvBoundary = "absent" | "placeholder" | "raw-secret" | "unknown";

// Unique marker prefixing the sentinel so the host can extract it even when a
// shell prints unrelated text; the marker cannot appear in incidental output.
const WEB_SEARCH_ENV_BOUNDARY_MARKER = "__nemoclaw_wsenv__";
const WEB_SEARCH_ENV_BOUNDARY_PATTERN = /__nemoclaw_wsenv__:(absent|placeholder|raw-secret)/;
const WEB_SEARCH_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * Shell that classifies a web-search provider's credential env var *inside* the
 * sandbox and prints only a marked sentinel — never the value. This keeps the
 * guard from pulling the very credential it is checking back across the host
 * boundary. The profile-backed provider keeps the key gateway-side and rewrites
 * it at egress, so the sandbox env is unset (`absent`) or carries the
 * `openshell:resolve:env:<NAME>` reference (`placeholder`); a `generic`-typed
 * provider instead injects the plaintext credential (`raw-secret`), which the
 * agent can read and print (#7425).
 */
function buildWebSearchEnvBoundaryScript(envKey: string): string {
  const marker = WEB_SEARCH_ENV_BOUNDARY_MARKER;
  return [
    `v="$(printenv ${envKey} 2>/dev/null || true)"`,
    'case "$v" in',
    `  '') printf '${marker}:absent' ;;`,
    `  openshell:resolve:env:*) printf '${marker}:placeholder' ;;`,
    `  *) printf '${marker}:raw-secret' ;;`,
    "esac",
  ].join("\n");
}

/**
 * Extract the typed boundary state from the marked sentinel. The marker match
 * ignores any surrounding shell noise, so login banners cannot mask a real
 * `raw-secret` result as `absent`. A missing or malformed marker is `unknown`;
 * finalization must not report a security boundary as safe when it could not
 * inspect it.
 */
export function classifyWebSearchEnvBoundary(
  probeOutput: string | null | undefined,
): WebSearchEnvBoundary {
  const match = (probeOutput ?? "").match(WEB_SEARCH_ENV_BOUNDARY_PATTERN);
  return (match?.[1] as WebSearchEnvBoundary) ?? "unknown";
}

/**
 * Runtime secret-boundary guard: assert the live sandbox container env does not
 * expose the web-search provider's raw credential. `openclaw.json` inspection
 * alone misses this — the key leaks through the process environment, not the
 * config file. Classification runs in-sandbox and only a marked sentinel
 * returns, so the raw value never reaches the host. It surfaces a prominent,
 * actionable alert for a raw-secret exposure or an unverifiable result. Returns
 * true for either unsafe state so finalization can refuse a successful handoff.
 */
function checkWebSearchEnvSecretBoundary(
  sandboxName: string,
  provider: WebSearchVerifyProvider,
  deps: WebSearchVerifyDeps,
  warn: (message?: string) => void,
  declaredCredentialEnv?: string,
): boolean {
  const envKey = declaredCredentialEnv ?? deps.webSearchEnvFor(provider);
  let probe: string | null = null;
  try {
    probe = deps.runCaptureOpenshell(
      // `sh -c` (not `-lc`): no login profiles run, so their output cannot
      // contaminate the sentinel the host classifies.
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-c",
        buildWebSearchEnvBoundaryScript(envKey),
      ],
      { ignoreError: true, timeout: 10_000 },
    );
  } catch {
    // The missing sentinel below is handled as an unsafe, unknown boundary.
  }
  const boundary = classifyWebSearchEnvBoundary(probe);
  if (boundary === "absent" || boundary === "placeholder") return false;

  const label = deps.webSearchLabelFor(provider);
  warn("");
  if (boundary === "unknown") {
    warn(`  ✗ SECURITY: could not verify the ${label} credential isolation boundary.`);
    warn(`    The ${envKey} probe inside sandbox '${sandboxName}' returned no valid sentinel, so`);
    warn("    NemoClaw cannot confirm that the agent is unable to read the raw credential.");
    warn("    Retry onboarding after checking sandbox health. If the probe still fails, recreate");
    warn("    the sandbox before using web search:");
    warn(`      ${deps.cliName()} onboard --recreate-sandbox`);
    return true;
  }

  warn(`  ✗ SECURITY: the ${label} credential is exposed in the sandbox environment.`);
  warn(`    ${envKey} holds a raw key inside sandbox '${sandboxName}', so the agent can read and`);
  warn("    print it when asked to list environment variables or API keys.");
  warn("    The credential should stay gateway-side and be resolved only at egress; a raw value");
  warn("    means the provider was attached without the profile-backed rewrite. Recreate the");
  warn("    sandbox to re-attach the profile-backed provider:");
  warn(`      ${deps.cliName()} onboard --recreate-sandbox`);
  return true;
}

function buildBraveEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-G",
    "https://api.search.brave.com/res/v1/web/search",
    "--data-urlencode",
    "q=NVIDIA",
    "--data-urlencode",
    "count=1",
    "-H",
    `X-Subscription-Token: ${apiKey}`,
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function hasBraveResult(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.web?.results) && parsed.web.results.length > 0;
  } catch {
    return false;
  }
}

function buildTavilyEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-X",
    "POST",
    "https://api.tavily.com/search",
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-H",
    "Content-Type: application/json",
    "--data",
    JSON.stringify({ query: "NVIDIA", max_results: 1 }),
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function buildTavilyBodyEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-X",
    "POST",
    "https://api.tavily.com/search",
    "-H",
    "Content-Type: application/json",
    "--data",
    JSON.stringify({ api_key: apiKey, query: "NVIDIA", max_results: 1 }),
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function hasTavilyResult(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.results) && parsed.results.length > 0;
  } catch {
    return false;
  }
}

function readObjectPath(value: unknown, objectPath: readonly string[]): unknown {
  let current = value;
  for (const segment of objectPath) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseDeclaredWebSearchConfig(
  source: string,
  binding: HarnessWebSearchProviderBinding,
): unknown {
  if (binding.config_verification.format === "json") return JSON.parse(source) as unknown;
  const parsed = YAML.parseDocument(source, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) throw new Error("ambiguous YAML");
  return parsed.toJS({ maxAliasCount: 0 }) as unknown;
}

function declaredCredentialPlaceholder(
  config: unknown,
  binding: HarnessWebSearchProviderBinding,
): string | null {
  if (binding.config_verification.credential_paths.length === 0) {
    return `openshell:resolve:env:${binding.credential_env}`;
  }
  for (const objectPath of binding.config_verification.credential_paths) {
    const value = readObjectPath(config, objectPath);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildDeclaredEgressProbeArguments(
  binding: HarnessWebSearchProviderBinding,
  placeholder: string,
): string[] {
  const recipe = binding.egress_verification;
  const args = ["/usr/bin/curl", "-sS", "--compressed", "--max-time", "20"];
  if (recipe.method === "GET") {
    args.push("-G", recipe.url);
    for (const parameter of recipe.parameters) {
      args.push("--data-urlencode", `${parameter.name}=${String(parameter.value)}`);
    }
  } else {
    const body = Object.fromEntries(
      recipe.parameters.map((parameter) => [parameter.name, parameter.value]),
    );
    if (recipe.credential.kind === "json-body") body[recipe.credential.name] = placeholder;
    args.push(
      "-X",
      "POST",
      recipe.url,
      "-H",
      "Content-Type: application/json",
      "--data",
      JSON.stringify(body),
    );
  }
  if (recipe.credential.kind === "header") {
    const prefix = recipe.credential.prefix === "bearer" ? "Bearer " : "";
    args.push("-H", `${recipe.credential.name}: ${prefix}${placeholder}`);
  }
  args.push("-w", "\nHTTP_STATUS:%{http_code}\n");
  return args;
}

function responseContainsDeclaredResults(
  body: string,
  binding: HarnessWebSearchProviderBinding,
): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    const results = readObjectPath(parsed, binding.egress_verification.result_array_path);
    return Array.isArray(results) && results.length > 0;
  } catch {
    return false;
  }
}

function boundedConfigReadArguments(sandboxName: string, configPath: string): string[] {
  const script = [
    'test -f "$1" && test ! -L "$1" || exit 1',
    'resolved="$(readlink -f -- "$1")" || exit 1',
    'test "$resolved" = "$1" || exit 1',
    'size="$(wc -c < "$1")" || exit 1',
    `test "$size" -le ${String(WEB_SEARCH_CONFIG_MAX_BYTES)} || exit 1`,
    'cat -- "$1"',
  ].join("\n");
  return [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    "--",
    "sh",
    "-c",
    script,
    "nemoclaw-web-search-config",
    configPath,
  ];
}

function verifyDeclaredWebSearchInsideSandbox(
  sandboxName: string,
  agent: WebSearchVerifyAgent,
  provider: WebSearchVerifyProvider,
  deps: WebSearchVerifyDeps,
): boolean {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const binding = packageWebSearchProviderBinding(agent, provider);
  if (!binding) {
    warn(`  ✗ The selected harness package does not declare ${deps.webSearchLabelFor(provider)}.`);
    return false;
  }
  try {
    const profile = agent?.packageRoot
      ? resolvePackageCredentialProviderProfile(binding.profile_type, agent.packageRoot)
      : null;
    if (!profile) throw new Error("missing profile");
    assertWebSearchVerificationMatchesProviderProfile(binding, profile);
  } catch {
    warn("  ✗ The selected harness package has an invalid web-search provider boundary.");
    return false;
  }
  if (checkWebSearchEnvSecretBoundary(sandboxName, provider, deps, warn, binding.credential_env)) {
    return false;
  }

  try {
    const configText = deps.runCaptureOpenshell(
      boundedConfigReadArguments(sandboxName, binding.config_verification.path),
      { ignoreError: true, timeout: 10_000 },
    );
    const providerLabel = deps.webSearchLabelFor(provider);
    if (!configText) {
      warn(`  ⚠ Could not read harness config to verify ${providerLabel}.`);
      return true;
    }
    let config: unknown;
    try {
      config = parseDeclaredWebSearchConfig(configText, binding);
    } catch {
      warn(`  ⚠ Could not parse harness config to verify ${providerLabel}.`);
      return true;
    }
    const failedAssertion = binding.config_verification.assertions.find(
      (assertion) => readObjectPath(config, assertion.path) !== assertion.equals,
    );
    if (failedAssertion) {
      warn(`  ⚠ ${providerLabel} was configured, but its declared config assertion did not match.`);
      return true;
    }
    const placeholder = declaredCredentialPlaceholder(config, binding);
    const expectedPlaceholder = `openshell:resolve:env:${binding.credential_env}`;
    if (placeholder !== expectedPlaceholder) {
      warn(`  ⚠ ${providerLabel} config does not contain its declared OpenShell placeholder.`);
      return true;
    }
    const probe = deps.runCaptureOpenshell(
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        ...buildDeclaredEgressProbeArguments(binding, placeholder),
      ],
      { ignoreError: true, timeout: 30_000 },
    );
    if (!probe) {
      warn(`  ⚠ ${providerLabel} config exists, but the egress verification request failed.`);
      return true;
    }
    const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
    const status = statusMatch?.[1] ?? "unknown";
    const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
    if (status === "200" && responseContainsDeclaredResults(body, binding)) {
      log(`  ✓ ${providerLabel} egress verified inside sandbox`);
    } else {
      warn(`  ⚠ ${providerLabel} config exists, but egress verification returned HTTP ${status}.`);
    }
  } catch {
    warn("  ⚠ Web search verification probe failed (non-fatal).");
  }
  return true;
}

/**
 * Post-creation probe: verify web search is actually functional inside the
 * sandbox. Hermes silently ignores unknown web.backend values, so config
 * inspection is paired with a real egress request.
 *
 * For Hermes: checks the configured Tavily backend, then proves body credential
 * rewriting and egress with a real search request.
 * For OpenClaw: checks the tools.web.search block, then proves provider egress.
 *
 * Configuration and egress failures remain best-effort warnings. A confirmed
 * raw credential or an unverifiable isolation result returns false so onboarding
 * cannot report the sandbox as ready.
 */
export function verifyWebSearchInsideSandbox(
  sandboxName: string,
  agent: WebSearchVerifyAgent,
  provider: WebSearchVerifyProvider,
  deps: WebSearchVerifyDeps,
  receiptBackedPackage = false,
): boolean {
  if (receiptBackedPackage) {
    return verifyDeclaredWebSearchInsideSandbox(sandboxName, agent, provider, deps);
  }
  // Explicit compatibility for sandboxes created before package receipts.
  // Receipt-backed packages return above and never enter these ID branches.
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const agentName = agent?.name || "openclaw";
  if (checkWebSearchEnvSecretBoundary(sandboxName, provider, deps, warn)) return false;

  try {
    if (agentName === "hermes") {
      // Hermes v2026.6.19 `dump` does not expose web.backend. Inspect the
      // generated config directly, then prove that the configured body
      // placeholder is rewritten on a real request.
      const configText = deps.runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "cat", "/sandbox/.hermes/config.yaml"],
        {
          ignoreError: true,
          timeout: 10_000,
        },
      );
      if (!configText) {
        warn("  ⚠ Could not read Hermes config to verify Tavily Search.");
        return true;
      }
      let config: { web?: { backend?: unknown } };
      try {
        config = YAML.parse(configText) as { web?: { backend?: unknown } };
      } catch {
        warn("  ⚠ Could not parse Hermes config to verify Tavily Search.");
        return true;
      }
      if (config?.web?.backend !== "tavily") {
        warn(
          "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
        );
        warn("    The agent may not have accepted the web search configuration.");
        warn(
          `    Check: ${deps.cliName()} ${sandboxName} exec -- cat /sandbox/.hermes/config.yaml`,
        );
        return true;
      }

      const placeholder = "openshell:resolve:env:TAVILY_API_KEY";
      const probe = deps.runCaptureOpenshell(
        [
          "sandbox",
          "exec",
          "-n",
          sandboxName,
          "--",
          "sh",
          "-lc",
          buildTavilyBodyEgressProbeCommand(placeholder),
        ],
        { ignoreError: true, timeout: 30_000 },
      );
      if (!probe) {
        warn("  ⚠ Tavily Search config exists, but the egress verification request failed.");
        return true;
      }
      const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
      const status = statusMatch?.[1] || "unknown";
      const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
      if (status === "200" && hasTavilyResult(body)) {
        log("  ✓ Tavily Search egress verified inside sandbox");
      } else {
        warn(`  ⚠ Tavily Search config exists, but egress verification returned HTTP ${status}.`);
      }
    } else if (agentName === "openclaw") {
      // OpenClaw: verify tools.web.search exists, then prove the selected
      // provider placeholder works at egress through its credential header.
      const configCheck = deps.runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "cat", "/sandbox/.openclaw/openclaw.json"],
        { ignoreError: true, timeout: 10_000 },
      );
      if (!configCheck) {
        warn("  ⚠ Could not verify web search config inside sandbox.");
        return true;
      }
      try {
        const parsed = JSON.parse(configCheck);
        const search = parsed?.tools?.web?.search;
        if (!search?.enabled) {
          warn(
            "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
          );
          return true;
        }
        const provider = search.provider;
        if (provider !== "brave" && provider !== "tavily") {
          warn(`  ⚠ Web search provider '${String(provider)}' cannot be verified.`);
          return true;
        }
        const providerLabel = provider === "tavily" ? "Tavily Search" : "Brave Search";
        // Current OpenClaw schema keeps the provider-owned apiKey under
        // plugins.entries.<provider>.config.webSearch; older configs carried
        // it inline on tools.web.search. Accept both so the probe keeps
        // working across schema generations.
        const pluginApiKey = parsed?.plugins?.entries?.[search.provider]?.config?.webSearch?.apiKey;
        const apiKey = typeof pluginApiKey === "string" ? pluginApiKey : search.apiKey;
        if (typeof apiKey !== "string" || apiKey.trim() === "") {
          warn(`  ⚠ ${providerLabel} is enabled but openclaw.json has no API key placeholder.`);
          return true;
        }
        // Refuse to interpolate raw secrets into the curl argv. The probe
        // only proves the L7 proxy rewrites a placeholder, so a literal key
        // would expose itself in host/sandbox process listings without
        // testing the thing we care about.
        if (!/^openshell:resolve:env:[A-Za-z0-9_]+$/.test(apiKey.trim())) {
          warn(
            `  ⚠ ${providerLabel} apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.`,
          );
          return true;
        }
        const probeCommand =
          provider === "tavily"
            ? buildTavilyEgressProbeCommand(apiKey)
            : buildBraveEgressProbeCommand(apiKey);
        const probe = deps.runCaptureOpenshell(
          ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", probeCommand],
          { ignoreError: true, timeout: 30_000 },
        );
        if (!probe) {
          warn(`  ⚠ ${providerLabel} config exists, but the egress verification request failed.`);
          return true;
        }
        const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
        const status = statusMatch?.[1] || "unknown";
        const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
        const hasResult = provider === "tavily" ? hasTavilyResult(body) : hasBraveResult(body);
        if (status === "200" && hasResult) {
          log(`  ✓ ${providerLabel} egress verified inside sandbox`);
        } else {
          warn(
            `  ⚠ ${providerLabel} config exists, but egress verification returned HTTP ${status}.`,
          );
          if (provider === "brave" && (status === "401" || status === "403")) {
            // A 401/403 with the placeholder in the request typically means
            // the L7 proxy did not rewrite X-Subscription-Token. The most
            // common cause is a legacy `${sandbox}-brave-search` provider
            // still registered with the pre-fix `generic` type — `provider
            // update` cannot change the type, so a recreate is required.
            warn(
              `    Re-run onboarding with --recreate-sandbox to migrate the Brave provider to the new profile.`,
            );
          }
        }
      } catch {
        warn("  ⚠ Could not parse openclaw.json to verify web search config.");
      }
    } else {
      warn(`  ⚠ Web search verification is not implemented for agent '${agentName}'.`);
    }
  } catch {
    // Best-effort — don't let probe failures derail onboarding.
    warn("  ⚠ Web search verification probe failed (non-fatal).");
  }
  return true;
}
