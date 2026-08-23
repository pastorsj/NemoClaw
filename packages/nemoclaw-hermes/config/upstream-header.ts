// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

type HermesManagedRouteRuntime = {
  buildHermesUpstreamHeader(config: Record<string, unknown>): string;
};

const require = createRequire(import.meta.url);
const managedRoute = require("./managed-route.cts") as HermesManagedRouteRuntime;

export const buildHermesUpstreamHeader = managedRoute.buildHermesUpstreamHeader;
