// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Installed Hermes packages cannot import NemoClaw source. Keep the two name
// rules that cross the private broker boundary beside the broker itself.
const SANDBOX_NAME_MAX_LENGTH = 19;
const PROVIDER_NAME_MAX_LENGTH = 128;
const SANDBOX_NAME_PATTERN = /^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/u;
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function isValidSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SANDBOX_NAME_MAX_LENGTH &&
    SANDBOX_NAME_PATTERN.test(value)
  );
}

function isValidProviderName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROVIDER_NAME_MAX_LENGTH &&
    PROVIDER_NAME_PATTERN.test(value)
  );
}

module.exports = {
  isValidProviderName,
  isValidSandboxName,
};
