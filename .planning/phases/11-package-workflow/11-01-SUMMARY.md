---
phase: 11-package-workflow
plan: 01
subsystem: packages
tags: [agent-runtime, packages, openclaw, hermes, deep-agents-code, onboarding]

requires: []
provides:
  - One readable in-tree package structure for OpenClaw, Hermes, and LangChain Deep Agents Code
  - Receipt-verified package discovery and the public `nemoclaw harness` commands
  - One fixed managed configuration command without an agent-ID generator switch in core
  - Deterministic, macOS package-install, and no-messaging OpenClaw Brev evidence
affects: [package-authoring, onboarding, managed-startup, external-package-handoff]

tech-stack:
  added: []
  patterns:
    - Data-only package discovery with receipt-verified installed copies
    - Fixed in-sandbox configuration command with package-owned native translation
    - Responsibility directories shared only where packages have the same responsibility

key-files:
  created:
    - packages/nemoclaw-openclaw/README.md
    - packages/nemoclaw-hermes/README.md
    - packages/nemoclaw-langchain-deepagents-code/README.md
    - .planning/phases/11-package-workflow/11-01-SUMMARY.md
  modified:
    - packages/README.md
    - src/lib/harness/package-registry.ts
    - src/lib/onboard/managed-startup/image-runtime.ts
    - src/lib/onboard/build-context-stage.ts
    - test/package-contract/harness-packages.test.ts
    - test/e2e/live/full-e2e.test.ts

key-decisions:
  - "Keep the public command as nemoclaw harness install and preserve the existing onboard experience."
  - "Keep the registry contract to package.json, manifest.yaml, both Dockerfiles, start.sh, policy-additions.yaml, and one managed configuration command; include README.md in the in-tree authoring template."
  - "Keep specialized host helpers narrow and named instead of creating an unrestricted package callback system."
  - "Keep messaging on the existing core-owned channel workflow for this version; packages retain native rendering and startup behavior."
  - "Qualify the in-tree package layout before any separate repository or package-index handoff."

patterns-established:
  - "Root files show identity, image assembly, startup, and policy; responsibility directories hold configuration, runtime, host transitions, compatibility work, plugins, and checks."
  - "Installed copies are private, content-addressed, receipt-verified, and normalized without changing the source package."
  - "A new in-tree agent runtime joins discovery by directory and manifest, then adds only the explicit specialized core boundaries that its tested behavior requires."

requirements-completed: []

duration: 14h 31m
completed: 2026-08-24
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Workflow Summary

**OpenClaw, Hermes, and LangChain Deep Agents Code now follow one readable package workflow without changing the NemoClaw onboarding experience**

## Performance

- **Duration:** 14 hours 31 minutes
- **Started:** 2026-08-23T23:18:00-04:00
- **Completed:** 2026-08-24T13:49:00-04:00
- **Tasks:** 5
- **Files modified:** 481

## Accomplishments

- Added `nemoclaw harness list` and `nemoclaw harness install <id>` over a data-only registry that
  installs receipt-verified copies under `~/.nemoclaw/harnesses`.
- Kept onboarding flags, choices, aliases, and sandbox commands unchanged. Installed packages take
  precedence over bundled packages without adding another user-facing workflow.
- Gave OpenClaw, Hermes, and LangChain Deep Agents Code the same root authoring template and the
  same responsibility vocabulary where their integrations match: `config`, `runtime`, `host`,
  `compat`, `plugin`, and `checks`.
- Replaced the managed-startup generator switch with the fixed package command
  `/usr/local/lib/nemoclaw/generate-config`.
- Split OpenClaw and Hermes startup into visible workflows backed by package-owned modules. Kept
  atomic security transactions, generated dependency inventories, and version-bound patches whole
  when splitting them would separate validation from mutation.
- Fixed source-install qualification and copied-package permissions. A matching installed package
  can use its trusted repository-root build context without changing the bundled source tree.

## Package Workflow

Every in-tree package example tells the same workflow:

1. `README.md` explains the package workflow and compatibility debt.
2. `package.json` and `manifest.yaml` identify the agent runtime and declare data-only capabilities.
3. `Dockerfile.base` pins the upstream dependency layer.
4. `Dockerfile` assembles the sandbox image from package-owned files.
5. `runtime/generate-config.sh` translates managed startup input through the fixed image command.
6. `start.sh` shows the process startup sequence.
7. Responsibility directories hold native configuration, runtime behavior, bounded host helpers,
   upstream compatibility work, native plugins, and build checks.
8. Package contracts and live targets verify the packed files and the real install-to-cleanup path.

The registry requires `package.json`, `manifest.yaml`, `Dockerfile.base`, `Dockerfile`, `start.sh`,
and `policy-additions.yaml`. The in-tree examples also ship `README.md`; registry discovery does not
require or execute it.

NemoClaw retains product workflow and rollback decisions. It owns command parsing, receipts,
onboarding, credential selection, OpenShell registration, policy requests, authorization, and
persisted product state. OpenShell retains credential custody and delivery, sandbox lifecycle, and
enforcement authority. Packages own image assembly, native configuration, process startup, runtime
guards, plugins, compatibility patches, and package checks.

## Task Commits

1. **Freeze the package workflow and configuration command** - `dbb54aa415`
2. **Reorganize the package implementations** - `c1ea1316ac`, corrected by `2fb5d4650d`, with
   the authoring workflow clarified by `72f9622736`
3. **Remove the proven agent-specific core dispatch** - `dbb54aa415`
4. **Make package startup read as a workflow** - `f9bcdcae87`, qualified by `635e4927b4`
5. **Qualify deterministic and live behavior** - `d52dfb2249`, `6cb4495a9c`, `6a2922c411`,
   `35270f1bf1`, `a2ef5d36e8`, `d5c8fe6003`, `7eead7aa40`, and `fbf3b94280`

**Plan metadata:** this summary commit.

The local remote-tracking ref `pastorsj/agent-runtime-package-migration` points to `72f9622736`.
Commits `7eead7aa40`, `fbf3b94280`, and this summary commit were not pushed.

## Verification

- The bounded broad deterministic run on `d52dfb2249` passed 2,450 files and 38,474 tests, with 23
  files and 396 tests skipped by documented platform or opt-in conditions.
- The final package-contract run passed all 1,346 tests with two workers. Three default-worker
  host-load timeouts also passed all 11 affected tests in an isolated replay before the bounded run.
- The copied-package permission change in `fbf3b94280` passed 54 focused registry tests. Six
  related integration files passed 205 tests with 16 documented skips. Tests cover directory mode
  `0775`, file mode `0664`, executable preservation, receipt capture, atomic refresh, mutation, and
  symbolic-link substitution without changing the external target.
- CLI compilation, CLI type-checking, repository checks, formatting, linting, source-shape and
  growth guards, secret scanning, and commit hooks passed for the final source changes.
- The OpenClaw plugin passed 909 tests. Hermes Python plugin tests passed 5 tests. Bash syntax,
  ShellCheck, and plugin type-checking passed.
- At commit `fbf3b94280` on Apple silicon macOS, a private temporary home listed and installed all
  three packages. All three receipts verified, and the test removed the temporary home.
- No live messaging-service test, messaging environment value, or messaging credential was used.

## Live Qualification

Ubuntu 22.04.5 Arm64 on Brev ran the registered `sandbox-survival` target against signed commit
`fbf3b94280`, Node.js `22.23.2`, npm `10.9.8`, OpenShell `0.0.106`, and the authenticated
catalogue-listed model `nvidia/nvidia/nemotron-3-ultra`.

The target passed 1 test in 244.82 seconds:

1. Installed OpenClaw through `nemoclaw harness install` before onboarding. The installed root was
   mode `0700`, the receipt was `0600`, and copied nested directories were not group-writable.
2. Completed onboarding, registration, sandbox creation, baseline sandbox access, and live
   inference.
3. Wrote persistent workspace, session, and memory markers.
4. Restarted the gateway and reconnected to the sandbox.
5. Verified post-restart status, persistent markers, and live inference.
6. Destroyed the sandbox, removed its registry entry, and completed registered cleanup.

The guardian and a separate audit found no remaining gateway process, listener, container,
service, package receipt, registry entry, authority file, temporary path, or credential trace.
The actual NemoClaw configuration, state, and home metadata matched their pre-run records. The
preexisting `openshell-docker` network matched its pre-run semantic configuration and had zero
endpoints.

## Issues Encountered

- The published managed-image candidate `v0.1.0` was unavailable from GHCR. Qualification used the
  repository's existing `E2E_WORKLOAD_SOURCE=legacy-dockerfile` lane instead of inventing an image
  or changing the catalogue.
- That lane exposed path-authority and restrictive-mode defects in the installed-package build
  context. Commits `6cb4495a9c` through `d5c8fe6003` bind the trusted source context to an equal
  package digest and assign exact image payload modes without weakening sandbox checks.
- Brev attempt r7 found that filesystem copy preserved an existing mode `0775` on
  `plugin/dist`. Commit `fbf3b94280` now normalizes the complete staged copy through no-follow file
  descriptors, verifies path identity before and after each change, and republishes an earlier
  clean but group-writable installation atomically. The package source remains unchanged.
- Brev attempt r8 passed package installation but received HTTP 403 for
  `nvidia/nemotron-3-super-120b-a12b`. The authenticated model catalogue did not contain that model.
  A request with the same URL, key, and payload shape returned HTTP 200 for the listed prior model
  `nvidia/nvidia/nemotron-3-ultra`, which r9 then used. No source change or inference retry hid the
  authorization failure.
- An earlier guardian preflight matched its own SSH wrapper and removed the unattached
  `openshell-docker` network before it had recorded the pre-run network. Docker retained enough
  local metadata to reconstruct the exact prior semantics. The replacement has the same driver,
  scope, attachability, IP address management, subnet, gateway, label, options, and zero endpoints;
  only Docker's generated network ID and creation time changed. Later guardians record the network
  before any preflight can stop the run.
- On macOS, OpenShell `0.0.106` could not prove a custom-port listener owner. The canonical port
  passed preflight, but the Homebrew service missed its health deadline and standalone fallback
  also failed. Both attempts stopped before sandbox image creation and removed their exact gateway,
  launch-agent, sandbox, log, and temporary-home state.

## Remaining Boundary

This is an in-tree local implementation candidate, not a decision that establishes a supported
product surface. `nemoclaw harness install` currently installs only packages bundled with this
NemoClaw checkout; it does not fetch PyPI or npm artifacts. Managed startup, Model Context Protocol
(MCP), messaging, dashboard, pairing, and other specialized lifecycle paths retain explicit closed
runtime contracts in core. Moving packages to separate repositories, authenticating package
publishers, selecting release versions, and publishing package-index artifacts require a separate
maintainer decision and lifecycle ownership. The package trees are arranged so that handoff can
move them without redesigning their internal workflow.

## Self-Check: PASSED

- All five plan tasks and verification boxes are complete.
- GSD records only Phase 11 complete; Phases 1-10 and their requirements remain unchanged.
- The package structures, fixed configuration command, deterministic results, macOS package result,
  Brev result, remote-tracking ref, and preserved local-only boundary match repository evidence.
- No secret value was printed or committed. No live messaging-service test ran.
- No branch was pushed. The abandoned OpenShell `0.0.111` migration remains in `stash@{0}`.

---
*Phase: 11-package-workflow*
*Completed: 2026-08-24*
