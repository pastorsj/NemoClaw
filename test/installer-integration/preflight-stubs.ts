// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { writeExecutable } from "../helpers/installer-sourced-env";

/** Docker stub whose `info` always succeeds, so ensure_docker passes. */
export function writeDockerOkStub(fakeBin: string): void {
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","Name":"Docker Desktop","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
  exit 0
fi
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "systemctl"),
    `#!/usr/bin/env bash
if [ "$1" = "is-active" ] && [ "$2" = "docker" ]; then echo "active"; exit 0; fi
exit 0
`,
  );
}

export function writeOpenShellOkStub(fakeBin: string, version = "0.0.72"): void {
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "openshell ${version}"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods
exit 0
`,
  );
}
