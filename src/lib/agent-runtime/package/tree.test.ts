// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyVerifiedPackageTree, HarnessPackageStageCleanupError } from "./copy";
import { validateHarnessPackageTree, type ValidatedHarnessPackageTree } from "./tree";

type FixtureEntry = {
  readonly contents?: Buffer | string;
  readonly directory?: boolean;
  readonly mode?: number;
};

type TreeFixture = {
  readonly fixtureRoot: string;
  readonly sourceRoot: string;
  readonly stagingParent: string;
};

const fixtureRoots = new Set<string>();

function createFixtureDirectory(absolutePath: string, entry: FixtureEntry): void {
  fs.mkdirSync(absolutePath, { recursive: true, mode: entry.mode ?? 0o700 });
  fs.chmodSync(absolutePath, entry.mode ?? 0o700);
}

function createFixtureFile(absolutePath: string, relativePath: string, entry: FixtureEntry): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, entry.contents ?? relativePath, { mode: entry.mode ?? 0o600 });
  fs.chmodSync(absolutePath, entry.mode ?? 0o600);
}

function createTree(entries: Readonly<Record<string, FixtureEntry>> = {}): TreeFixture {
  const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), ".nemoclaw-tree-test-"));
  fixtureRoots.add(fixtureRoot);
  const sourceRoot = path.join(fixtureRoot, "source");
  const stagingParent = path.join(fixtureRoot, "stage");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(stagingParent, { mode: 0o700 });

  for (const [relativePath, entry] of Object.entries(entries)) {
    const absolutePath = path.join(sourceRoot, ...relativePath.split("/"));
    entry.directory
      ? createFixtureDirectory(absolutePath, entry)
      : createFixtureFile(absolutePath, relativePath, entry);
  }
  return { fixtureRoot, sourceRoot, stagingParent };
}

function listStages(stagingParent: string): string[] {
  return fs.readdirSync(stagingParent).filter((name) => name.startsWith(".nemoclaw-package-"));
}

function mockDirectoryNames(sourceRoot: string, names: readonly Buffer[]): void {
  const original = fs.opendirSync.bind(fs);
  vi.spyOn(fs, "opendirSync").mockImplementation(((candidate, options?: fs.OpenDirOptions) => {
    let index = 0;
    const mockedDirectory = {
      closeSync: (): void => undefined,
      readSync: (): fs.Dirent<Buffer> | null => {
        const name = names[index];
        index += 1;
        return name === undefined ? null : ({ name } as fs.Dirent<Buffer>);
      },
    } as unknown as fs.Dir;
    return Buffer.isBuffer(candidate) && candidate.toString() === sourceRoot
      ? mockedDirectory
      : original(candidate, options);
  }) as typeof fs.opendirSync);
}

function replaceBigIntStat(
  original: typeof fs.lstatSync,
  targetPath: string,
  replace: (stat: fs.BigIntStats) => fs.BigIntStats,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options?: unknown) => {
    const stat = Reflect.apply(original, fs, [candidate, options]) as fs.Stats | fs.BigIntStats;
    const matches =
      typeof candidate !== "number" &&
      path.resolve(candidate.toString()) === path.resolve(targetPath) &&
      typeof stat.uid === "bigint";
    return matches ? replace(stat as fs.BigIntStats) : stat;
  }) as typeof fs.lstatSync);
}

function statWithMethods(
  stat: fs.BigIntStats,
  methods: Partial<Record<keyof fs.BigIntStats, () => boolean>>,
): fs.BigIntStats {
  return new Proxy(stat, {
    get(target, property, receiver) {
      return property in methods
        ? methods[property as keyof fs.BigIntStats]
        : Reflect.get(target, property, receiver);
    },
  });
}

function statWithUid(stat: fs.BigIntStats, uid: bigint): fs.BigIntStats {
  return new Proxy(stat, {
    get(target, property, receiver) {
      return property === "uid" ? uid : Reflect.get(target, property, receiver);
    },
  });
}

function grantFixtureCleanup(absolutePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return;
  }
  switch (true) {
    case stat.isSymbolicLink():
      return;
    case !stat.isDirectory():
      fs.chmodSync(absolutePath, 0o600);
      return;
    default:
      fs.chmodSync(absolutePath, 0o700);
      for (const name of fs.readdirSync(absolutePath)) {
        grantFixtureCleanup(path.join(absolutePath, name));
      }
  }
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots) {
    grantFixtureCleanup(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

describe("harness package tree", () => {
  it("copies a non-empty verified tree into one private stage", () => {
    const fixture = createTree({
      "config/runtime.yaml": { contents: "enabled: true\n" },
      "scripts/start.sh": { contents: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    });

    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const copied = copyVerifiedPackageTree(validated, {
      stagingParent: fixture.stagingParent,
    });

    expect(copied.contentDigest).toBe(validated.contentDigest);
    expect(fs.readFileSync(path.join(copied.packageRoot, "config/runtime.yaml"), "utf8")).toBe(
      "enabled: true\n",
    );
    expect(fs.lstatSync(copied.stagingRoot).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(path.join(copied.packageRoot, "config/runtime.yaml")).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.lstatSync(path.join(copied.packageRoot, "scripts/start.sh")).mode & 0o777).toBe(
      0o711,
    );
  });

  it("removes the exact stage after its package tree is published", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const copied = copyVerifiedPackageTree(validateHarnessPackageTree(fixture.sourceRoot), {
      stagingParent: fixture.stagingParent,
    });
    const published = path.join(fixture.fixtureRoot, "published");
    fs.renameSync(copied.packageRoot, published);

    copied.removeStagingRoot();
    copied.removeStagingRoot();

    expect(fs.existsSync(copied.stagingRoot)).toBe(false);
    expect(fs.readFileSync(path.join(published, "runtime"), "utf8")).toBe("reviewed");
  });

  it("computes one digest for equal trees created in different orders", () => {
    const first = createTree({
      "z-last.txt": { contents: "last" },
      "nested/a-first.txt": { contents: "first" },
    });
    const second = createTree({
      "nested/a-first.txt": { contents: "first" },
      "z-last.txt": { contents: "last" },
    });

    expect(validateHarnessPackageTree(first.sourceRoot).contentDigest).toBe(
      validateHarnessPackageTree(second.sourceRoot).contentDigest,
    );
  });

  it("changes the digest when bytes, paths, or executable modes change", () => {
    const original = createTree({ "run.sh": { contents: "same", mode: 0o600 } });
    const changedBytes = createTree({ "run.sh": { contents: "different", mode: 0o600 } });
    const changedPath = createTree({ "renamed.sh": { contents: "same", mode: 0o600 } });
    const changedMode = createTree({ "run.sh": { contents: "same", mode: 0o700 } });
    const digest = validateHarnessPackageTree(original.sourceRoot).contentDigest;

    expect(validateHarnessPackageTree(changedBytes.sourceRoot).contentDigest).not.toBe(digest);
    expect(validateHarnessPackageTree(changedPath.sourceRoot).contentDigest).not.toBe(digest);
    expect(validateHarnessPackageTree(changedMode.sourceRoot).contentDigest).not.toBe(digest);
  });

  it("distinguishes each executable bit and preserves those bits in the copy", () => {
    const ownerExecutable = createTree({ "run.sh": { contents: "same", mode: 0o700 } });
    const allExecutable = createTree({ "run.sh": { contents: "same", mode: 0o711 } });
    const ownerDigest = validateHarnessPackageTree(ownerExecutable.sourceRoot).contentDigest;
    const allValidated = validateHarnessPackageTree(allExecutable.sourceRoot);

    expect(allValidated.contentDigest).not.toBe(ownerDigest);
    const copied = copyVerifiedPackageTree(allValidated, {
      stagingParent: allExecutable.stagingParent,
    });
    expect(fs.lstatSync(path.join(copied.packageRoot, "run.sh")).mode & 0o777).toBe(0o711);
  });

  it("preserves directory execute bits under a restrictive process umask", () => {
    const fixture = createTree({
      scripts: { directory: true, mode: 0o755 },
      "scripts/run.sh": { contents: "#!/bin/sh\n", mode: 0o700 },
    });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const previousUmask = process.umask(0o077);
    try {
      const copied = copyVerifiedPackageTree(validated, {
        stagingParent: fixture.stagingParent,
      });
      expect(fs.lstatSync(path.join(copied.packageRoot, "scripts")).mode & 0o777).toBe(0o711);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.each([
    [Buffer.alloc(0), "empty"],
    [Buffer.from("../escape"), "parent"],
    [Buffer.from("/absolute"), "absolute"],
    [Buffer.from("nul\0path"), "NUL"],
    [Buffer.from([0xff]), "invalid UTF-8"],
    [Buffer.from("e\u0301.txt"), "non-NFC"],
  ])("rejects a %s package path component (%s)", (invalidName) => {
    const fixture = createTree();
    mockDirectoryNames(fixture.sourceRoot, [invalidName]);

    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/path|UTF-8|Unicode/i);
  });

  it("rejects an alternate path separator", () => {
    const fixture = createTree({ "nested\\escape.txt": { contents: "blocked" } });
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/canonical relative/);
  });

  it("rejects case-folded duplicate paths", () => {
    const fixture = createTree({ Agent: { contents: "one" } });
    mockDirectoryNames(fixture.sourceRoot, [Buffer.from("Agent"), Buffer.from("agent")]);

    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/duplicate path/);
  });

  it("stops its bounded directory stream at the first entry beyond the limit", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `entry-${String(index).padStart(3, "0")}`,
        { contents: String(index) },
      ]),
    );
    const fixture = createTree(entries);
    const originalOpenDirectory = fs.opendirSync.bind(fs);
    let rootReads = 0;
    let configuredBufferSize: number | undefined;
    vi.spyOn(fs, "opendirSync").mockImplementation(((candidate, options?: fs.OpenDirOptions) => {
      const opened = originalOpenDirectory(candidate, options);
      const isSourceRoot =
        Buffer.isBuffer(candidate) && candidate.toString() === fixture.sourceRoot;
      configuredBufferSize = isSourceRoot ? options?.bufferSize : configuredBufferSize;
      return isSourceRoot
        ? new Proxy(opened, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              return property === "readSync"
                ? (): fs.Dirent | null => {
                    rootReads += 1;
                    return target.readSync();
                  }
                : typeof value === "function"
                  ? value.bind(target)
                  : value;
            },
          })
        : opened;
    }) as typeof fs.opendirSync);
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    expect(() =>
      validateHarnessPackageTree(fixture.sourceRoot, { limits: { maxEntries: 2 } }),
    ).toThrow(/entry count/);
    expect(configuredBufferSize).toBe(8);
    expect(rootReads).toBe(3);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it.each([
    "tests/unit.test.ts",
    "plugin/src/runtime.test.ts",
    "package-lock.json",
    "nemoclaw_fabric.egg-info/METADATA",
  ])("rejects authoring path %s", (relativePath) => {
    const fixture = createTree({ [relativePath]: { contents: "authoring" } });
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/authoring content/);
  });

  it.each([".env", ".ssh/id_ed25519", "service-account-prod.json"])(
    "rejects credential path %s",
    (relativePath) => {
      const fixture = createTree({ [relativePath]: { contents: "credential" } });
      expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/credential path/);
    },
  );

  it("rejects a symbolic link", () => {
    const fixture = createTree({ target: { contents: "target" } });
    fs.symlinkSync("target", path.join(fixture.sourceRoot, "link"));
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/symbolic links/);
  });

  it("rejects a hard-linked file", () => {
    const fixture = createTree({ target: { contents: "target" } });
    fs.linkSync(
      path.join(fixture.sourceRoot, "target"),
      path.join(fixture.sourceRoot, "second-link"),
    );
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/hard-linked/);
  });

  it("rejects a FIFO", () => {
    const fixture = createTree();
    const fifo = path.join(fixture.sourceRoot, "input.pipe");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/FIFOs/);
  });

  it.each([
    ["socket", { isFile: (): boolean => false, isSocket: (): boolean => true }, /sockets/],
    [
      "device",
      { isFile: (): boolean => false, isCharacterDevice: (): boolean => true },
      /device files/,
    ],
    [
      "unknown",
      {
        isFile: (): boolean => false,
        isSocket: (): boolean => false,
        isFIFO: (): boolean => false,
        isBlockDevice: (): boolean => false,
        isCharacterDevice: (): boolean => false,
      },
      /unknown entries/,
    ],
  ])("rejects a mocked %s entry type", (_label, methods, expected) => {
    const fixture = createTree({ special: { contents: "entry" } });
    const special = path.join(fixture.sourceRoot, "special");
    const original = fs.lstatSync.bind(fs);
    replaceBigIntStat(original, special, (stat) => statWithMethods(stat, methods));
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(expected);
  });

  it("rejects a sparse file", () => {
    const fixture = createTree({ "sparse.bin": { contents: "logical bytes" } });
    const sparse = path.join(fixture.sourceRoot, "sparse.bin");
    const original = fs.lstatSync.bind(fs);
    replaceBigIntStat(
      original,
      sparse,
      (stat) =>
        new Proxy(stat, {
          get(target, property, receiver) {
            return property === "blocks" ? 0n : Reflect.get(target, property, receiver);
          },
        }),
    );
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/sparse files/);
  });

  it.each([
    [0o666, /group or world writable/],
    [0o4755, /special mode bits/],
    [0o000, /owner-readable/],
  ])("rejects unsafe file mode %o", (mode, expected) => {
    const fixture = createTree({ runtime: { contents: "runtime", mode } });
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(expected);
  });

  it("rejects a nested directory without owner search permission", () => {
    const fixture = createTree({ private: { directory: true, mode: 0o400 } });
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(
      /owner-readable and owner-searchable/,
    );
  });

  it("accepts a reviewed root-owned tree for a non-root process", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    fs.chmodSync(fixture.sourceRoot, 0o555);
    fs.chmodSync(path.join(fixture.sourceRoot, "runtime"), 0o444);
    const originalLstat = fs.lstatSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    const actualUid = process.geteuid?.() ?? 1;
    const apparentUid = actualUid === 0 ? 10_000 : actualUid;
    vi.spyOn(process, "geteuid").mockReturnValue(apparentUid);
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options?: unknown) => {
      const stat = Reflect.apply(originalLstat, fs, [candidate, options]) as
        | fs.Stats
        | fs.BigIntStats;
      const inReviewedTree = path.resolve(candidate.toString()).startsWith(fixture.sourceRoot);
      return typeof stat.uid === "bigint" && inReviewedTree
        ? statWithUid(stat as fs.BigIntStats, 0n)
        : stat;
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor, options?: unknown) => {
      const stat = Reflect.apply(originalFstat, fs, [descriptor, options]) as
        | fs.Stats
        | fs.BigIntStats;
      return typeof stat.uid === "bigint" ? statWithUid(stat as fs.BigIntStats, 0n) : stat;
    }) as typeof fs.fstatSync);

    expect(() =>
      validateHarnessPackageTree(fixture.sourceRoot, { sourceTrust: "reviewed" }),
    ).not.toThrow();
  });

  it("rejects root-owned mutable input and unrelated reviewed owners", () => {
    const rootOwned = createTree({ runtime: { contents: "runtime" } });
    const unrelated = createTree({ runtime: { contents: "runtime" } });
    const original = fs.lstatSync.bind(fs);
    const apparentUid = (process.geteuid?.() ?? 1) + 10_000;
    vi.spyOn(process, "geteuid").mockReturnValue(apparentUid);
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options?: unknown) => {
      const stat = Reflect.apply(original, fs, [candidate, options]) as fs.Stats | fs.BigIntStats;
      const resolved = path.resolve(candidate.toString());
      return typeof stat.uid !== "bigint"
        ? stat
        : resolved === unrelated.sourceRoot
          ? statWithUid(stat as fs.BigIntStats, 4_242n)
          : statWithUid(stat as fs.BigIntStats, 0n);
    }) as typeof fs.lstatSync);

    expect(() => validateHarnessPackageTree(rootOwned.sourceRoot)).toThrow(/untrusted owner/);
    expect(() =>
      validateHarnessPackageTree(unrelated.sourceRoot, { sourceTrust: "reviewed" }),
    ).toThrow(/untrusted owner/);
  });

  it("rejects a writable source ancestor", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    fs.chmodSync(fixture.fixtureRoot, 0o777);
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/group or world writable/);
    fs.chmodSync(fixture.fixtureRoot, 0o700);
  });

  it("rejects a symbolic-link source ancestor", () => {
    const fixture = createTree();
    const target = path.join(fixture.fixtureRoot, "target");
    const linked = path.join(fixture.fixtureRoot, "linked");
    fs.mkdirSync(path.join(target, "source"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, linked);
    expect(() => validateHarnessPackageTree(path.join(linked, "source"))).toThrow(/ancestor/);
  });

  it("rejects an unrelated source-ancestor owner", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const original = fs.lstatSync.bind(fs);
    const unrelatedUid = BigInt((process.geteuid?.() ?? 0) + 10_000);
    replaceBigIntStat(original, fixture.fixtureRoot, (stat) => statWithUid(stat, unrelatedUid));
    expect(() => validateHarnessPackageTree(fixture.sourceRoot)).toThrow(/ancestor.*owner/);
  });

  it("allows unrelated sibling changes under a source ancestor", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);

    fs.mkdirSync(path.join(fixture.fixtureRoot, "unrelated"), { mode: 0o700 });

    const copied = copyVerifiedPackageTree(validated, {
      stagingParent: fixture.stagingParent,
    });
    expect(fs.readFileSync(path.join(copied.packageRoot, "runtime"), "utf8")).toBe("reviewed");
  });

  it("rejects source-ancestor replacement before copy", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const movedRoot = `${fixture.fixtureRoot}.original`;
    fixtureRoots.add(movedRoot);
    fs.renameSync(fixture.fixtureRoot, movedRoot);
    fs.mkdirSync(fixture.fixtureRoot, { mode: 0o700 });
    fs.mkdirSync(fixture.stagingParent, { mode: 0o700 });

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/changed/);
  });

  it.each([
    ["entry count", { maxEntries: 0 }, { one: { contents: "1" } }, /entry count/],
    ["depth", { maxDepth: 1 }, { "one/two": { contents: "2" } }, /depth/],
    ["path bytes", { maxPathBytes: 3 }, { longer: { contents: "3" } }, /path exceeds/],
    ["file bytes", { maxFileBytes: 1 }, { file: { contents: "12" } }, /file exceeds/],
    [
      "total bytes",
      { maxTotalBytes: 3 },
      { first: { contents: "12" }, second: { contents: "34" } },
      /total limit/,
    ],
  ])("rejects a tree beyond the %s limit", (_label, limits, entries, expected) => {
    const fixture = createTree(entries);
    expect(() => validateHarnessPackageTree(fixture.sourceRoot, { limits })).toThrow(expected);
  });

  it("accepts a tree exactly at every configured limit", () => {
    const fixture = createTree({ file: { contents: "1234" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot, {
      limits: {
        maxEntries: 1,
        maxDepth: 1,
        maxPathBytes: 4,
        maxFileBytes: 4,
        maxTotalBytes: 4,
      },
    });
    expect(validated.entryCount).toBe(1);
    expect(validated.totalBytes).toBe(4);
  });

  it.each([".", "..", "../outside", "a/.."])(
    "rejects staging prefix %s without creating an outside path",
    (stagingPrefix) => {
      const fixture = createTree({ runtime: { contents: "runtime" } });
      const validated = validateHarnessPackageTree(fixture.sourceRoot);
      expect(() =>
        copyVerifiedPackageTree(validated, {
          stagingParent: fixture.stagingParent,
          stagingPrefix,
        }),
      ).toThrow(/staging prefix/);
      expect(fs.readdirSync(fixture.fixtureRoot).sort()).toEqual(["source", "stage"]);
      expect(listStages(fixture.stagingParent)).toEqual([]);
    },
  );

  it("rejects a writable staging parent before creating a stage", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    fs.chmodSync(fixture.stagingParent, 0o777);
    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/group or world writable/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
    fs.chmodSync(fixture.stagingParent, 0o700);
  });

  it("rejects an unrelated staging-parent owner before creating a stage", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const original = fs.lstatSync.bind(fs);
    const unrelatedUid = BigInt((process.geteuid?.() ?? 0) + 10_000);
    replaceBigIntStat(original, fixture.stagingParent, (stat) => statWithUid(stat, unrelatedUid));
    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/owned by the current user/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("removes its stage when a copy fails", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      const error = new Error("injected write failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/injected write failure/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("reports incomplete cleanup when its created stage disappears after a copy failure", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      const stageName = listStages(fixture.stagingParent)[0] as string;
      fs.rmSync(path.join(fixture.stagingParent, stageName), { recursive: true });
      const error = new Error(
        "injected write failure after stage removal",
      ) as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(HarnessPackageStageCleanupError);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("preserves a replaced stage when its initial identity cannot be captured", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const original = fs.lstatSync.bind(fs);
    let replacementStage = "";
    let originalStage = "";
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options?: unknown) => {
      const candidatePath = candidate.toString();
      const shouldReplace =
        !replacementStage &&
        path.dirname(candidatePath) === fixture.stagingParent &&
        path.basename(candidatePath).startsWith(".nemoclaw-package-");
      switch (shouldReplace) {
        case true: {
          replacementStage = candidatePath;
          originalStage = `${candidatePath}.original`;
          fs.renameSync(candidatePath, originalStage);
          fs.mkdirSync(candidatePath, { mode: 0o700 });
          fs.writeFileSync(path.join(candidatePath, "replacement-sentinel"), "preserve", {
            mode: 0o600,
          });
          const error = new Error("injected stage lstat failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        default:
          return Reflect.apply(original, fs, [candidate, options]);
      }
    }) as typeof fs.lstatSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(HarnessPackageStageCleanupError);
    expect(fs.readFileSync(path.join(replacementStage, "replacement-sentinel"), "utf8")).toBe(
      "preserve",
    );
    expect(fs.lstatSync(originalStage).isDirectory()).toBe(true);
  });

  it("removes its exact stage when the first no-follow stage open fails", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const original = fs.openSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode?: number) => {
      const candidatePath = candidate.toString();
      const shouldFail =
        !injected &&
        path.dirname(candidatePath) === fixture.stagingParent &&
        path.basename(candidatePath).startsWith(".nemoclaw-package-");
      switch (shouldFail) {
        case true: {
          injected = true;
          const error = new Error("injected stage open failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        default:
          return original(candidate, flags, mode);
      }
    }) as typeof fs.openSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/injected stage open failure/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("rejects stage replacement between lstat and no-follow open", () => {
    const fixture = createTree({ runtime: { contents: "runtime" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const originalOpen = fs.openSync.bind(fs);
    const originalMkdir = fs.mkdirSync.bind(fs);
    let replacementStage = "";
    vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode?: number) => {
      const candidatePath = candidate.toString();
      const shouldReplace =
        !replacementStage &&
        path.dirname(candidatePath) === fixture.stagingParent &&
        path.basename(candidatePath).startsWith(".nemoclaw-package-");
      switch (shouldReplace) {
        case true:
          replacementStage = candidatePath;
          fs.renameSync(candidatePath, `${candidatePath}.original`);
          originalMkdir(candidatePath, { mode: 0o700 });
          fs.writeFileSync(path.join(candidatePath, "replacement-sentinel"), "preserve", {
            mode: 0o600,
          });
          break;
      }
      return originalOpen(candidate, flags, mode);
    }) as typeof fs.openSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(HarnessPackageStageCleanupError);
    expect(fs.readFileSync(path.join(replacementStage, "replacement-sentinel"), "utf8")).toBe(
      "preserve",
    );
  });

  it.each(["package root", "nested directory"])(
    "rejects %s replacement between creation and no-follow open",
    (replacementTarget) => {
      const entries: Record<string, FixtureEntry> =
        replacementTarget === "nested directory"
          ? { "assets/runtime": { contents: "runtime" } }
          : { runtime: { contents: "runtime" } };
      const fixture = createTree(entries);
      const validated = validateHarnessPackageTree(fixture.sourceRoot);
      const originalOpen = fs.openSync.bind(fs);
      const originalMkdir = fs.mkdirSync.bind(fs);
      let replaced = false;
      let replacementPath = "";
      vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode?: number) => {
        const candidatePath = candidate.toString();
        const isPackageRoot =
          replacementTarget === "package root" && path.basename(candidatePath) === "package";
        const isNestedDirectory =
          replacementTarget === "nested directory" && path.basename(candidatePath) === "assets";
        switch (!replaced && (isPackageRoot || isNestedDirectory)) {
          case true:
            replaced = true;
            replacementPath = candidatePath;
            fs.renameSync(candidatePath, `${candidatePath}.original`);
            originalMkdir(candidatePath, { mode: 0o700 });
            fs.writeFileSync(path.join(candidatePath, "replacement-sentinel"), "preserve", {
              mode: 0o600,
            });
            break;
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);

      expect(() =>
        copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
      ).toThrow(HarnessPackageStageCleanupError);
      expect(fs.readFileSync(path.join(replacementPath, "replacement-sentinel"), "utf8")).toBe(
        "preserve",
      );
      expect(listStages(fixture.stagingParent)).toHaveLength(1);
    },
  );

  it("rejects source replacement during copy and removes its stage", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const sourceFile = path.join(fixture.sourceRoot, "runtime");
    const moved = path.join(fixture.sourceRoot, "runtime.original");
    const originalWrite = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementationOnce(((...args: unknown[]) => {
      fs.renameSync(sourceFile, moved);
      fs.writeFileSync(sourceFile, "replacement", { mode: 0o600 });
      return Reflect.apply(originalWrite, fs, args);
    }) as typeof fs.writeSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/changed/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("rejects source-root replacement during copy and removes its stage", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const movedRoot = `${fixture.sourceRoot}.original`;
    const originalWrite = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementationOnce(((...args: unknown[]) => {
      fs.renameSync(fixture.sourceRoot, movedRoot);
      fs.mkdirSync(fixture.sourceRoot, { mode: 0o700 });
      return Reflect.apply(originalWrite, fs, args);
    }) as typeof fs.writeSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(/changed/);
    expect(listStages(fixture.stagingParent)).toEqual([]);
  });

  it("rejects a staging-parent swap without returning output", () => {
    const fixture = createTree({ runtime: { contents: "reviewed" } });
    const validated = validateHarnessPackageTree(fixture.sourceRoot);
    const movedParent = `${fixture.stagingParent}.moved`;
    const originalMkdir = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(((candidate, options?: unknown) => {
      fs.renameSync(fixture.stagingParent, movedParent);
      originalMkdir(fixture.stagingParent, { mode: 0o700 });
      fs.writeFileSync(path.join(fixture.stagingParent, "replacement-sentinel"), "preserve", {
        mode: 0o600,
      });
      return Reflect.apply(originalMkdir, fs, [candidate, options]);
    }) as typeof fs.mkdirSync);

    expect(() =>
      copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent }),
    ).toThrow(HarnessPackageStageCleanupError);
    expect(fs.readFileSync(path.join(fixture.stagingParent, "replacement-sentinel"), "utf8")).toBe(
      "preserve",
    );
    expect(listStages(movedParent)).toHaveLength(1);
  });

  it("reads package code as bytes without importing or invoking it", () => {
    const fixture = createTree();
    const marker = path.join(fixture.fixtureRoot, "package-code-ran");
    fs.writeFileSync(
      path.join(fixture.sourceRoot, "runtime.js"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')\n`,
      { mode: 0o600 },
    );
    const validated: ValidatedHarnessPackageTree = validateHarnessPackageTree(fixture.sourceRoot);
    copyVerifiedPackageTree(validated, { stagingParent: fixture.stagingParent });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
