// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

describe("onboard messaging interactive token validation", () => {
  it(
    "interactive setupMessagingChannels drops slack when prompted token fails tokenFormat check (#1912)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-slack-format-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "slack-format-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      // Subscript: mocks credentials.prompt to return a bogus Slack token,
      // exposes MESSAGING_CHANNELS so the parent can look up the Slack toggle
      // digit, and asserts that setupMessagingChannels rejects the invalid
      // token without persisting it. Slack is the 3rd channel in insertion
      // order today (telegram, discord, slack) but we compute the index
      // dynamically to avoid a brittle coupling to that ordering.
      const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const saveCalls = [];
credentials.saveCredential = (key, value) => { saveCalls.push({ key, value }); };
credentials.getCredential = () => null;
credentials.prompt = async (message) => {
  if (message.includes("Slack Bot Token")) return "abcd";
  return "";
};

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const { setupMessagingChannels, MESSAGING_CHANNELS } = require(${onboardPath});

(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;

  const result = await setupMessagingChannels();
  console.log(JSON.stringify({
    result,
    saveCalls,
    slackIndex1Based: MESSAGING_CHANNELS.findIndex((c) => c.name === "slack") + 1,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Dry run with just Enter — no toggles, empty result — used to read back
      // Slack's 1-based index from the same subscript so the real run can
      // press the right digit.
      const introspect = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: fs.realpathSync(tmpDir),
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
        input: "\n",
      });
      assert.equal(introspect.status, 0, introspect.stderr);
      const introspectOut = JSON.parse(introspect.stdout.trim().split("\n").pop()!);
      const slackIdx = introspectOut.slackIndex1Based;
      assert.ok(slackIdx >= 1, `unexpected slack index: ${slackIdx}`);

      // Real run: press Slack's digit, Enter. Slack gets toggled on, prompt
      // fires, mocked prompt returns "abcd", tokenFormat regex rejects it,
      // channel is dropped, saveCredential never runs for SLACK_BOT_TOKEN.
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: fs.realpathSync(tmpDir),
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
        input: `${slackIdx}\n`,
      });

      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim().split("\n").pop()!);

      assert.ok(
        !out.result.includes("slack"),
        `slack should have been dropped after invalid token; got ${JSON.stringify(out.result)}`,
      );
      assert.ok(
        !out.saveCalls.some((c: { key: string }) => c.key === "SLACK_BOT_TOKEN"),
        `SLACK_BOT_TOKEN should NOT have been persisted; saveCalls=${JSON.stringify(out.saveCalls)}`,
      );
      assert.ok(
        result.stderr.includes("Invalid format") || result.stdout.includes("Invalid format"),
        `expected 'Invalid format' warning; stderr=${result.stderr} stdout=${result.stdout}`,
      );
    },
  );
});
