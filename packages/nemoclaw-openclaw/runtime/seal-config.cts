#!/usr/local/bin/node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const { spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const FABRIC_PATH = "/sandbox/.openclaw/fabric.json";
const HASH_PATH = "/sandbox/.openclaw/.config-hash";
const REPLAY_ENV = "NEMOCLAW_MANAGED_STARTUP_REPLAY";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_FABRIC_BYTES = 4 * 1024 * 1024;

class OpenClawSealError extends Error {
  constructor(message) {
    super(`OpenClaw managed config seal failed: ${message}`);
    this.name = "OpenClawSealError";
  }
}

function fail(message) {
  throw new OpenClawSealError(message);
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readStableFile(target, maxBytes) {
  if (typeof fs.constants.O_NOFOLLOW !== "number") fail("O_NOFOLLOW is unavailable");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch {
    return fail(`refusing unsafe or unreadable file ${target}`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > maxBytes) {
      fail(`refusing unsafe or oversized file ${target}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || overflow !== 0 || !sameFile(before, after)) {
      fail(`${target} changed while it was read`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function buildConfigHash(config, fabric) {
  return (
    `${createHash("sha256").update(config).digest("hex")}  openclaw.json\n` +
    `${createHash("sha256").update(fabric).digest("hex")}  fabric.json\n`
  );
}

function writeHashAtomically(target, contents) {
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.uid !== process.geteuid?.() ||
    parentStat.gid !== process.getegid?.()
  ) {
    fail(`refusing unsafe sandbox-owned directory ${parent}`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomBytes(12).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, 0o660);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary write failure.
    }
    fail(`could not write ${target}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function validateOpenClawConfiguration(configPath) {
  const result = spawnSync("/usr/local/bin/openclaw", ["config", "validate", "--json"], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) fail("OpenClaw rejected the generated config");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail("OpenClaw config validation did not emit JSON");
  }
  if (parsed === null || typeof parsed !== "object" || parsed.valid !== true) {
    fail("OpenClaw rejected the generated config");
  }
}

function sealManagedConfiguration(paths = {}) {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const fabricPath = paths.fabricPath ?? FABRIC_PATH;
  const hashPath = paths.hashPath ?? HASH_PATH;
  validateOpenClawConfiguration(configPath);
  const config = readStableFile(configPath, BigInt(MAX_CONFIG_BYTES));
  const fabric = readStableFile(fabricPath, BigInt(MAX_FABRIC_BYTES));
  writeHashAtomically(hashPath, buildConfigHash(config, fabric));
}

function verifyManagedConfiguration(paths = {}) {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const fabricPath = paths.fabricPath ?? FABRIC_PATH;
  const hashPath = paths.hashPath ?? HASH_PATH;
  const config = readStableFile(configPath, BigInt(MAX_CONFIG_BYTES));
  const fabric = readStableFile(fabricPath, BigInt(MAX_FABRIC_BYTES));
  const recordedHash = readStableFile(hashPath, 64n * 1024n);
  const expectedHash = Buffer.from(buildConfigHash(config, fabric), "utf8");
  if (!recordedHash.equals(expectedHash)) fail("the protected configuration hash is stale");
}

function main() {
  if (process.geteuid?.() === 0) fail("the seal must run as the sandbox account");
  const action = process.argv[2];
  if (action === "refresh" && process.argv.length === 3) {
    sealManagedConfiguration();
    return;
  }
  if (action === "verify" && process.argv.length === 3) {
    verifyManagedConfiguration();
    return;
  }
  if (process.argv.length !== 2) {
    fail("the managed config sealer accepts only refresh or verify");
  }
  const replay = process.env[REPLAY_ENV];
  if (replay !== "0" && replay !== "1") fail(`${REPLAY_ENV} must be 0 or 1`);
  if (replay === "0") sealManagedConfiguration();
}

module.exports = {
  buildConfigHash,
  main,
  readStableFile,
  sealManagedConfiguration,
  validateOpenClawConfiguration,
  verifyManagedConfiguration,
  writeHashAtomically,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenClaw managed config seal failed");
    process.exitCode = 1;
  }
}
