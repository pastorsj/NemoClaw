// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function removeRegistryFile(registryFile: string): void {
  if (fs.existsSync(registryFile)) fs.unlinkSync(registryFile);
}

export function removeRegistryTempFiles(registryDirectory: string): void {
  if (!fs.existsSync(registryDirectory)) return;
  for (const file of fs.readdirSync(registryDirectory)) {
    if (file.startsWith("sandboxes.json.tmp.")) {
      fs.unlinkSync(path.join(registryDirectory, file));
    }
  }
}

export function failFirstOwnerTempWrite(error: Error): () => void {
  const originalWrite = fs.writeFileSync;
  let shouldFail = true;
  fs.writeFileSync = (...args) => {
    if (shouldFail && String(args[0]).includes("owner.tmp.")) {
      shouldFail = false;
      throw error;
    }
    return originalWrite.apply(fs, args);
  };
  return () => {
    fs.writeFileSync = originalWrite;
  };
}

export function recordLockDirectoryMutations(lockDirectory: string): {
  readonly mkdirCalls: string[];
  readonly rmCalls: string[];
  readonly restore: () => void;
} {
  const mkdirCalls: string[] = [];
  const rmCalls: string[] = [];
  const originalMkdir = fs.mkdirSync;
  const originalRm = fs.rmSync;
  fs.mkdirSync = (...args) => {
    if (args[0] === lockDirectory) mkdirCalls.push(lockDirectory);
    return originalMkdir.apply(fs, args);
  };
  fs.rmSync = (...args) => {
    const target = String(args[0]);
    if (target.startsWith(`${lockDirectory}.quarantine.`)) rmCalls.push(target);
    return originalRm.apply(fs, args);
  };
  return {
    mkdirCalls,
    rmCalls,
    restore: () => {
      fs.mkdirSync = originalMkdir;
      fs.rmSync = originalRm;
    },
  };
}
