// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLoggedDockerShell } from "../helpers/docker-shell";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");

function dockerHealthCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker?: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = endMarker ? dockerfile.indexOf(endMarker, start) : dockerfile.length;
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile health check after ${startMarker}`);
  }
  const healthOffset = dockerfile.slice(start, end).search(/^HEALTHCHECK\b/m);
  const healthIndex = healthOffset === -1 ? -1 : start + healthOffset;
  if (healthIndex === -1) {
    throw new Error(`Expected HEALTHCHECK instruction after ${startMarker}`);
  }
  const healthLines: string[] = [];
  for (const line of dockerfile.slice(healthIndex, end).split("\n")) {
    healthLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = healthLines[healthLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete HEALTHCHECK instruction after ${startMarker}`);
  }
  const instruction = healthLines.join("\n").trim().replace(/\\\n/g, " ");
  const command = instruction.match(/(?:^|\s)CMD\s+([\s\S]+)$/)?.[1];
  if (!command) {
    throw new Error(`Expected shell-form HEALTHCHECK CMD after ${startMarker}`);
  }
  return command.trim();
}

function linuxProcStat(pid: string, starttime: string, ppid = "1", state = "S"): string {
  return `${pid} (openclaw) ${state} ${ppid} ${Array(17).fill("0").join(" ")} ${starttime}\n`;
}

describe("sandbox provisioning: image health checks (#1430)", () => {
  it.each([
    ["default dashboard URL", {}, "http://127.0.0.1:18789/health"],
    [
      "CHAT_UI_URL with scheme",
      { CHAT_UI_URL: "http://127.0.0.1:19000" },
      "http://127.0.0.1:19000/health",
    ],
    [
      "CHAT_UI_URL without scheme",
      { CHAT_UI_URL: "remote-host:19111" },
      "http://127.0.0.1:19111/health",
    ],
    [
      "OPENCLAW_GATEWAY_PORT",
      { CHAT_UI_URL: "http://127.0.0.1:19000", OPENCLAW_GATEWAY_PORT: "19333" },
      "http://127.0.0.1:19333/health",
    ],
    [
      "NEMOCLAW_DASHBOARD_PORT override",
      {
        CHAT_UI_URL: "http://127.0.0.1:19000",
        NEMOCLAW_DASHBOARD_PORT: "19222",
        OPENCLAW_GATEWAY_PORT: "19333",
      },
      "http://127.0.0.1:19222/health",
    ],
  ])("routes production gateway probe through %s", (_label, env, expectedUrl) => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const command = dockerHealthCommandBetween(
      dockerfile,
      "# Health check: poll the gateway's /health endpoint",
      "ENTRYPOINT",
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-probe-"));

    try {
      const probe = runLoggedDockerShell(
        command,
        tmp,
        ['curl() { printf "%s\\n" "$*" >> "$call_log"; }'],
        {
          env: {
            NEMOCLAW_DASHBOARD_PORT: undefined,
            OPENCLAW_GATEWAY_PORT: undefined,
            CHAT_UI_URL: undefined,
            ...env,
          },
        },
      );

      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("-sf");
      expect(probe.calls).toContain(expectedUrl);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #3975: on runtime shapes where the dashboard port lives in a different
  // network namespace (DGX Spark / OpenShell-managed forwarding), the
  // in-container curl probe sees "connection refused" while the actual
  // delivery chain is fine. The healthcheck must not contradict that by
  // failing the container outright — it falls back to verifying that the
  // OpenClaw gateway process is still alive in this container.
  describe("falls back to local liveness when the in-container dashboard port has no listener (#3975)", () => {
    const nulArgv = (...argv: string[]) => `${argv.join("\0")}\0`;
    const unterminatedArgv = (...argv: string[]) => argv.join("\0");
    const npmGatewayCmdline = nulArgv(
      "node",
      "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
      "gateway",
      "run",
      "--port",
      "18789",
    );

    function runProductionHealthProbe({
      curlExit,
      gatewayCmdline = npmGatewayCmdline,
      gatewayLog = "gateway log line\n",
      // The /tmp/nemoclaw-gateway-local marker is dropped by nemoclaw-start
      // only when this container runs the in-container OpenClaw gateway. Most
      // probes here exercise that path, so default it to present.
      gatewayLocalMarker = true,
      recordedStartIdentity = "12345",
      observedStartIdentity = "12345",
    }: {
      curlExit: number;
      gatewayCmdline?: string | null;
      gatewayLog?: string;
      gatewayLocalMarker?: boolean;
      recordedStartIdentity?: string;
      observedStartIdentity?: string;
    }) {
      const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-fallback-"));
      const logPath = path.join(tmp, "gateway.log");
      const markerPath = path.join(tmp, "nemoclaw-gateway-local");
      const pidPath = path.join(tmp, "nemoclaw-gateway.pid");
      const procRoot = path.join(tmp, "proc");
      const rawCommand = dockerHealthCommandBetween(
        dockerfile,
        "# Health check: poll the gateway's /health endpoint",
        "ENTRYPOINT",
      );
      const command = rawCommand
        .replaceAll("/tmp/gateway.log", logPath)
        .replaceAll("/tmp/nemoclaw-gateway-local", markerPath)
        .replaceAll("/tmp/nemoclaw-gateway.pid", pidPath)
        .replaceAll("/proc/", `${procRoot}/`);

      if (gatewayLog !== "") {
        fs.writeFileSync(logPath, gatewayLog);
      }
      if (gatewayLocalMarker) {
        fs.writeFileSync(markerPath, "");
      }
      gatewayCmdline === null
        ? undefined
        : (() => {
            const pid = "4242";
            fs.mkdirSync(path.join(procRoot, pid), { recursive: true });
            fs.writeFileSync(
              path.join(procRoot, pid, "stat"),
              linuxProcStat(pid, observedStartIdentity),
            );
            fs.writeFileSync(path.join(procRoot, pid, "cmdline"), gatewayCmdline);
            fs.writeFileSync(pidPath, `${pid} ${recordedStartIdentity}\n`);
          })();

      try {
        const probe = runLoggedDockerShell(command, tmp, [
          `curl() { printf "curl %s\\n" "$*" >> "$call_log"; return ${curlExit}; }`,
        ]);
        return probe;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it("reports healthy when in-container curl works (Docker-driver / standalone)", () => {
      const probe = runProductionHealthProbe({
        curlExit: 0,
        gatewayCmdline: null,
        gatewayLog: "",
      });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
    });

    it("reports healthy when curl gets connection refused but the tracked npm OpenClaw gateway is alive", () => {
      const probe = runProductionHealthProbe({ curlExit: 7 });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
    });

    it("rejects a live PID whose start identity differs from the recorded gateway", () => {
      const probe = runProductionHealthProbe({
        curlExit: 7,
        recordedStartIdentity: "12345",
        observedStartIdentity: "67890",
      });

      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl times out (wedged HTTP server, not namespace mismatch)", () => {
      // A connect timeout means a listener exists but is not responding,
      // e.g. a wedged HTTP server. We deliberately do not fall back to the
      // process check there — Docker should restart the container.
      const probe = runProductionHealthProbe({ curlExit: 28, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl gets connection refused and openclaw is not running", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl gets connection refused and the gateway log was never written (openclaw never started)", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, gatewayLog: "" });
      expect(probe.result.status).toBe(1);
    });

    it("does not fall back when curl reports an HTTP error (gateway answered with failure)", () => {
      const probe = runProductionHealthProbe({ curlExit: 22, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
      // HTTP errors from the in-container probe should bypass the fallback;
      // a 4xx/5xx means the gateway is reachable and unhappy, not a
      // namespace mismatch.
    });

    // #4503: OpenShell docker-driver sandboxes deliver the OpenClaw gateway
    // outside this container's network namespace (it runs on the host), so
    // nemoclaw-start never drops the /tmp/nemoclaw-gateway-local marker. The
    // in-container curl gets connection-refused and no in-container process
    // can prove gateway liveness, yet `nemoclaw status`/OpenShell report Ready.
    // Without the marker the healthcheck must NOT mark the container unhealthy
    // off a signal it cannot observe.
    describe("does not falsely fail when the gateway runs outside this container's namespace (#4503)", () => {
      it("reports healthy on curl exit 7 with no in-container gateway process when the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          gatewayCmdline: null,
          gatewayLog: "gateway log line\n",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
      });

      it("reports healthy on curl exit 7 even when no gateway log exists and the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          gatewayCmdline: null,
          gatewayLog: "",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
      });

      it("still reports unhealthy on a wedged listener (curl exit 28) regardless of the marker", () => {
        const probe = runProductionHealthProbe({
          curlExit: 28,
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(1);
      });
    });

    // #4952: OpenClaw can rewrite the gateway argv to a bare process title.
    // Exercise exact NUL-delimited launcher/title shapes against the recorded
    // PID and kernel start identity so unrelated OpenClaw processes cannot
    // keep a dead gateway container healthy.
    describe("matches the re-execed plain-`openclaw` gateway argv (#4952)", () => {
      function runHealthProbe({
        gatewayPid = null,
        gatewayCmdline = nulArgv("openclaw"),
        processPresent = true,
        recordedStart = "12345",
        observedStart = "12345",
        observedStartAfter,
        observedState = "S",
        curlExit = 7,
        gatewayLog = "gateway log line\n",
      }: {
        gatewayPid?: string | null;
        gatewayCmdline?: string | null;
        processPresent?: boolean;
        recordedStart?: string;
        observedStart?: string;
        observedStartAfter?: string;
        observedState?: string;
        curlExit?: number;
        gatewayLog?: string;
      }) {
        const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-argv-"));
        const logPath = path.join(tmp, "gateway.log");
        const markerPath = path.join(tmp, "nemoclaw-gateway-local");
        const pidPath = path.join(tmp, "nemoclaw-gateway.pid");
        const procRoot = path.join(tmp, "proc");
        let identityChangePrelude: string[] = [];
        const command = dockerHealthCommandBetween(
          dockerfile,
          "# Health check: poll the gateway's /health endpoint",
          "ENTRYPOINT",
        )
          .replaceAll("/tmp/gateway.log", logPath)
          .replaceAll("/tmp/nemoclaw-gateway-local", markerPath)
          .replaceAll("/tmp/nemoclaw-gateway.pid", pidPath)
          .replaceAll("/proc/", `${procRoot}/`);

        // Gateway is up and the marker is present: this container runs the
        // in-container gateway, so the liveness fallback is meaningful.
        if (gatewayLog !== "") {
          fs.writeFileSync(logPath, gatewayLog);
        }
        fs.writeFileSync(markerPath, "");
        if (gatewayPid !== null) {
          const statPath = path.join(procRoot, gatewayPid, "stat");
          const cmdlinePath = path.join(procRoot, gatewayPid, "cmdline");
          const changesIdentityDuringCmdline =
            processPresent && gatewayCmdline !== null && observedStartAfter !== undefined;
          fs.writeFileSync(pidPath, `${gatewayPid} ${recordedStart}\n`);
          processPresent && fs.mkdirSync(path.join(procRoot, gatewayPid), { recursive: true });
          processPresent &&
            fs.writeFileSync(
              statPath,
              linuxProcStat(gatewayPid, observedStart, "1", observedState),
            );
          changesIdentityDuringCmdline &&
            expect(spawnSync("mkfifo", [cmdlinePath], { encoding: "utf-8" }).status).toBe(0);
          processPresent &&
            gatewayCmdline !== null &&
            !changesIdentityDuringCmdline &&
            fs.writeFileSync(cmdlinePath, gatewayCmdline);
          identityChangePrelude = changesIdentityDuringCmdline
            ? [
                `python3 -c 'import pathlib,sys; stream = open(sys.argv[1], "wb"); stream.write(bytes.fromhex(sys.argv[2])); stream.flush(); pathlib.Path(sys.argv[3]).write_bytes(bytes.fromhex(sys.argv[4])); stream.close()' ${JSON.stringify(cmdlinePath)} ${Buffer.from(gatewayCmdline ?? "").toString("hex")} ${JSON.stringify(statPath)} ${Buffer.from(linuxProcStat(gatewayPid, observedStartAfter ?? observedStart, "1", observedState)).toString("hex")} &`,
              ]
            : [];
        }

        try {
          return runLoggedDockerShell(command, tmp, [
            ...identityChangePrelude,
            `curl() { printf "curl %s\\n" "$*" >> "$call_log"; return ${curlExit}; }`,
          ]);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }

      it.each([
        ["a bare rewritten title", nulArgv("openclaw")],
        ["the legacy rewritten title", nulArgv("openclaw-gateway")],
        ["a padded rewritten title", "openclaw-gateway\0\0\0"],
        [
          "the direct launcher",
          nulArgv("/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        [
          "the npm-installed Node launcher",
          nulArgv(
            "/usr/local/bin/node",
            "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
            "gateway",
            "run",
            "--port",
            "18789",
          ),
        ],
        [
          "the equals-form gateway port",
          nulArgv("nodejs", "/usr/local/bin/openclaw", "gateway", "run", "--port=18789"),
        ],
      ])("reports healthy for %s", (_label, gatewayCmdline) => {
        const probe = runHealthProbe({ gatewayPid: "4242", gatewayCmdline });
        expect(probe.result.status).toBe(0);
      });

      it("reports unhealthy when no openclaw process is alive and no gateway PID was recorded", () => {
        const probe = runHealthProbe({ gatewayPid: null });
        expect(probe.result.status).toBe(1);
      });

      // The tightening that closes the self-healing gap: an unrelated
      // `openclaw` one-shot is running (a bare `pgrep -x openclaw` would have
      // matched it and falsely reported healthy), but the recorded gateway PID
      // is dead. The container must report unhealthy so Docker restarts it.
      it("reports unhealthy when the recorded gateway PID is dead even if a non-gateway `openclaw` process exists", () => {
        const probe = runHealthProbe({
          gatewayPid: "9999",
          processPresent: false,
        });
        expect(probe.result.status).not.toBe(0);
      });

      it("reports unhealthy when the recorded gateway PID was reused by a non-openclaw process", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          gatewayCmdline: nulArgv("bash"),
        });
        expect(probe.result.status).toBe(1);
      });

      it.each([
        [
          "an unrelated Node script",
          nulArgv("node", "/tmp/openclaw-helper.mjs", "gateway", "run", "--port", "18789"),
        ],
        [
          "a same-basename Node script outside the installed path",
          nulArgv("node", "/tmp/openclaw.mjs", "gateway", "run", "--port", "18789"),
        ],
        [
          "a same-basename direct launcher outside the installed path",
          nulArgv("/tmp/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["a same-basename rewritten title outside the installed path", nulArgv("/tmp/openclaw")],
        [
          "a same-basename Node interpreter outside an installed path",
          nulArgv("/tmp/node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["an OpenClaw one-shot command", nulArgv("openclaw", "agent", "run-task")],
        [
          "an OpenClaw gateway on the wrong port",
          nulArgv(
            "node",
            "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
            "gateway",
            "run",
            "--port",
            "19000",
          ),
        ],
        [
          "a launcher with a trailing empty argument",
          nulArgv("node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789", ""),
        ],
        [
          "an unterminated launcher cmdline",
          unterminatedArgv("node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["an unterminated rewritten title", "openclaw-gateway"],
        ["an empty cmdline", ""],
        ["a missing cmdline", null],
      ])("reports unhealthy for %s", (_label, gatewayCmdline) => {
        const probe = runHealthProbe({ gatewayPid: "4242", gatewayCmdline });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when an OpenClaw-looking reused PID has a different starttime", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          recordedStart: "12345",
          observedStart: "99999",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when the PID identity changes while cmdline is read", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          observedStart: "12345",
          observedStartAfter: "99999",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when the recorded gateway identity is a zombie", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          observedState: "Z",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });
    });
  });

  it("keeps base image non-service probe runtime-only", () => {
    const imageDefinition = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const command = dockerHealthCommandBetween(imageDefinition, "# Baseline health check.");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-probe-"));

    try {
      const probe = runLoggedDockerShell(command, tmp, [
        'curl() { printf "%s\\n" "$*" >> "$call_log"; return 42; }',
      ]);

      expect(probe.result.status).toBe(0);
      expect(probe.calls).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
