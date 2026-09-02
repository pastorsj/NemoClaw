<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `public-fabric-turn.process-cleanup-settle` | `public-fabric-turn` | 3 inspections, one second apart | The complete `/proc` inspection finds only processes absent from the fixed pre-turn PID and start-time baseline. Fabric or harness matches and unreadable processes stop without retry. | The same in-sandbox probe repeats a read-only inspection. It does not rerun the agent turn or mutate state. A child that remains for two seconds is still absent from the baseline and fails the final inspection. | `shell/fabric-<agent>-<phase>-process-cleanup.stdout.txt` |
