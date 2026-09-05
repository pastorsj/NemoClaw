// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    manifest: "packages/nemoclaw-openclaw/manifest.yaml",
    ...overrides,
  };
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
  fs.writeFileSync(manifestPath, options.manifest ?? "name: openclaw\ndisplay_name: OpenClaw\n");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("parseHarnessPackageManifest", () => {
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
    const manifestPrefix = "name: openclaw\n#";
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
    writePackage(root, { manifest: `name: openclaw\n${field}: ${value}\n` });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      `manifest ${field} must be bounded terminal-safe text`,
    );
  });

  it.each([
    ["display_name", "7"],
    ["display_name", JSON.stringify("x".repeat(129))],
    ["description", "false"],
    ["description", JSON.stringify("x".repeat(2049))],
  ])("rejects invalid or oversized manifest %s", (field, value) => {
    const root = makeRoot();
    writePackage(root, { manifest: `name: openclaw\n${field}: ${value}\n` });

    expect(() => parseHarnessPackageManifest(root)).toThrow(
      `manifest ${field} must be bounded terminal-safe text`,
    );
  });

  it("accepts the manifest display text boundaries", () => {
    const root = makeRoot();
    const displayName = "😀".repeat(128);
    const description = "x".repeat(2048);
    expect(Buffer.byteLength(displayName, "utf8")).toBe(512);
    writePackage(root, {
      manifest: `name: openclaw\ndisplay_name: ${JSON.stringify(displayName)}\ndescription: ${JSON.stringify(description)}\n`,
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
