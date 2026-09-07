// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadValidatedHarnessManifest } from "../manifest-readers";
import {
  HARNESS_PACKAGE_MANIFEST_MAX_BYTES,
  HARNESS_PACKAGE_METADATA_FILE,
  HARNESS_PACKAGE_METADATA_MAX_BYTES,
  parseHarnessPackageManifest,
} from "./manifest";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-manifest-"));
  temporaryRoots.push(root);
  return root;
}

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion: "1.2.3",
    minimumNemoClawVersion: "0.0.113",
    maximumNemoClawVersionExclusive: "0.0.121",
    manifest: "packages/nemoclaw-openclaw/manifest.yaml",
    ...overrides,
  };
}

function validManifest(
  identity: readonly string[] = ["name: openclaw", "display_name: OpenClaw"],
): string {
  return [
    ...identity,
    "runtime:",
    "  kind: gateway",
    "  interactive_command: openclaw",
    "  process_lifecycle:",
    "    support: unsupported",
    "    reason: This fixture does not manage a gateway process.",
    "gateway_command: openclaw gateway run",
    "health_probe:",
    "  url: http://127.0.0.1:18789/health",
    "  port: 18789",
    "  timeout_seconds: 30",
    "config:",
    "  dir: /sandbox/.openclaw",
    "  config_file: openclaw.json",
    "  format: json",
    "inference:",
    "  config_update:",
    "    support: unsupported",
    "    reason: This synthetic package has fixed inference configuration.",
    "messaging:",
    "  support: disabled",
    "policy:",
    "  owned_presets: []",
    "  automatic_presets: []",
    "  baseline_exclusion_impacts: {}",
    "state_lifecycle:",
    "  backup_quiescence:",
    "    kind: not-required",
    "  snapshot_restore: []",
    "  rebuild:",
    "    managed_extensions:",
    "      support: disabled",
    "      reason: Test package has no managed extensions.",
    "    scheduled_work:",
    "      support: disabled",
    "      reason: This package does not run scheduled work.",
    "    post_restore:",
    "      kind: not-required",
    "",
  ].join("\n");
}

function validManifestWith(additional: readonly string[]): string {
  return `${validManifest().trimEnd()}\n${additional.join("\n")}\n`;
}

function writePackage(
  root: string,
  options: {
    envelope?: Record<string, unknown>;
    manifest?: string | Buffer;
    manifestRelativePath?: string;
    metadata?: string | Buffer;
  } = {},
): void {
  const envelope = options.envelope ?? validEnvelope();
  const manifestPath = path.join(
    root,
    ...(options.manifestRelativePath ?? "packages/nemoclaw-openclaw/manifest.yaml").split("/"),
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    path.join(root, HARNESS_PACKAGE_METADATA_FILE),
    options.metadata ?? `${JSON.stringify(envelope)}\n`,
  );
  fs.writeFileSync(manifestPath, options.manifest ?? validManifest());
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("parseHarnessPackageManifest", () => {
  it("gives source packages and installed receipts the same validated manifest", () => {
    const root = makeRoot();
    writePackage(root);

    const installed = parseHarnessPackageManifest(root);
    const source = loadValidatedHarnessManifest(installed.manifestPath, installed.envelope.id);

    expect(source).toEqual(installed.manifest);
  });

  it("rejects the same unknown field from source packages and installed receipts", () => {
    const root = makeRoot();
    writePackage(root, { manifest: validManifestWith(["native_hook: callback"]) });
    const manifestPath = path.join(root, "packages/nemoclaw-openclaw/manifest.yaml");

    const rejectionMessage = (load: () => unknown): string => {
      try {
        load();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("Malformed manifest unexpectedly passed validation");
    };
    const sourceMessage = rejectionMessage(() =>
      loadValidatedHarnessManifest(manifestPath, "openclaw"),
    );
    const receiptMessage = rejectionMessage(() => parseHarnessPackageManifest(root));

    expect(sourceMessage).toContain("Harness manifest field '<root>'");
    expect(sourceMessage).toBe(receiptMessage);
  });

  it("does not admit repository-only legacy fields through either package path", () => {
    const root = makeRoot();
    writePackage(root, {
      manifest: validManifestWith(["_legacy_paths:", "  dockerfile: agents/openclaw/Dockerfile"]),
    });
    const manifestPath = path.join(root, "packages/nemoclaw-openclaw/manifest.yaml");

    expect(() => loadValidatedHarnessManifest(manifestPath, "openclaw")).toThrow(
      "Harness manifest field '<root>'",
    );
    expect(() => parseHarnessPackageManifest(root)).toThrow("Harness manifest field '<root>'");
  });

  it("returns the exact package envelope and manifest data without building an agent", () => {
    const root = makeRoot();
    writePackage(root, {
      envelope: validEnvelope({ packageVersion: "1.2.3-rc.1+build.9" }),
    });

    const result = parseHarnessPackageManifest(root);

    expect(result.envelope).toEqual({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "1.2.3-rc.1+build.9",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-openclaw/manifest.yaml",
    });
    expect(result.manifest.name).toBe("openclaw");
    expect(result.packageRoot).toBe(path.resolve(root));
    expect(result.manifestPath).toBe(
      path.join(root, "packages", "nemoclaw-openclaw", "manifest.yaml"),
    );
    expect(result).not.toHaveProperty("agentDir");
    expect(result).not.toHaveProperty("displayName");
  });

  it.each([
    ["missing maximum", undefined],
    ["malformed maximum", "0.0"],
    ["maximum equal to minimum", "0.0.113"],
    ["maximum below minimum", "0.0.112"],
  ])("rejects %s", (_label, maximumNemoClawVersionExclusive) => {
    const root = makeRoot();
    const envelope = validEnvelope();
    maximumNemoClawVersionExclusive === undefined
      ? Reflect.deleteProperty(envelope, "maximumNemoClawVersionExclusive")
      : Object.assign(envelope, { maximumNemoClawVersionExclusive });
    writePackage(root, { envelope });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      /metadata fields|maximumNemoClawVersionExclusive/u,
    );
  });

  it.each([
    {
      name: "a terminal runtime without a command",
      manifest: validManifest().replace(
        "runtime:\n  kind: gateway\n  interactive_command: openclaw",
        "runtime:\n  kind: terminal",
      ),
      field: "runtime",
    },
    {
      name: "unsafe description text",
      manifest: validManifestWith(["description: ' leading space'"]),
      field: "description",
    },
    {
      name: "an absolute configuration file",
      manifest: validManifest().replace(
        "  config_file: openclaw.json",
        "  config_file: /sandbox/openclaw.json",
      ),
      field: "config.config_file",
    },
    {
      name: "an incomplete mutable inference declaration",
      manifest: validManifest().replace(
        [
          "    support: unsupported",
          "    reason: This synthetic package has fixed inference configuration.",
        ].join("\n"),
        "    support: mutable",
      ),
      field: "inference.config_update",
    },
    {
      name: "an MCP bridge without policy binaries",
      manifest: validManifestWith(["mcp:", "  support: bridge", "  adapter: openclaw"]),
      field: "mcp.policy_binaries",
    },
    {
      name: "an empty messaging channel declaration",
      manifest: validManifest().replace(
        ["messaging:", "  support: disabled"].join("\n"),
        ["messaging:", "  support: channels", "  channels: []"].join("\n"),
      ),
      field: "messaging.channels",
    },
    {
      name: "an unsupported session operation",
      manifest: validManifestWith(["sessions:", "  operations:", "    - launch"]),
      field: "sessions.operations",
    },
    {
      name: "a root managed-image identity",
      manifest: validManifestWith([
        "managed_image:",
        "  repository: ghcr.io/example/openclaw",
        "  architectures:",
        "    - linux/amd64",
        "  runtime_identity:",
        "    uid: 0",
        "    gid: 1000",
        "    workdir: /sandbox",
      ]),
      field: "managed_image.runtime_identity.uid",
    },
    {
      name: "an enum restore key without values",
      manifest: validManifestWith([
        "state_files:",
        "  - path: config.json",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: feature.mode",
        "          type: enum",
      ]),
      field: "state_files[0].restore.user_keys[0].values",
    },
    {
      name: "an agent timeout option outside value options",
      manifest: validManifest().replace(
        "runtime:\n  kind: gateway",
        [
          "runtime:",
          "  kind: gateway",
          "  agent_command:",
          "    argv: [openclaw, agent]",
          "    output_mode: bounded-text",
          "    value_options: [--message]",
          "    timeout_option: --timeout",
        ].join("\n"),
      ),
      field: "runtime.agent_command.timeout_option",
    },
    {
      name: "duplicate agent command arguments",
      manifest: validManifest().replace(
        "runtime:\n  kind: gateway",
        [
          "runtime:",
          "  kind: gateway",
          "  agent_command:",
          "    argv: [openclaw, openclaw]",
          "    output_mode: direct",
        ].join("\n"),
      ),
      field: "runtime.agent_command.argv",
    },
    {
      name: "a privileged forwarded port",
      manifest: validManifestWith(["forward_ports: [80]"]),
      field: "forward_ports[0]",
    },
  ])("rejects $name through the shared semantic contract", ({ manifest, field }) => {
    const root = makeRoot();
    writePackage(root, { manifest });

    expect(() => parseHarnessPackageManifest(root)).toThrow(`Harness manifest field '${field}'`);
  });

  it.each([
    {
      name: "an unknown runtime field",
      manifest: validManifest().replace(
        "  kind: gateway",
        "  kind: gateway\n  native_hook: callback",
      ),
      field: "runtime",
    },
    {
      name: "an unknown config field",
      manifest: validManifest().replace(
        "  format: json",
        "  format: json\n  native_writer: callback",
      ),
      field: "config",
    },
    {
      name: "a health probe without its URL",
      manifest: validManifest().replace(
        [
          "health_probe:",
          "  url: http://127.0.0.1:18789/health",
          "  port: 18789",
          "  timeout_seconds: 30",
        ].join("\n"),
        ["health_probe:", "  port: 8080", "  timeout_seconds: 30"].join("\n"),
      ),
      field: "health_probe.url",
    },
    {
      name: "a package registry without its binary",
      manifest: validManifestWith(["package_registry:", "  hosts:", "    - registry.example.test"]),
      field: "package_registry.binary",
    },
  ])("rejects $name at the core package boundary", ({ manifest, field }) => {
    const root = makeRoot();
    writePackage(root, { manifest });

    expect(() => parseHarnessPackageManifest(root)).toThrow(`Harness manifest field '${field}'`);
  });

  it.each([
    ["schema version", { schemaVersion: 2 }, "schemaVersion must be 1"],
    ["package kind", { kind: "host-plugin" }, "kind must be agent-runtime"],
  ])("rejects an unsupported %s", (_label, overrides, message) => {
    const root = makeRoot();
    writePackage(root, { envelope: validEnvelope(overrides) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(message);
  });

  it.each(["entryPoint", "callback", "hostModule", "main"])(
    "rejects the executable extension field %s",
    (field) => {
      const root = makeRoot();
      writePackage(root, { envelope: validEnvelope({ [field]: "payload.js" }) });

      expect(() => parseHarnessPackageManifest(root)).toThrow(
        "metadata fields do not match schema version 1",
      );
    },
  );

  it.each(['"id":"openclaw","id":"hermes"', '"\\u0069d":"openclaw","id":"hermes"'])(
    "rejects the duplicate JSON member sequence %s",
    (duplicateMembers) => {
      const root = makeRoot();
      writePackage(root, {
        metadata: `{"schemaVersion":1,"kind":"agent-runtime",${duplicateMembers},"displayName":"OpenClaw","packageVersion":"1.2.3","minimumNemoClawVersion":"0.0.113","manifest":"packages/nemoclaw-openclaw/manifest.yaml"}`,
      });

      expect(() => parseHarnessPackageManifest(root)).toThrow(
        "metadata must not contain duplicate fields",
      );
    },
  );

  it("does not reflect an unsupported metadata key in the diagnostic", () => {
    const root = makeRoot();
    const hostileKey = "apiKey\u001b[31mSECRET";
    writePackage(root, { envelope: validEnvelope({ [hostileKey]: "sensitive-value" }) });

    let message = "";
    try {
      parseHarnessPackageManifest(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Harness package metadata fields do not match schema version 1");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("\u001b");
  });

  it.each([
    "",
    "OpenClaw",
    "-openclaw",
    "openclaw-",
    "open--claw",
    "open_claw",
    `a${"b".repeat(63)}`,
    "open\u202eclaw",
  ])("rejects the non-canonical package id %j", (id) => {
    const root = makeRoot();
    writePackage(root, { envelope: validEnvelope({ id }) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      "id must be a lowercase hyphen-separated identifier",
    );
  });

  it.each([
    "",
    " OpenClaw",
    "OpenClaw ",
    "Open\nClaw",
    "Open\u202eClaw",
    "Open\ud800Claw",
    "x".repeat(129),
  ])("rejects the invalid display name %j", (displayName) => {
    const root = makeRoot();
    writePackage(root, { envelope: validEnvelope({ displayName }) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      "displayName must be bounded text without control characters",
    );
  });

  it.each([
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3+",
    `1.2.3+${"x".repeat(123)}`,
  ])("rejects the non-canonical package version %j", (packageVersion) => {
    const root = makeRoot();
    writePackage(root, { envelope: validEnvelope({ packageVersion }) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      "packageVersion must be a canonical SemVer version",
    );
  });

  it.each([
    "",
    "/packages/nemoclaw-openclaw/manifest.yaml",
    "../manifest.yaml",
    "agents/../manifest.yaml",
    "agents//manifest.yaml",
    "./agents/manifest.yaml",
    "agents\\openclaw\\manifest.yaml",
    "C:/packages/nemoclaw-openclaw/manifest.yaml",
    "packages/nemoclaw-openclaw/manifest.yaml:stream",
    "agents/con/manifest.yaml",
    "agents/AUX.txt/manifest.yaml",
    "packages/nemoclaw-openclaw./manifest.yaml",
    "packages/nemoclaw-openclaw /manifest.yaml",
    "agents/ openclaw/manifest.yaml",
    'agents/open"claw/manifest.yaml',
    "agents/cafe\u0301/manifest.yaml",
    `${Array.from({ length: 32 }, () => "nested").join("/")}/manifest.yaml`,
    `${"a".repeat(255)}/${"b".repeat(255)}/cc`,
    "packages/nemoclaw-openclaw/manifest.yaml\u0000",
    "agents/open\u202eclaw/manifest.yaml",
  ])("rejects the unsafe manifest path %j without reflecting it", (manifest) => {
    const root = makeRoot();
    writePackage(root, { envelope: validEnvelope({ manifest }) });

    let message = "";
    try {
      parseHarnessPackageManifest(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Harness package manifest must be a canonical relative path");
    expect(message).not.toContain(manifest || "<empty hostile manifest path>");
  });

  it("accepts the manifest path depth and byte boundaries", () => {
    const depthRoot = makeRoot();
    const depthPath = `${Array.from({ length: 31 }, (_entry, index) => `d${String(index)}`).join("/")}/manifest.yaml`;
    writePackage(depthRoot, {
      envelope: validEnvelope({ manifest: depthPath }),
      manifestRelativePath: depthPath,
    });
    expect(() => parseHarnessPackageManifest(depthRoot)).not.toThrow();

    const byteRoot = makeRoot();
    const bytePath = `${"a".repeat(255)}/${"b".repeat(254)}/c`;
    expect(Buffer.byteLength(bytePath, "utf8")).toBe(512);
    writePackage(byteRoot, {
      envelope: validEnvelope({ manifest: bytePath }),
      manifestRelativePath: bytePath,
    });
    expect(() => parseHarnessPackageManifest(byteRoot)).not.toThrow();
  });

  it("enforces the metadata byte boundary", () => {
    const acceptedRoot = makeRoot();
    const encoded = JSON.stringify(validEnvelope());
    writePackage(acceptedRoot, {
      metadata: `${encoded}${" ".repeat(HARNESS_PACKAGE_METADATA_MAX_BYTES - encoded.length)}`,
    });
    expect(() => parseHarnessPackageManifest(acceptedRoot)).not.toThrow();

    const rejectedRoot = makeRoot();
    writePackage(rejectedRoot, {
      metadata: Buffer.alloc(HARNESS_PACKAGE_METADATA_MAX_BYTES + 1, 0x20),
    });
    expect(() => parseHarnessPackageManifest(rejectedRoot)).toThrow(
      "metadata exceeds its read boundary",
    );
  });

  it("enforces the manifest byte boundary", () => {
    const acceptedRoot = makeRoot();
    const manifestPrefix = `${validManifest()}#`;
    writePackage(acceptedRoot, {
      manifest: `${manifestPrefix}${" ".repeat(HARNESS_PACKAGE_MANIFEST_MAX_BYTES - manifestPrefix.length)}`,
    });
    expect(() => parseHarnessPackageManifest(acceptedRoot)).not.toThrow();

    const rejectedRoot = makeRoot();
    writePackage(rejectedRoot, {
      manifest: Buffer.alloc(HARNESS_PACKAGE_MANIFEST_MAX_BYTES + 1, 0x20),
    });
    expect(() => parseHarnessPackageManifest(rejectedRoot)).toThrow(
      "manifest exceeds its read boundary",
    );
  });

  it.each(["metadata", "manifest"])("rejects invalid UTF-8 in the %s file", (target) => {
    const root = makeRoot();
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    writePackage(
      root,
      target === "metadata" ? { metadata: invalidUtf8 } : { manifest: invalidUtf8 },
    );

    expect(() => parseHarnessPackageManifest(root)).toThrow(`${target} must contain valid UTF-8`);
  });

  it("rejects YAML aliases and duplicate keys", () => {
    const aliasRoot = makeRoot();
    writePackage(aliasRoot, { manifest: "name: &agent openclaw\ncopy: *agent\n" });
    expect(() => parseHarnessPackageManifest(aliasRoot)).toThrow("cannot use YAML aliases");

    const duplicateRoot = makeRoot();
    writePackage(duplicateRoot, { manifest: "name: openclaw\nname: openclaw\n" });
    expect(() => parseHarnessPackageManifest(duplicateRoot)).toThrow("must contain valid YAML");
  });

  it.each([
    ["display_name", '"Open\\u001b[31mClaw"'],
    ["display_name", '"Open\\u202eClaw"'],
    ["description", '"Agent\\u000aDescription"'],
    ["description", '"Agent\\u2066Description"'],
  ])("rejects escaped terminal controls in manifest %s", (field, value) => {
    const root = makeRoot();
    writePackage(root, { manifest: validManifest(["name: openclaw", `${field}: ${value}`]) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      `Harness manifest field '${field}' must be bounded terminal-safe text`,
    );
  });

  it.each([
    ["display_name", "7"],
    ["display_name", JSON.stringify("x".repeat(129))],
    ["description", "false"],
    ["description", JSON.stringify("x".repeat(2049))],
  ])("rejects invalid or oversized manifest %s", (field, value) => {
    const root = makeRoot();
    writePackage(root, { manifest: validManifest(["name: openclaw", `${field}: ${value}`]) });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      `Harness manifest field '${field}' must be bounded terminal-safe text`,
    );
  });

  it("accepts the manifest display text boundaries", () => {
    const root = makeRoot();
    const displayName = "😀".repeat(128);
    const description = "x".repeat(2048);
    expect(Buffer.byteLength(displayName, "utf8")).toBe(512);
    writePackage(root, {
      manifest: validManifest([
        "name: openclaw",
        `display_name: ${JSON.stringify(displayName)}`,
        `description: ${JSON.stringify(description)}`,
      ]),
    });

    expect(() => parseHarnessPackageManifest(root)).not.toThrow();
  });

  it.each([
    ["a sequence", "- openclaw\n"],
    ["a missing name", "display_name: OpenClaw\n"],
    ["a non-string name", "name: 7\n"],
    ["a different name", "name: hermes\n"],
  ])("rejects manifest identity from %s", (_label, manifest) => {
    const root = makeRoot();
    writePackage(root, { manifest });

    expect(() => parseHarnessPackageManifest(root)).toThrow(/YAML mapping|name must match/);
  });

  it.each(["metadata", "manifest"])("rejects a linked %s file", (target) => {
    const root = makeRoot();
    writePackage(root);
    const targetPath =
      target === "metadata"
        ? path.join(root, HARNESS_PACKAGE_METADATA_FILE)
        : path.join(root, "packages", "nemoclaw-openclaw", "manifest.yaml");
    const outside = path.join(root, `outside-${target}.txt`);
    fs.renameSync(targetPath, outside);
    fs.symlinkSync(outside, targetPath);

    expect(() => parseHarnessPackageManifest(root)).toThrow(`${target} must be one regular file`);
  });

  it.each(["metadata", "manifest"])("rejects a hard-linked %s file", (target) => {
    const root = makeRoot();
    writePackage(root);
    const targetPath =
      target === "metadata"
        ? path.join(root, HARNESS_PACKAGE_METADATA_FILE)
        : path.join(root, "packages", "nemoclaw-openclaw", "manifest.yaml");
    fs.linkSync(targetPath, path.join(root, `${target}-hard-link`));

    expect(() => parseHarnessPackageManifest(root)).toThrow(`${target} must be one regular file`);
  });

  it("rejects a symbolic-link package root", () => {
    const realRoot = makeRoot();
    writePackage(realRoot);
    const linkContainer = makeRoot();
    const linkedRoot = path.join(linkContainer, "linked-package");
    fs.symlinkSync(realRoot, linkedRoot, "dir");

    expect(() => parseHarnessPackageManifest(linkedRoot)).toThrow(
      "Harness package root authority is invalid",
    );
  });

  it("rejects a symbolic-link manifest directory", () => {
    const root = makeRoot();
    writePackage(root, {
      envelope: validEnvelope({ manifest: "linked/manifest.yaml" }),
    });
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "manifest.yaml"), "name: openclaw\n");
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      "Harness package manifest directory authority is invalid",
    );
  });

  it("does not execute package content", () => {
    const root = makeRoot();
    const marker = path.join(root, "executed");
    writePackage(root);
    fs.writeFileSync(
      path.join(root, "payload.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`,
    );

    parseHarnessPackageManifest(root);

    expect(fs.existsSync(marker)).toBe(false);
  });
});
