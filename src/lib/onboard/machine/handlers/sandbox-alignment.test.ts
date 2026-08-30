// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

it("keeps sandbox creation arguments aligned when verified effects are absent", async () => {
  const { deps, calls } = createDeps();

  await handleSandboxState({ ...baseOptions(deps), fresh: true });

  expect(calls.createSandbox).toHaveBeenCalledOnce();
  const createCall = calls.createSandbox.mock.calls[0] ?? [];
  expect(createCall).toHaveLength(17);
  expect(createCall.at(-2)).toMatchObject({ recreate: false });
  expect(createCall.at(-1)).toBeUndefined();
});
