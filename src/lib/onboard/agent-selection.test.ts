// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { type AgentChoice, loadAgent } from "../agent/defs";
import { resolveAgent } from "../agent/onboard";
import { createSelectOnboardAgent } from "./agent-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

const STANDARD_AGENT_CHOICES = [
  {
    name: "openclaw",
    displayName: "OpenClaw",
    description: "Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
  },
  {
    name: "hermes",
    displayName: "Hermes Agent",
    description: "Self-improving AI agent with learning loop (Nous Research)",
  },
  {
    name: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    description: "Terminal coding agent built on the Deep Agents SDK",
  },
] as const;

// Use explicit installed-choice fixtures so selector behavior does not depend on host state.
function makeSelectOnboardAgent(
  reply: string,
  {
    choices = [...STANDARD_AGENT_CHOICES],
    nonInteractive = false,
  }: { choices?: AgentChoice[]; nonInteractive?: boolean } = {},
) {
  const prompt = vi.fn(async (_question: string) => reply);
  const log = vi.fn((_message?: string) => {});
  const note = vi.fn((_message: string) => {});
  const selectFromNumberedMenu = vi.fn(
    (rawChoice: string, defaultIdx: number, options: AgentChoice[]) =>
      selectFromNumberedMenuOrExit(rawChoice, defaultIdx, options),
  );
  const select = createSelectOnboardAgent({
    resolveAgent,
    loadAgent,
    getAgentChoices: () => choices,
    isNonInteractive: () => nonInteractive,
    note,
    log,
    prompt,
    selectFromNumberedMenu,
  });
  return { select, prompt, log, note, selectFromNumberedMenu };
}

describe("selectOnboardAgent behavior", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_AGENT", "");
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "");
    vi.stubEnv("NEMOCLAW_CANDIDATE_AGENTS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the three standard agents in order and keeps OpenClaw as choice 1", async () => {
    const { select, prompt, log, selectFromNumberedMenu } = makeSelectOnboardAgent("");

    const agent = await select({ canPrompt: true });

    assert.equal(agent, null);
    assert.equal(prompt.mock.calls.length, 1);
    assert.match(prompt.mock.calls[0]?.[0] ?? "", /Choose \[1\]/);
    assert.deepEqual(selectFromNumberedMenu.mock.calls[0], ["", 1, STANDARD_AGENT_CHOICES]);
    const menu = log.mock.calls.map((call) => call[0]).join("\n");
    assert.match(menu, /OpenClaw/);
    assert.match(menu, /Gateway-based AI agent with plugin ecosystem/);
    assert.match(menu, /Hermes Agent/);
    assert.match(menu, /Self-improving AI agent with learning loop/);
    assert.match(menu, /LangChain Deep Agents Code/);
    assert.match(menu, /Terminal coding agent built on the Deep Agents SDK/);
  });

  it("returns LangChain Deep Agents Code when the user selects choice 3", async () => {
    const { select } = makeSelectOnboardAgent("3");

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "langchain-deepagents-code");
  });

  it("selects the only installed agent runtime without prompting", async () => {
    const { select, prompt } = makeSelectOnboardAgent("", {
      choices: [{ ...STANDARD_AGENT_CHOICES[1] }],
    });

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 0);
  });

  it("shows only the installed agent runtimes", async () => {
    const installedChoices = [{ ...STANDARD_AGENT_CHOICES[0] }, { ...STANDARD_AGENT_CHOICES[1] }];
    const { select, log, prompt } = makeSelectOnboardAgent("2", {
      choices: installedChoices,
    });

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 1);
    const menu = log.mock.calls.map((call) => call[0]).join("\n");
    assert.match(menu, /OpenClaw/);
    assert.match(menu, /Hermes Agent/);
    assert.doesNotMatch(menu, /LangChain Deep Agents Code/);
  });

  it("reports the default OpenClaw selection without prompting in non-interactive mode", async () => {
    const { select, prompt, note } = makeSelectOnboardAgent("3", { nonInteractive: true });

    const agent = await select({ canPrompt: true });

    assert.equal(agent, null);
    assert.equal(prompt.mock.calls.length, 0);
    assert.match(note.mock.calls[0]?.[0] ?? "", /\[non-interactive\] Agent: OpenClaw/);
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
