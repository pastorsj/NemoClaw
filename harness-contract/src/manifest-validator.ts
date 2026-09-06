// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessAgentManifest } from "./manifest.js";
import { validateHarnessCapabilities } from "./validation/capabilities.js";
import { validateHarnessConfig } from "./validation/config.js";
import { validateHarnessIdentity } from "./validation/identity.js";
import { validateManagedImage } from "./validation/managed-image.js";
import { validateHarnessRuntime, validateRuntimeSurfaces } from "./validation/runtime.js";
import { validateHarnessSandboxCreate } from "./validation/sandbox-create.js";
import { fail, isRecord, requireKnownFields, requireRecord } from "./validation/shared.js";
import { validateHarnessState } from "./validation/state.js";

export { HarnessManifestValidationError } from "./validation/shared.js";

/**
 * Validate every package-owned, data-only manifest field consumed by NemoClaw.
 * Filesystem containment, package receipts, and executable adapter bytes remain
 * the authority of the caller.
 */
export function validateHarnessManifest(
  value: unknown,
  expectedHarnessId?: string,
): HarnessAgentManifest {
  const manifest = requireRecord(value, "<root>");
  requireKnownFields(
    manifest,
    new Set([
      "alias_summary",
      "aliases",
      "binary_path",
      "config",
      "dashboard",
      "dashboard_ui",
      "description",
      "device_pairing",
      "display_name",
      "expected_version",
      "forward_ports",
      "gateway_command",
      "health_probe",
      "homepage",
      "inference",
      "install_method",
      "language",
      "license",
      "managed_image",
      "mcp",
      "messaging",
      "name",
      "onboarding",
      "package_registry",
      "phone_home_hosts",
      "provider_broker",
      "runtime",
      "sandbox_create",
      "sessions",
      "skills",
      "state_dirs",
      "state_files",
      "state_lifecycle",
      "user_managed_files",
      "version_command",
      "version_constraint",
      "version_scheme",
      "web_search",
      "web_auth_env",
      "web_auth_method",
    ]),
    new Set(["config", "inference", "messaging", "name", "runtime", "state_lifecycle"]),
    "<root>",
  );
  validateHarnessIdentity(manifest, expectedHarnessId);
  if (manifest.config === undefined) fail("config", "is required for a harness package");
  if (manifest.inference === undefined) fail("inference", "is required for a harness package");
  if (!isRecord(manifest.inference) || manifest.inference.config_update === undefined) {
    fail("inference.config_update", "is required for a harness package");
  }
  if (manifest.messaging === undefined) fail("messaging", "is required for a harness package");

  validateHarnessRuntime(manifest);
  validateRuntimeSurfaces(manifest);
  validateHarnessSandboxCreate(manifest);
  validateManagedImage(manifest);
  validateHarnessConfig(manifest);
  validateHarnessCapabilities(manifest);
  validateHarnessState(manifest);
  return manifest as unknown as HarnessAgentManifest;
}
