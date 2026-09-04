// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

/** Open a package-test fixture without following or losing track of its inode. */
export function openFixtureRegularFile(target: string) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    fs.closeSync(descriptor);
  };
  const stat = (): fs.Stats => {
    const descriptorStats = fs.fstatSync(descriptor);
    const pathStats = fs.lstatSync(target);
    if (
      !descriptorStats.isFile() ||
      descriptorStats.nlink !== 1 ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino
    ) {
      throw new Error(`fixture file changed during validation: ${target}`);
    }
    return descriptorStats;
  };
  const readBytes = (maxBytes: number): Buffer => {
    const beforeRead = stat();
    if (beforeRead.size > maxBytes) {
      throw new RangeError(`fixture file exceeds the ${String(maxBytes)}-byte read limit`);
    }
    const bytes = Buffer.alloc(beforeRead.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`short fixture read: ${target}`);
      offset += read;
    }
    const afterRead = stat();
    if (
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeMs !== afterRead.mtimeMs ||
      beforeRead.ctimeMs !== afterRead.ctimeMs
    ) {
      throw new Error(`fixture file changed while reading: ${target}`);
    }
    return bytes;
  };
  try {
    stat();
  } catch (error) {
    close();
    throw error;
  }
  return Object.freeze({
    close,
    readBytes,
    readUtf8: (maxBytes: number): string => readBytes(maxBytes).toString("utf8"),
    stat,
  });
}
