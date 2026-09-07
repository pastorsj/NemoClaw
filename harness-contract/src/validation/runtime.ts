// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fail,
  isCanonicalAbsolutePath,
  isImmutableSandboxCommandPath,
  type ManifestRecord,
  requireKnownFields,
  requireRecord,
  requireString,
} from "./shared.js";

function validatePublicEnvironment(value: unknown, field: string): void {
  if (value === undefined) return;
  const environment = requireRecord(value, field);
  const namePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
  const secretPattern = /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u;
  const coreNames = new Set([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
  for (const [name, rawValue] of Object.entries(environment)) {
    if (!namePattern.test(name)) {
      fail(`${field}.${name}`, "must use an uppercase environment name");
    }
    if (
      name.startsWith("NEMOCLAW_") ||
      name.startsWith("OPENSHELL_") ||
      coreNames.has(name) ||
      secretPattern.test(name)
    ) {
      fail(`${field}.${name}`, "cannot replace a core-owned or credential environment value");
    }
    if (
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > 4096 ||
      /[\u0000\r\n]/u.test(rawValue)
    ) {
      fail(`${field}.${name}`, "must be a non-empty single-line string of at most 4096 characters");
    }
  }
}

function validateAbsolutePath(value: unknown, field: string): void {
  const candidate = requireString(value, field);
  if (
    candidate.length > 4096 ||
    /[\u0000\r\n]/u.test(candidate) ||
    !isCanonicalAbsolutePath(candidate)
  ) {
    fail(field, "must be a canonical absolute path");
  }
}

function validateAgentCommand(value: unknown): void {
  if (value === undefined) return;
  const field = "runtime.agent_command";
  const declaration = requireRecord(value, field);
  requireKnownFields(
    declaration,
    new Set([
      "argv",
      "output_mode",
      "output_interpretation",
      "selector_options",
      "selector_required",
      "value_options",
      "boolean_options",
      "json_output_option",
      "timeout_option",
    ]),
    new Set(["argv", "output_mode"]),
    field,
  );
  if (
    !Array.isArray(declaration.argv) ||
    declaration.argv.length === 0 ||
    declaration.argv.length > 64 ||
    declaration.argv.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 1024 ||
        /[\u0000\r\n]/u.test(argument),
    ) ||
    new Set(declaration.argv).size !== declaration.argv.length
  ) {
    fail(`${field}.argv`, "must be a non-empty bounded argument array");
  }
  if (declaration.output_mode !== "direct" && declaration.output_mode !== "bounded-text") {
    fail(`${field}.output_mode`, "must be direct or bounded-text");
  }
  if (
    declaration.output_interpretation !== undefined &&
    (declaration.output_interpretation !== "structured-turn-envelope" ||
      declaration.output_mode !== "bounded-text")
  ) {
    fail(
      `${field}.output_interpretation`,
      "must be structured-turn-envelope with output_mode bounded-text",
    );
  }

  const optionPattern = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/u;
  const optionsByField = new Map<string, readonly string[]>();
  for (const key of ["selector_options", "value_options", "boolean_options"] as const) {
    const rawOptions = declaration[key];
    if (rawOptions === undefined) {
      optionsByField.set(key, []);
      continue;
    }
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length === 0 ||
      rawOptions.length > 64 ||
      new Set(rawOptions).size !== rawOptions.length ||
      rawOptions.some((option) => typeof option !== "string" || !optionPattern.test(option))
    ) {
      fail(`${field}.${key}`, "must be a unique bounded list of canonical options");
    }
    optionsByField.set(key, rawOptions as readonly string[]);
  }
  const allOptions = [
    ...optionsByField.values(),
    ...(typeof declaration.json_output_option === "string"
      ? [[declaration.json_output_option]]
      : []),
  ].flat();
  if (new Set(allOptions).size !== allOptions.length) {
    fail(field, "must not declare one option in more than one option group");
  }
  if (
    declaration.selector_required !== undefined &&
    typeof declaration.selector_required !== "boolean"
  ) {
    fail(`${field}.selector_required`, "must be a boolean");
  }
  if (
    declaration.selector_required === true &&
    optionsByField.get("selector_options")?.length === 0
  ) {
    fail(`${field}.selector_required`, "requires at least one selector option");
  }
  for (const key of ["json_output_option", "timeout_option"] as const) {
    if (
      declaration[key] !== undefined &&
      (typeof declaration[key] !== "string" || !optionPattern.test(declaration[key]))
    ) {
      fail(`${field}.${key}`, "must be a canonical option");
    }
  }
  if (declaration.json_output_option !== undefined && declaration.output_mode !== "bounded-text") {
    fail(`${field}.json_output_option`, "requires output_mode bounded-text");
  }
  if (
    declaration.timeout_option !== undefined &&
    !optionsByField.get("value_options")?.includes(declaration.timeout_option as string)
  ) {
    fail(`${field}.timeout_option`, "must also be declared in value_options");
  }
}

function validateProcessLifecycle(value: unknown): void {
  if (value === undefined) return;
  const field = "runtime.process_lifecycle";
  const declaration = requireRecord(value, field);
  if (declaration.support === "managed") {
    requireKnownFields(
      declaration,
      new Set(["support", "command", "revalidate_running_gateway"]),
      new Set(["support", "command"]),
      field,
    );
    if (
      !Array.isArray(declaration.command) ||
      declaration.command.length === 0 ||
      declaration.command.length > 16 ||
      declaration.command.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.length > 1024 ||
          /[\u0000\r\n]/u.test(argument),
      )
    ) {
      fail(`${field}.command`, "must be a non-empty bounded argument array");
    }
    const executable = requireString(declaration.command[0], `${field}.command[0]`);
    if (!isImmutableSandboxCommandPath(executable)) {
      fail(`${field}.command[0]`, "must be an immutable image-owned executable path");
    }
    if (
      declaration.revalidate_running_gateway !== undefined &&
      declaration.revalidate_running_gateway !== true
    ) {
      fail(`${field}.revalidate_running_gateway`, "must be true when present");
    }
    return;
  }
  if (declaration.support === "unsupported") {
    requireKnownFields(
      declaration,
      new Set(["support", "reason"]),
      new Set(["support", "reason"]),
      field,
    );
    if (
      typeof declaration.reason !== "string" ||
      declaration.reason.length === 0 ||
      declaration.reason.length > 512 ||
      /[\u0000\r\n]/u.test(declaration.reason)
    ) {
      fail(`${field}.reason`, "must be a non-empty single-line string of at most 512 characters");
    }
    return;
  }
  fail(`${field}.support`, "must be managed or unsupported");
}

function validateBoundedRuntimeCommand(value: unknown, field: string): void {
  if (value === undefined) return;
  const declaration = requireRecord(value, field);
  requireKnownFields(
    declaration,
    new Set(["command", "timeout_seconds"]),
    new Set(["command", "timeout_seconds"]),
    field,
  );
  if (
    !Array.isArray(declaration.command) ||
    declaration.command.length === 0 ||
    declaration.command.length > 16 ||
    declaration.command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 1024 ||
        /[\u0000\r\n]/u.test(argument),
    )
  ) {
    fail(`${field}.command`, "must be a non-empty bounded argument array");
  }
  validateAbsolutePath(declaration.command[0], `${field}.command[0]`);
  if (
    !Number.isInteger(declaration.timeout_seconds) ||
    (declaration.timeout_seconds as number) < 1 ||
    (declaration.timeout_seconds as number) > 300
  ) {
    fail(`${field}.timeout_seconds`, "must be an integer from 1 through 300");
  }
}

function validateSemanticTurn(value: unknown): void {
  if (value === undefined) return;
  const field = "runtime.semantic_turn";
  const declaration = requireRecord(value, field);
  if (declaration.support === "managed") {
    requireKnownFields(
      declaration,
      new Set(["command", "protocol", "support", "timeout_seconds"]),
      new Set(["command", "protocol", "support", "timeout_seconds"]),
      field,
    );
    if (declaration.protocol !== "semantic-turn-ndjson") {
      fail(`${field}.protocol`, "must be semantic-turn-ndjson");
    }
    validateBoundedRuntimeCommand(
      { command: declaration.command, timeout_seconds: declaration.timeout_seconds },
      field,
    );
    const command = declaration.command as readonly string[];
    if (!isImmutableSandboxCommandPath(command[0] as string)) {
      fail(`${field}.command[0]`, "must be an immutable image-owned executable path");
    }
    return;
  }
  if (declaration.support === "unsupported") {
    requireKnownFields(
      declaration,
      new Set(["reason", "support"]),
      new Set(["reason", "support"]),
      field,
    );
    if (
      typeof declaration.reason !== "string" ||
      declaration.reason.length === 0 ||
      declaration.reason.length > 512 ||
      /[\u0000\r\n]/u.test(declaration.reason)
    ) {
      fail(`${field}.reason`, "must be a non-empty single-line string of at most 512 characters");
    }
    return;
  }
  fail(`${field}.support`, "must be managed or unsupported");
}

/** Validate process entry points, public environment, smoke, and command dispatch. */
export function validateHarnessRuntime(manifest: ManifestRecord): void {
  const runtime = requireRecord(manifest.runtime, "runtime");
  requireKnownFields(
    runtime,
    new Set([
      "agent_command",
      "command_shell",
      "device_pairing_settlement",
      "gateway_log_path",
      "headless_command",
      "headless_environment",
      "interactive_command",
      "kind",
      "process_lifecycle",
      "prompt_transport",
      "prompt_protocol",
      "selection_qualification",
      "semantic_turn",
      "session_qualification",
      "smoke_boundary",
      "smoke_commands",
      "startup_environment",
    ]),
    new Set(["kind"]),
    "runtime",
  );
  const kind = runtime.kind;
  if (kind !== "gateway" && kind !== "terminal") {
    fail("runtime.kind", "must be gateway or terminal");
  }
  if (runtime.gateway_log_path !== undefined) {
    if (kind !== "gateway") {
      fail("runtime.gateway_log_path", "requires runtime.kind gateway");
    }
    validateAbsolutePath(runtime.gateway_log_path, "runtime.gateway_log_path");
  }

  for (const key of ["interactive_command", "headless_command"] as const) {
    if (runtime[key] !== undefined && typeof runtime[key] !== "string") {
      fail(`runtime.${key}`, "must be a string");
    }
  }
  const interactiveCommand =
    typeof runtime.interactive_command === "string" ? runtime.interactive_command.trim() : "";
  const headlessCommand =
    typeof runtime.headless_command === "string" ? runtime.headless_command.trim() : "";
  if (kind === "gateway") {
    const gatewayCommand =
      typeof manifest.gateway_command === "string" ? manifest.gateway_command.trim() : "";
    if (!gatewayCommand || gatewayCommand.length > 4096 || /[\u0000\r\n]/u.test(gatewayCommand)) {
      fail(
        "gateway_command",
        "must be a non-empty bounded single-line command for gateway runtimes",
      );
    }
    if (manifest.health_probe === undefined) {
      fail("health_probe", "is required for gateway runtimes");
    }
    if (runtime.process_lifecycle === undefined) {
      fail(
        "runtime.process_lifecycle",
        "must explicitly declare managed or unsupported support for gateway runtimes",
      );
    }
  }
  if (!interactiveCommand && !headlessCommand) {
    fail("runtime", "must define interactive_command or headless_command for every harness");
  }
  if (
    runtime.command_shell !== undefined &&
    runtime.command_shell !== "/bin/sh" &&
    runtime.command_shell !== "/bin/bash"
  ) {
    fail("runtime.command_shell", "must be /bin/sh or /bin/bash");
  }
  if (
    runtime.prompt_transport !== undefined &&
    runtime.prompt_transport !== "argv" &&
    runtime.prompt_transport !== "stdin"
  ) {
    fail("runtime.prompt_transport", "must be argv or stdin");
  }
  if (runtime.prompt_transport !== undefined && !headlessCommand) {
    fail("runtime.prompt_transport", "requires runtime.headless_command");
  }
  if (
    runtime.prompt_protocol !== undefined &&
    runtime.prompt_protocol !== "fabric-cli" &&
    runtime.prompt_protocol !== "raw-stdin"
  ) {
    fail("runtime.prompt_protocol", "must be fabric-cli or raw-stdin");
  }
  if (runtime.prompt_protocol !== undefined && runtime.prompt_transport !== "stdin") {
    fail("runtime.prompt_protocol", "requires runtime.prompt_transport to be stdin");
  }
  if (runtime.headless_environment !== undefined && !headlessCommand) {
    fail("runtime.headless_environment", "requires runtime.headless_command");
  }
  validatePublicEnvironment(runtime.startup_environment, "runtime.startup_environment");
  validatePublicEnvironment(runtime.headless_environment, "runtime.headless_environment");

  if (
    runtime.smoke_commands !== undefined &&
    (!Array.isArray(runtime.smoke_commands) ||
      runtime.smoke_commands.some((entry) => typeof entry !== "string"))
  ) {
    fail("runtime.smoke_commands", "must be an array of strings");
  }
  if (runtime.smoke_boundary !== undefined) {
    const boundary = requireRecord(runtime.smoke_boundary, "runtime.smoke_boundary");
    if (boundary.kind === "login-shell") {
      requireKnownFields(boundary, new Set(["kind"]), new Set(["kind"]), "runtime.smoke_boundary");
    } else if (boundary.kind === "managed-launcher") {
      requireKnownFields(
        boundary,
        new Set(["home", "kind", "launcher"]),
        new Set(["home", "kind", "launcher"]),
        "runtime.smoke_boundary",
      );
      validateAbsolutePath(boundary.launcher, "runtime.smoke_boundary.launcher");
      validateAbsolutePath(boundary.home, "runtime.smoke_boundary.home");
    } else {
      fail("runtime.smoke_boundary.kind", "must be login-shell or managed-launcher");
    }
  }
  validateAgentCommand(runtime.agent_command);
  validateProcessLifecycle(runtime.process_lifecycle);
  validateBoundedRuntimeCommand(
    runtime.device_pairing_settlement,
    "runtime.device_pairing_settlement",
  );
  validateBoundedRuntimeCommand(runtime.selection_qualification, "runtime.selection_qualification");
  validateBoundedRuntimeCommand(runtime.session_qualification, "runtime.session_qualification");
  validateSemanticTurn(runtime.semantic_turn);
  if (
    manifest.device_pairing === true &&
    (runtime.device_pairing_settlement === undefined || runtime.session_qualification === undefined)
  ) {
    fail(
      "runtime",
      "device_pairing_settlement and session_qualification are required when device_pairing is enabled",
    );
  }
  if (manifest.device_pairing === true && kind !== "gateway") {
    fail("device_pairing", "requires a gateway runtime");
  }
  if (
    manifest.device_pairing !== true &&
    (runtime.device_pairing_settlement !== undefined || runtime.session_qualification !== undefined)
  ) {
    fail(
      "runtime",
      "device_pairing_settlement and session_qualification require device_pairing to be enabled",
    );
  }
  if (runtime.session_qualification !== undefined && manifest.managed_image === undefined) {
    fail("runtime.session_qualification", "requires managed_image runtime identity authority");
  }
  if (runtime.selection_qualification !== undefined && manifest.managed_image === undefined) {
    fail("runtime.selection_qualification", "requires managed_image runtime identity authority");
  }
  if (
    runtime.semantic_turn !== undefined &&
    requireRecord(runtime.semantic_turn, "runtime.semantic_turn").support === "managed" &&
    manifest.managed_image === undefined
  ) {
    fail("runtime.semantic_turn", "requires managed_image runtime identity authority");
  }
  if (
    kind === "terminal" &&
    requireRecord(runtime.process_lifecycle ?? {}, "runtime.process_lifecycle").support ===
      "managed"
  ) {
    fail("runtime.process_lifecycle", "cannot be managed for a terminal runtime");
  }
}

/** Validate ports, probes, dashboards, and web authentication metadata. */
export function validateRuntimeSurfaces(manifest: ManifestRecord): void {
  if (manifest.forward_ports !== undefined) {
    if (!Array.isArray(manifest.forward_ports)) {
      fail("forward_ports", "must be an array of TCP ports");
    }
    manifest.forward_ports.forEach((entry, index) => {
      if (!Number.isInteger(entry) || (entry as number) < 1024 || (entry as number) > 65_535) {
        fail(
          `forward_ports[${String(index)}]`,
          "must be an integer TCP port between 1024 and 65535",
        );
      }
    });
  }
  if (manifest.health_probe !== undefined) {
    const probe = requireRecord(manifest.health_probe, "health_probe");
    requireKnownFields(
      probe,
      new Set([
        "port",
        "port_resolution",
        "secondary_forward",
        "success_statuses",
        "timeout_seconds",
        "url",
      ]),
      new Set(["port", "timeout_seconds", "url"]),
      "health_probe",
    );
    if (
      probe.port_resolution !== undefined &&
      probe.port_resolution !== "sandbox-secondary-forward"
    ) {
      fail("health_probe.port_resolution", "must be sandbox-secondary-forward");
    }
    if (probe.port_resolution === "sandbox-secondary-forward") {
      const allocation = requireRecord(probe.secondary_forward, "health_probe.secondary_forward");
      requireKnownFields(
        allocation,
        new Set([
          "environment_variable",
          "label",
          "preferred_port",
          "range_end",
          "range_start",
          "remedy",
        ]),
        new Set([
          "environment_variable",
          "label",
          "preferred_port",
          "range_end",
          "range_start",
          "remedy",
        ]),
        "health_probe.secondary_forward",
      );
      const environmentVariable = requireString(
        allocation.environment_variable,
        "health_probe.secondary_forward.environment_variable",
      );
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(environmentVariable) ||
        !environmentVariable.endsWith("_PORT") ||
        /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u.test(environmentVariable) ||
        new Set(["NEMOCLAW_DASHBOARD_PORT", "NEMOCLAW_GATEWAY_PORT", "NEMOCLAW_PROXY_PORT"]).has(
          environmentVariable,
        )
      ) {
        fail(
          "health_probe.secondary_forward.environment_variable",
          "must be a non-credential uppercase port name that does not replace a core-owned port",
        );
      }
      const preferredPort = allocation.preferred_port;
      const rangeStart = allocation.range_start;
      const rangeEnd = allocation.range_end;
      for (const [field, value] of [
        ["preferred_port", preferredPort],
        ["range_start", rangeStart],
        ["range_end", rangeEnd],
      ] as const) {
        if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65_535) {
          fail(
            `health_probe.secondary_forward.${field}`,
            "must be an integer TCP port between 1024 and 65535",
          );
        }
      }
      if ((rangeStart as number) > (rangeEnd as number)) {
        fail("health_probe.secondary_forward.range_end", "must not be below range_start");
      }
      if ((rangeEnd as number) - (rangeStart as number) + 1 > 256) {
        fail("health_probe.secondary_forward", "must declare at most 256 candidate ports");
      }
      if (
        (preferredPort as number) < (rangeStart as number) ||
        (preferredPort as number) > (rangeEnd as number)
      ) {
        fail("health_probe.secondary_forward.preferred_port", "must be inside the declared range");
      }
      if (preferredPort !== probe.port) {
        fail("health_probe.secondary_forward.preferred_port", "must match health_probe.port");
      }
      for (const [field, maximum] of [
        ["label", 128],
        ["remedy", 512],
      ] as const) {
        const text = requireString(allocation[field], `health_probe.secondary_forward.${field}`);
        if (text.length === 0 || text.length > maximum || /[\u0000\r\n]/u.test(text)) {
          fail(
            `health_probe.secondary_forward.${field}`,
            `must be a non-empty single-line string of at most ${String(maximum)} characters`,
          );
        }
      }
      const forwardPorts = manifest.forward_ports;
      if (
        !Array.isArray(forwardPorts) ||
        forwardPorts.length < 2 ||
        forwardPorts[0] === probe.port ||
        !forwardPorts.includes(probe.port)
      ) {
        fail(
          "health_probe.port_resolution",
          "requires health_probe.port to be a non-primary forward_ports entry",
        );
      }
    } else if (probe.secondary_forward !== undefined) {
      fail(
        "health_probe.secondary_forward",
        "requires health_probe.port_resolution to be sandbox-secondary-forward",
      );
    }
    const url = requireString(probe.url, "health_probe.url");
    if (url.length === 0 || url.length > 4096 || /[\u0000\r\n]/u.test(url)) {
      fail("health_probe.url", "must be a non-empty single-line string of at most 4096 characters");
    }
    if (
      !Number.isInteger(probe.port) ||
      (probe.port as number) < 1 ||
      (probe.port as number) > 65_535
    ) {
      fail("health_probe.port", "must be an integer TCP port between 1 and 65535");
    }
    if (
      !Number.isInteger(probe.timeout_seconds) ||
      (probe.timeout_seconds as number) < 1 ||
      (probe.timeout_seconds as number) > 3600
    ) {
      fail("health_probe.timeout_seconds", "must be an integer from 1 through 3600");
    }
    if (probe.success_statuses !== undefined) {
      if (
        !Array.isArray(probe.success_statuses) ||
        probe.success_statuses.length === 0 ||
        probe.success_statuses.length > 16 ||
        probe.success_statuses.some(
          (status) =>
            !Number.isInteger(status) || (status as number) < 100 || (status as number) > 599,
        ) ||
        new Set(probe.success_statuses).size !== probe.success_statuses.length
      ) {
        fail(
          "health_probe.success_statuses",
          "must contain 1 through 16 unique integer HTTP statuses from 100 through 599",
        );
      }
    }
  }
  if (manifest.dashboard !== undefined) {
    const dashboard = requireRecord(manifest.dashboard, "dashboard");
    requireKnownFields(
      dashboard,
      new Set([
        "auth",
        "health_path",
        "kind",
        "label",
        "path",
        "token_path",
        "tunnel_allowed_origins_path",
      ]),
      new Set(),
      "dashboard",
    );
    if (dashboard.kind !== undefined && dashboard.kind !== "ui" && dashboard.kind !== "api") {
      fail("dashboard.kind", "must be ui or api");
    }
    if (dashboard.label !== undefined && typeof dashboard.label !== "string") {
      fail("dashboard.label", "must be a string");
    }
    for (const key of ["path", "health_path"] as const) {
      if (
        dashboard[key] !== undefined &&
        (typeof dashboard[key] !== "string" || !dashboard[key].startsWith("/"))
      ) {
        fail(`dashboard.${key}`, "must be an absolute path");
      }
    }
    if (
      dashboard.auth !== undefined &&
      dashboard.auth !== "url_token" &&
      dashboard.auth !== "session" &&
      dashboard.auth !== "none"
    ) {
      fail("dashboard.auth", "must be url_token, session, or none");
    }
    if (dashboard.token_path !== undefined) {
      const tokenPath = requireString(dashboard.token_path, "dashboard.token_path").split(".");
      if (
        tokenPath.length === 0 ||
        tokenPath.length > 16 ||
        tokenPath.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment.trim()))
      ) {
        fail("dashboard.token_path", "must be a safe dotted config path");
      }
    }
    if (dashboard.tunnel_allowed_origins_path !== undefined) {
      const originsPath = requireString(
        dashboard.tunnel_allowed_origins_path,
        "dashboard.tunnel_allowed_origins_path",
      ).split(".");
      if (
        originsPath.length === 0 ||
        originsPath.length > 16 ||
        originsPath.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment.trim()))
      ) {
        fail("dashboard.tunnel_allowed_origins_path", "must be a safe dotted config path");
      }
    }
  }
  if (
    manifest.web_auth_method === "bearer_token" &&
    (typeof manifest.web_auth_env !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(manifest.web_auth_env))
  ) {
    fail("web_auth_env", "is required and must be a valid environment name for bearer_token");
  }
  if (
    manifest.web_auth_env !== undefined &&
    (typeof manifest.web_auth_env !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(manifest.web_auth_env))
  ) {
    fail("web_auth_env", "must be a valid environment name");
  }
  if (manifest.dashboard_ui !== undefined) {
    const dashboard = requireRecord(manifest.dashboard_ui, "dashboard_ui");
    requireKnownFields(
      dashboard,
      new Set([
        "enable_env",
        "internal_port",
        "internal_port_env",
        "label",
        "path",
        "port",
        "port_env",
        "tui_env",
      ]),
      new Set(["enable_env", "internal_port", "internal_port_env", "port", "port_env"]),
      "dashboard_ui",
    );
    for (const key of ["port", "internal_port"] as const) {
      if (
        !Number.isInteger(dashboard[key]) ||
        (dashboard[key] as number) < 1024 ||
        (dashboard[key] as number) > 65_535
      ) {
        fail(`dashboard_ui.${key}`, "must be an integer TCP port between 1024 and 65535");
      }
    }
    if (dashboard.port === dashboard.internal_port) {
      fail("dashboard_ui.internal_port", "must differ from the public port");
    }
    const environmentNames: string[] = [];
    for (const key of ["enable_env", "port_env", "internal_port_env", "tui_env"] as const) {
      const value = dashboard[key];
      if (value === undefined && key === "tui_env") continue;
      if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
        fail(`dashboard_ui.${key}`, "must be a canonical uppercase environment name");
      }
      if (/(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u.test(value)) {
        fail(`dashboard_ui.${key}`, "must not be credential-shaped");
      }
      environmentNames.push(value);
    }
    if (new Set(environmentNames).size !== environmentNames.length) {
      fail("dashboard_ui", "must use a different environment name for each setting");
    }
    if (
      dashboard.label !== undefined &&
      (typeof dashboard.label !== "string" ||
        dashboard.label.trim().length === 0 ||
        dashboard.label.length > 80 ||
        /[\u0000\r\n]/u.test(dashboard.label))
    ) {
      fail("dashboard_ui.label", "must be a non-empty single-line string of at most 80 characters");
    }
    if (
      dashboard.path !== undefined &&
      (typeof dashboard.path !== "string" ||
        !dashboard.path.startsWith("/") ||
        dashboard.path.length > 1024 ||
        /[\u0000\r\n?#]/u.test(dashboard.path))
    ) {
      fail(
        "dashboard_ui.path",
        "must be a bounded absolute browser path without a query or fragment",
      );
    }
  }
}
