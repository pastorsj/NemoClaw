<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DeepSeek and Haystack local POC decision

Status: **Accept**

## Reason

Prove whether NemoClaw's typed harness package contract and NeMo Fabric adapter boundary can support two materially different new harnesses without adding harness-specific behavior to NemoClaw core.

## Placement

The implementations live only on the owner's local POC branch as package-shaped examples. They are not canonical NemoClaw integrations, are not published, and must not be described as supported product surfaces.

## Owner and lifecycle

The repository owner requesting this work is accountable for the POC. The packages are disposable research artifacts: they may be revised or removed after the contract findings are reviewed. There is no compatibility or release commitment.

## Security boundary

The POC uses existing OpenShell isolation, provider credential injection, network policy, package-manifest validation, and Fabric process deadlines. It excludes messaging credentials, webhooks, third-party deployment servers, and public package publication. Test artifacts must redact inference credentials.

## Validation plan

- Package-owned unit and contract tests for manifest, configuration, adapter protocol, errors, cancellation, and cleanup.
- Container build and smoke tests for every supported host architecture available to the POC.
- Real local macOS onboarding and headless inference through the public NemoClaw CLI.
- Real Brev Linux onboarding and headless inference through the same CLI contract.
- Negative E2E coverage for invalid configuration, unavailable inference, timeout, and adapter process cleanup.
- A final gap report distinguishing reusable contract behavior from any missing generic entrypoint.
