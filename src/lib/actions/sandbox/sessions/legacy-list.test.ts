// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../adapters/openshell/runtime", () => ({ captureOpenshell: captureMock }));
vi.mock("../exec", async () => {
  const actual = await vi.importActual<typeof import("../exec")>("../exec");
  return { ...actual, execSandbox: execMock };
});

import { WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { runLegacySessionList } from "./legacy-list";

describe("legacy no-receipt session listing", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureMock.mockReset();
    execMock.mockClear();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("streams the historical Hermes command form", async () => {
    await runLegacySessionList("legacy-hermes", "hermes", {
      useListSubcommand: false,
      arguments: ["--limit", "5"],
    });

    expect(execMock).toHaveBeenCalledWith(
      "legacy-hermes",
      ["hermes", "sessions", "list", "--limit", "5"],
      {},
      expect.objectContaining({ exit: expect.any(Function) }),
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("retains internal-session filtering for historical OpenClaw rows", async () => {
    captureMock.mockReturnValue({
      status: 0,
      output: [
        "Sessions listed: 2",
        "direct  agent:main:real  id:sid-real",
        `direct  agent:main:warm  id:${WARMUP_SESSION_ID_PREFIX}1`,
      ].join("\n"),
    });

    await runLegacySessionList("legacy-openclaw", null, {
      useListSubcommand: true,
      arguments: [],
    });

    expect(captureMock).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "legacy-openclaw", "--", "openclaw", "sessions", "list"],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      "Sessions listed: 1\ndirect  agent:main:real  id:sid-real\n",
    );
  });

  it("defaults unknown historical agent values to the OpenClaw compatibility command", async () => {
    captureMock.mockReturnValue({ status: 0, output: "Sessions listed: 0" });

    await runLegacySessionList("legacy-unknown", "future-agent", {
      useListSubcommand: false,
      arguments: [],
    });

    expect(captureMock).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "legacy-unknown", "--", "openclaw", "sessions"],
      expect.any(Object),
    );
  });
});
