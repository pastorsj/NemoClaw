<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 1 Summary: Architecture Baseline

## Outcome

The architecture baseline is complete through exact current main
`705372dab8d4d28c0daf058aec1579ffc482db4c`.

This is the historical Phase 1 baseline. Phase 2 rebased through
`d0d5120cc6d574a5575b322b79b7cd49ca7c269d`; its research and plans supersede later-changed
onboarding recovery and E2E command-boundary conclusions.

NemoClaw should use one safe distribution envelope with three typed component contracts:

1. agent runtime;
2. runtime provider;
3. serving runtime.

Platform and hardware remain observed qualification data. Privileged host preparation is separate
only when real independently owned mutation justifies it. NemoClaw remains the composition,
authorization, state, recovery, and release control plane. OpenShell remains the sandbox and policy
enforcement plane.

## Reconciliation

The old migration is preserved as behavioral evidence. It is not mergeable into current main
without losing newer agent, runtime-provider, serving, readiness, and test architecture. The useful
package installer, receipt, CLI, onboarding, structure, and test behavior will be ported as small
capability slices.

The Phase 1 upstream refresh preserved an incomplete sandbox rather than deleting by mutable name.
Current main has since made that post-create state recovery-only and added an independent retained
record; Phase 2 binds package identity into that record and intentionally does not enable same-name
`onboard --resume`.

## NeMo Fabric

NeMo Fabric is a natural optional package-validation and agent-invocation capability inside an
existing OpenShell sandbox. It is not a NemoClaw runtime provider or lifecycle replacement. Exact
current adapter dependencies do not match the current NemoClaw OpenClaw, Hermes, Deep Agents Code,
or Pi packages closely enough for a support claim. A deterministic stable-version pilot is the next
safe evidence step if accepted.

## Implementation Gate

Phase 2 begins only after a recorded decision has status `Accept` and states reason, placement,
accountable maintainer, validation, product scope, ownership, trust, qualification, and rollback.
The smallest implementation slice is the agent envelope and digest-addressed store, harness CLI,
installed-only onboarding selection, exact agent identity in current state, package-test
aggregation, and one terminal-agent package. Cross-component selection is deferred until a second
accepted package kind consumes it.
