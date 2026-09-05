<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Dependency boundary

This local proof of concept intentionally uses the published Python SDK rather
than the interactive DeepSeek Harness CLI as its integration seam.

- `deepseek-harness-sdk==0.1.2rc1`
- `deepseek-harness-runtime-bin==0.1.2rc1`
- `nemo-fabric==0.2.0` and its matching `0.2.0` contract/runtime packages
- Python 3.13 in the sandbox image

The SDK's `sdk-minimal` profile owns the fixed local shell/editor tool set. It
does not enable MCP, messaging, background services, self-update, or plugin
discovery. The adapter owns one SDK invocation per Fabric request. The generic
Fabric runner owns the outer deadline, while the adapter owns cancellation and
process-group cleanup because the SDK's request timeout does not bound its full
notification wait.

Promotion beyond a local POC requires a fresh dependency/security review and
real image qualification on both supported Linux architectures.
