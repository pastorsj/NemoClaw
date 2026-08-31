// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
const NEMOCLAW_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PRELOAD_SOURCE = path.join(
  NEMOCLAW_ROOT,
  "src",
  "lib",
  "messaging",
  "channels",
  "whatsapp",
  "runtime",
  "whatsapp-qr-compact.ts",
);

// The WhatsApp pairing QR is rendered by the `qrcode` package (bundled inside
// `openclaw`), NOT `qrcode-terminal`. The plugin's onQr callback calls
// renderQrTerminal() → qrcode.toString(text, { type: "terminal", small }) and
// the bundled @openclaw/whatsapp passes NO `small`, so it defaults to full
// size. These tests prove the preload intercepts that real package shape and
// renders via qrcode.create() with a four-module quiet zone. End-to-
// end proof that this shrinks a *real* rendered QR lives in
// test/e2e/live/whatsapp-qr-compact.test.ts, which drives the actual
// upstream renderer at the version bundled in Dockerfile.base. Ref: NemoClaw#4522.

// A fake `qrcode` package (toString + create — the shape the preload keys on)
// and a fake `qrcode-terminal` (generate). Each records the options it was
// called with so we can assert exactly what the preload forwarded, without
// depending on a real renderer or on network installs.
function writeFakeModules(root: string): void {
  const qrcodeDir = path.join(root, "node_modules", "qrcode");
  fs.mkdirSync(qrcodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(qrcodeDir, "package.json"),
    JSON.stringify({ name: "qrcode", version: "0.0.0-fake", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(qrcodeDir, "index.js"),
    [
      "const calls = [];",
      "const createCalls = [];",
      "const dataUrlCalls = [];",
      "module.exports = {",
      "  // qrcode's real signatures: toString(text, [opts], [cb]).",
      "  toString(text, opts, cb) {",
      "    if (typeof opts === 'function') { cb = opts; opts = undefined; }",
      "    calls.push(opts || {});",
      "    const out = JSON.stringify(opts || {});",
      "    if (typeof cb === 'function') return cb(null, out);",
      "    return Promise.resolve(out);",
      "  },",
      "  // Presence of create() is how the preload distinguishes qrcode from",
      "  // qrcode-terminal. The preload uses it for patched terminal renders.",
      "  create(text, opts) {",
      "    createCalls.push(opts || {});",
      "    return { modules: { size: 2, data: [true, false, false, true] } };",
      "  },",
      "  toDataURL(text) {",
      "    dataUrlCalls.push(text);",
      "    return Promise.resolve(`data:image/png;base64,STUB(${text})`);",
      "  },",
      "  __calls: calls,",
      "  __createCalls: createCalls,",
      "  __dataUrlCalls: dataUrlCalls,",
      "};",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(root, "openclaw-qr-terminal.mjs"),
    [
      'const qrCodeRuntimeLoader = { load: async () => (await import("qrcode")).default ?? (await import("qrcode")) };',
      "async function loadQrCodeRuntime() {",
      "  return await qrCodeRuntimeLoader.load();",
      "}",
      "function normalizeQrText(text) {",
      "  if (typeof text !== 'string') throw new TypeError('QR text must be a string.');",
      "  return text;",
      "}",
      "const COMPACT_MARGIN_MODULES = 1;",
      "function renderCompactTerminalQr(modules) {",
      "  return `compact-margin:${COMPACT_MARGIN_MODULES}:size:${modules.size}`;",
      "}",
      "async function renderQrTerminal(input, opts = {}) {",
      "  const text = normalizeQrText(input);",
      "  const qrCode = await loadQrCodeRuntime();",
      "  if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text).modules);",
      "  return await qrCode.toString(text, {",
      "    small: false,",
      "    type: 'terminal'",
      "  });",
      "}",
      "export { renderQrTerminal };",
    ].join("\n"),
  );

  const termDir = path.join(root, "node_modules", "qrcode-terminal");
  fs.mkdirSync(termDir, { recursive: true });
  fs.writeFileSync(
    path.join(termDir, "package.json"),
    JSON.stringify({ name: "qrcode-terminal", version: "0.0.0-fake", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(termDir, "index.js"),
    [
      "const calls = [];",
      "module.exports = {",
      "  generate(text, opts, cb) {",
      "    if (typeof opts === 'function') { cb = opts; opts = undefined; }",
      "    calls.push(opts || {});",
      "    if (typeof cb === 'function') return cb('rendered');",
      "  },",
      "  setErrorLevel() {},",
      "  __calls: calls,",
      "};",
    ].join("\n"),
  );
}

// Run a probe script under a temp project that has the fake modules installed,
// with the preload loaded via --require. Returns the parsed JSON the probe
// prints to stdout.
function runProbe(probe: string, opts: { withPreload?: boolean } = {}): any {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-qr-unit-"));
  try {
    writeFakeModules(tempDir);
    const probePath = path.join(tempDir, "probe.mjs");
    fs.writeFileSync(probePath, probe);
    const args = opts.withPreload ? ["--require", PRELOAD_SOURCE, probePath] : [probePath];
    const r = spawnSync(process.execPath, args, {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`probe failed (status=${r.status}): ${r.stderr}`);
    }
    return JSON.parse(r.stdout.trim());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Exercise the real require + dynamic-import entry points the OpenClaw renderer
// uses, capturing the options each toString/generate call actually received.
const QRCODE_PROBE = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const result = {};

// 1) CommonJS require loads the package through the preload's Module._load
// hook. The OpenClaw renderer's dynamic import then observes the same CJS
// module object through Node's interoperability cache.
const cjs = require("qrcode");
const dyn = (await import("qrcode")).default ?? (await import("qrcode"));
await dyn.toString("payload", { type: "terminal" });           // login default
await dyn.toString("payload", { type: "terminal", small: false }); // explicit big
await dyn.toString("payload", { type: "terminal", small: true });  // already small
await dyn.toString("payload", { type: "svg" });                // non-terminal
await dyn.toString("payload");                                 // no opts at all
result.qrcode = dyn.__calls;
result.qrcodeCreate = dyn.__createCalls;

result.qrcodeRequireIsPatched = cjs.__calls === dyn.__calls;

// 2) qrcode-terminal fallback path (for any agent that renders through it).
const term = require("qrcode-terminal");
term.generate("payload", { small: false }, () => {});
term.generate("payload", () => {});
result.qrcodeTerminal = term.__calls;

process.stdout.write(JSON.stringify(result));
`;

const OPENCLAW_QR_RENDERER_PROBE = `
const result = {};
const renderer = await import("./openclaw-qr-terminal.mjs");
result.compact = await renderer.renderQrTerminal("payload", { small: true });
const dyn = (await import("qrcode")).default ?? (await import("qrcode"));
result.qrcodeCreate = dyn.__createCalls;
result.qrcodeDataUrl = dyn.__dataUrlCalls;
process.stdout.write(JSON.stringify(result));
`;

describe("WhatsApp compact-QR preload (qrcode package)", () => {
  const baseline = runProbe(QRCODE_PROBE, { withPreload: false });
  const patched = runProbe(QRCODE_PROBE, { withPreload: true });

  it("baseline leaves the qrcode terminal render at full size", () => {
    // Sanity check the fixture: without the preload, a terminal render with no
    // `small` (the reporter's path) is NOT forced small.
    expect(baseline.qrcode[0]).toEqual({ type: "terminal" });
    expect(baseline.qrcode[0].small).toBeUndefined();
  });

  it("renders terminal output through qrcode.create instead of qrcode.toString small mode", () => {
    expect(patched.qrcodeCreate).toEqual([{}, {}, {}]);
    expect(patched.qrcode).toEqual([{ type: "svg" }, {}]);
  });

  it("keeps explicit small:false terminal renders on the custom compact path", () => {
    expect(patched.qrcodeCreate[1]).toEqual({});
  });

  it("keeps already-compact terminal renders on the custom compact path", () => {
    expect(patched.qrcodeCreate[2]).toEqual({});
  });

  it("does NOT touch non-terminal renders (svg/png/utf8 data URIs)", () => {
    // svg render — small must not be injected; other channels/flows rely on it.
    expect(patched.qrcode[0]).toEqual({ type: "svg" });
    expect(patched.qrcode[0].small).toBeUndefined();
  });

  it("does NOT inject small when no type is given (defaults to non-terminal)", () => {
    expect(patched.qrcode[1]).toEqual({});
  });

  it("patches the same module object for require() and dynamic import()", () => {
    expect(patched.qrcodeRequireIsPatched).toBe(true);
  });

  it("also forces small:true on the qrcode-terminal generate() fallback", () => {
    expect(patched.qrcodeTerminal[0]).toEqual({ small: true });
    expect(patched.qrcodeTerminal[1]).toEqual({ small: true });
  });

  it("does not source-patch an unreviewed OpenClaw-looking renderer", () => {
    const baselineRenderer = runProbe(OPENCLAW_QR_RENDERER_PROBE, { withPreload: false });
    const patchedRenderer = runProbe(OPENCLAW_QR_RENDERER_PROBE, { withPreload: true });

    expect(baselineRenderer.compact).toBe("compact-margin:1:size:2");
    expect(baselineRenderer.qrcodeDataUrl).toEqual([]);
    expect(patchedRenderer.compact).toBe("compact-margin:1:size:2");
    expect(patchedRenderer.compact).not.toContain("data:image/png");
    expect(patchedRenderer.qrcodeDataUrl).toEqual([]);
  });

  it("is idempotent when the preload is required twice", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-qr-unit-twice-"));
    try {
      writeFakeModules(tempDir);
      const probePath = path.join(tempDir, "probe.mjs");
      fs.writeFileSync(probePath, QRCODE_PROBE);
      const r = spawnSync(
        process.execPath,
        ["--require", PRELOAD_SOURCE, "--require", PRELOAD_SOURCE, probePath],
        { cwd: tempDir, encoding: "utf-8", timeout: 10000 },
      );
      expect(r.status).toBe(0);
      const twice = JSON.parse(r.stdout.trim());
      expect(twice.qrcodeCreate).toEqual([{}, {}, {}]);
      expect(twice.qrcode).toEqual([{ type: "svg" }, {}]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
