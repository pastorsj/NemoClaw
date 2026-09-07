// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrivateBearerDescriptor } from "./credential-file";

const DEPLOYMENT_CREDENTIAL = "voice-gateway-deployment-credential-0123456789";
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-credential-"));
  directories.push(directory);
  return directory;
}

function credentialDescriptor(value: string, mode = 0o600): number {
  const file = path.join(temporaryDirectory(), "credential");
  fs.writeFileSync(file, value, { mode });
  fs.chmodSync(file, mode);
  return fs.openSync(file, fs.constants.O_RDONLY);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway deployment credential descriptor", () => {
  it("reads the owner-only regular descriptor once and closes it (#9235)", () => {
    const descriptor = credentialDescriptor(`${DEPLOYMENT_CREDENTIAL}\n`);
    const read = vi.spyOn(fs, "readSync");

    expect(readPrivateBearerDescriptor(descriptor)).toBe(DEPLOYMENT_CREDENTIAL);
    expect(read).toHaveBeenCalledTimes(1);
    expect(() => fs.fstatSync(descriptor)).toThrow();
  });

  it("rejects a missing or non-regular descriptor without reading it (#9235)", () => {
    const missing = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    fs.closeSync(missing);
    const read = vi.spyOn(fs, "readSync");
    expect(() => readPrivateBearerDescriptor(missing)).toThrow("descriptor is not open");
    expect(read).not.toHaveBeenCalled();

    const directory = fs.openSync(temporaryDirectory(), fs.constants.O_RDONLY);
    expect(() => readPrivateBearerDescriptor(directory)).toThrow("not a regular file");
  });

  it("rejects a descriptor not owned by the current user (#9235)", () => {
    const descriptor = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);

    expect(() => readPrivateBearerDescriptor(descriptor)).toThrow("not owned by the current user");
  });

  it.each([
    ["group-readable", DEPLOYMENT_CREDENTIAL, 0o640, "group or others"],
    ["short", "short", 0o600, "invalid size"],
    ["whitespace", `${DEPLOYMENT_CREDENTIAL} extra`, 0o600, "malformed"],
    ["oversized", "a".repeat(4098), 0o600, "invalid size"],
  ])("rejects a %s deployment credential (#9235)", (_name, value, mode, message) => {
    const descriptor = credentialDescriptor(value, mode as number);
    expect(() => readPrivateBearerDescriptor(descriptor)).toThrow(message);
  });

  it("does not include descriptor contents in validation errors (#9235)", () => {
    const secret = `${DEPLOYMENT_CREDENTIAL} secret`;
    const descriptor = credentialDescriptor(secret);

    expect(() => readPrivateBearerDescriptor(descriptor)).toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });

  it("reports a cleanup error after a successful credential read (#9235)", () => {
    const descriptor = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const close = fs.closeSync.bind(fs);
    vi.spyOn(fs, "closeSync").mockImplementationOnce((value) => {
      close(value);
      throw new Error("cleanup failed");
    });

    expect(() => readPrivateBearerDescriptor(descriptor)).toThrow("cleanup failed");
  });
});
