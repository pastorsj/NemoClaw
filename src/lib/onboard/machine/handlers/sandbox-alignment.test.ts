// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps sandbox creation arguments aligned when verified effects are absent", async () => {
  const { deps, calls } = createDeps();

  await handleSandboxState({ ...baseOptions(deps), fresh: true });

  expect(calls.createSandbox).toHaveBeenCalledOnce();
  const createCall = calls.createSandbox.mock.calls[0] ?? [];
  expect(createCall).toHaveLength(16);
  expect(createCall.at(-1)).toMatchObject({ recreate: false });
});
