// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as registry from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

beforeEach(() => {
  vi.spyOn(registry, "getBaselineExclusionTransition").mockReturnValue(null);
  vi.spyOn(registry, "getBaselineExclusions").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps sandbox creation arguments aligned when verified effects are absent", async () => {
  const { deps, calls } = createDeps();

  await handleSandboxState({ ...baseOptions(deps), fresh: true });

  expect(calls.createSandbox).toHaveBeenCalledOnce();
  const createCall = calls.createSandbox.mock.calls[0] ?? [];
  expect(createCall).toHaveLength(17);
  expect(createCall.at(-2)).toMatchObject({ recreate: false });
  expect(createCall.at(-1)).toBeUndefined();
});
