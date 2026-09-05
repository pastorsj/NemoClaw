// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { getAgentChoices, loadAgent } from "../agent/defs";
import { resolveAgent } from "../agent/onboard";
import { createSelectOnboardAgent, resolveUnpackagedOnboardAgent } from "./agent-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

// Exercises the real agent registry (packages/nemoclaw-openclaw + packages/nemoclaw-hermes) so the
// red->green transition reflects genuine wizard behavior rather than a mock.
function makeSelectOnboardAgent(reply: string) {
  const prompt = vi.fn(async (_question: string) => reply);
  const log = vi.fn((_message?: string) => {});
  const select = createSelectOnboardAgent({
    resolveAgent,
    loadAgent,
    getAgentChoices,
    isNonInteractive: () => false,
    note: () => {},
    log,
    prompt,
    selectFromNumberedMenu: selectFromNumberedMenuOrExit,
  });
  return { select, prompt, log };
}

describe("selectOnboardAgent interactive agent selection", () => {
  beforeEach(() => {
    delete process.env.NEMOCLAW_AGENT;
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_AGENT;
  });

  it("presents both OpenClaw and Hermes and honors a Hermes selection", async () => {
    // Derive Hermes' menu position from the real registry so the test stays
    // correct if another agent is later sorted ahead of Hermes.
    const choices = getAgentChoices();
    const hermesPosition = choices.findIndex((choice) => choice.name === "hermes") + 1;
    assert.ok(hermesPosition > 0, "expected Hermes in the agent registry");
    const { select, prompt, log } = makeSelectOnboardAgent(String(hermesPosition));

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 1);
    const menu = log.mock.calls.map((call) => call[0]).join("\n");
    assert.match(menu, /OpenClaw/);
    assert.match(menu, /Hermes/);
  });

  it("retains the selected OpenClaw definition when the user accepts the default", async () => {
    const { select } = makeSelectOnboardAgent("");

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "openclaw");
  });

  it("does not reload an interactive choice after the active definition changes", async () => {
    let activeDefinition = { name: "synthetic-harness", displayName: "Selected" } as never;
    const selectedDefinition = activeDefinition;
    const loadAgent = vi.fn(() => activeDefinition);
    const select = createSelectOnboardAgent({
      resolveAgent: vi.fn(),
      loadAgent,
      getAgentChoices: () => [
        { name: "synthetic-harness", displayName: "Synthetic", description: "Selected package" },
        { name: "other-harness", displayName: "Other", description: "Other package" },
      ],
      isNonInteractive: () => false,
      note: vi.fn(),
      log: vi.fn(),
      prompt: vi.fn(async () => {
        activeDefinition = {
          name: "synthetic-harness",
          displayName: "Ambient replacement",
        } as never;
        return "1";
      }),
      selectFromNumberedMenu: (_reply, _defaultIndex, choices) => choices[0]!,
    });

    const selected = await select({ canPrompt: true });

    assert.equal(selected, selectedDefinition);
    assert.equal(loadAgent.mock.calls.length, 2);
  });

  it("skips the picker when an explicit --agent flag is provided", async () => {
    const { select, prompt } = makeSelectOnboardAgent("1");

    const agent = await select({ agentFlag: "hermes", canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 0);
  });

  it("does not re-prompt when resuming an OpenClaw session", async () => {
    // Resume honors the recorded agent; the OpenClaw default is stored as a
    // null session agent, so the picker must stay hidden rather than risk an
    // accidental agent change.
    const { select, prompt } = makeSelectOnboardAgent("2");

    const agent = await select({ resume: true, canPrompt: true });

    assert.equal(agent, null);
    assert.equal(prompt.mock.calls.length, 0);
  });
});

describe("resolveUnpackagedOnboardAgent", () => {
  it("keeps NemoCUA behind its existing explicit feature gate", () => {
    assert.throws(() => resolveUnpackagedOnboardAgent("nemocua", {}), /NemoCUA is disabled/u);

    const definition = resolveUnpackagedOnboardAgent("nemocua", {
      NEMOCLAW_CUA_ENABLED: "1",
    });

    assert.equal(definition?.name, "nemocua");
    assert.equal(resolveUnpackagedOnboardAgent("openclaw", {}), null);
  });
});
