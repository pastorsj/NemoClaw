// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractOpenClawBootstrapEnvSnippet,
  extractProxyVarsSnippet,
  extractRuntimeShellEnvShimSnippet,
  extractRuntimeShellEnvSnippet,
  extractToolRedirectsSnippet,
  rcShimWrapperHeader,
} from "../helpers/service-env";
import { readOpenClawStartupSource } from "../helpers/startup";

const ROOT_TEST_DIRECTORY = join(import.meta.dirname, "../../../..", "test");

describe("OpenClaw service environment", () => {
  describe("OpenClaw EC2 metadata discovery", () => {
    it("overrides ambient and sandbox-create wrapper false values before startup", () => {
      const tmpFile = join(tmpdir(), `nemoclaw-imds-bootstrap-${process.pid}.sh`);
      try {
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "set -- env AWS_EC2_METADATA_DISABLED=false nemoclaw-start openclaw agent",
          extractOpenClawBootstrapEnvSnippet(),
          'printf "%s\\n" "$AWS_EC2_METADATA_DISABLED"',
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });

        const out = execFileSync("bash", [tmpFile], {
          encoding: "utf-8",
          env: { ...process.env, AWS_EC2_METADATA_DISABLED: "false" },
        });
        expect(out.trim()).toBe("true");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("GIT_SSL_CAINFO for proxy CA trust (#2270)", () => {
    const sandboxInitSource = `source ${JSON.stringify(join(ROOT_TEST_DIRECTORY, "../scripts/lib/sandbox-init.sh"))}`;

    it("entrypoint exports GIT_SSL_CAINFO when SSL_CERT_FILE points to a real file", () => {
      const src = readOpenClawStartupSource();
      const start = src.indexOf("# Git TLS CA bundle fix");
      const end = src.indexOf("# HTTP library + NODE_USE_ENV_PROXY", start);
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Failed to extract SSL_CERT_FILE handling block");
      }

      const fakeDir = mkdtempSync(join(tmpdir(), "nemoclaw-git-ssl-entrypoint-"));
      const fakeCaBundle = join(fakeDir, "ca-bundle.pem");
      const tmpFile = join(tmpdir(), `nemoclaw-git-ssl-entrypoint-${process.pid}.sh`);
      try {
        writeFileSync(
          fakeCaBundle,
          "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        );
        writeFileSync(
          tmpFile,
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            `export SSL_CERT_FILE=${JSON.stringify(fakeCaBundle)}`,
            src.slice(start, end),
            'printf "%s" "${GIT_SSL_CAINFO:-}"',
          ].join("\n"),
          { mode: 0o700 },
        );

        const output = execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        expect(output).toBe(fakeCaBundle);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          rmSync(fakeDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("proxy-env.sh includes GIT_SSL_CAINFO when set", () => {
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-git-ssl-test-"));
      const fakeCaBundle = join(fakeDataDir, "ca-bundle.pem");
      const tmpFile = join(fakeDataDir, "git-ssl-env.sh");
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        // Create a fake CA bundle so the -f check passes
        writeFileSync(
          fakeCaBundle,
          "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        );
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          "_TOOL_REDIRECTS=()",
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
          // Simulate OpenShell injecting SSL_CERT_FILE and the entrypoint setting GIT_SSL_CAINFO
          `export SSL_CERT_FILE="${fakeCaBundle}"`,
          `export GIT_SSL_CAINFO="${fakeCaBundle}"`,
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).toContain("GIT_SSL_CAINFO");
        expect(envFile).toContain(fakeCaBundle);
      } finally {
        try {
          rmSync(fakeDataDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("proxy-env.sh omits GIT_SSL_CAINFO when not set", () => {
      const fakeDataDir = join(tmpdir(), `nemoclaw-git-ssl-noop-test-${process.pid}`);
      mkdirSync(fakeDataDir, { recursive: true });
      const tmpFile = join(tmpdir(), `nemoclaw-git-ssl-noop-env-${process.pid}.sh`);
      try {
        const persistBlock = extractRuntimeShellEnvSnippet();
        const wrapper = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          sandboxInitSource,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          "_TOOL_REDIRECTS=()",
          `_AXIOS_FIX_SCRIPT="/nonexistent/axios-proxy-fix.js"`,
          // GIT_SSL_CAINFO intentionally NOT set
          "set +u  # array expansion safe on macOS bash",
          persistBlock
            .trimEnd()
            .replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        execFileSync("bash", [tmpFile], { encoding: "utf-8" });

        const envFile = readFileSync(join(fakeDataDir, "proxy-env.sh"), "utf-8");
        expect(envFile).not.toContain("GIT_SSL_CAINFO");
      } finally {
        try {
          rmSync(fakeDataDir, { recursive: true, force: true });
          rmSync(tmpFile, { force: true });
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("runtime npm online state", () => {
    it("entrypoint exports npm_config_offline=false and NPM_CONFIG_OFFLINE=false at PID 1", () => {
      const src = readOpenClawStartupSource();
      const start = src.indexOf("_TOOL_REDIRECTS=(");
      const end = src.indexOf("done", src.indexOf("for _redir", start));
      if (start === -1 || end === -1 || end <= start) {
        throw new Error(
          "Failed to extract _TOOL_REDIRECTS block from packages/nemoclaw-openclaw/start.sh",
        );
      }
      const block = `${src.slice(start, end)}done`;
      const tmpFile = join(tmpdir(), `nemoclaw-tool-redirects-npm-online-${process.pid}.sh`);
      try {
        writeFileSync(
          tmpFile,
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            block,
            'printf "npm_config_offline=%s\\n" "${npm_config_offline:-unset}"',
            'printf "NPM_CONFIG_OFFLINE=%s\\n" "${NPM_CONFIG_OFFLINE:-unset}"',
          ].join("\n"),
          { mode: 0o700 },
        );
        const out = execFileSync("bash", [tmpFile], { encoding: "utf-8" });
        expect(out).toContain("npm_config_offline=false");
        expect(out).toContain("NPM_CONFIG_OFFLINE=false");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    });

    it("a sandbox-connect shell sourcing the emitted proxy-env reports both npm offline env vars as false", () => {
      const persistBlock = extractRuntimeShellEnvSnippet();
      const toolRedirects = extractToolRedirectsSnippet();
      const sandboxInitSource = `source ${JSON.stringify(join(ROOT_TEST_DIRECTORY, "../scripts/lib/sandbox-init.sh"))}`;
      const fakeDataDir = mkdtempSync(join(tmpdir(), "nemoclaw-connect-npm-online-"));
      const tmpFile = join(tmpdir(), `nemoclaw-connect-npm-online-${process.pid}.sh`);
      try {
        const wrapper = [
          "#!/usr/bin/env bash",
          sandboxInitSource,
          toolRedirects,
          'PROXY_HOST="10.200.0.1"',
          'PROXY_PORT="3128"',
          '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
          '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
          'export OPENCLAW_GATEWAY_TOKEN="probe-token"',
          persistBlock.replaceAll("/tmp/nemoclaw-proxy-env.sh", `${fakeDataDir}/proxy-env.sh`),
          `env -i HOME=/tmp bash --noprofile --norc -c 'source ${fakeDataDir}/proxy-env.sh; printf "%s\\n" "$npm_config_offline" "$NPM_CONFIG_OFFLINE"'`,
        ].join("\n");
        writeFileSync(tmpFile, wrapper, { mode: 0o700 });
        const out = execFileSync("bash", [tmpFile], { encoding: "utf-8" }).trim();
        expect(out.split("\n")).toEqual(["false", "false"]);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        try {
          rmSync(fakeDataDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  });
});
