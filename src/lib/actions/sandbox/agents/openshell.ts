// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as openshellRuntime from "../../../adapters/openshell/runtime";

/** OpenShell process access used by agent-roster commands. */
export const captureOpenshell: typeof openshellRuntime.captureOpenshell = (...args) =>
  openshellRuntime.captureOpenshell(...args);

export function getOpenshellBinary(): string {
  return openshellRuntime.getOpenshellBinary();
}
