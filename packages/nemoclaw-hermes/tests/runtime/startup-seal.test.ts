// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CONFIG_GUARD = path.join(import.meta.dirname, "../..", "runtime", "config-guard.py");
const STARTUP_SEAL = path.join(import.meta.dirname, "../..", "runtime", "startup-seal.py");

const loadStartupSeal = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("hermes_startup_seal", sys.argv[2])
seal = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = seal
spec.loader.exec_module(seal)
guard = seal.load_config_guard(sys.argv[1])
`;

function runPython(source: string) {
  return spawnSync("python3", ["-I", "-c", source, CONFIG_GUARD, STARTUP_SEAL], {
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("Hermes managed startup config sealer", () => {
  it("installs one immutable command at the core-owned image path", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "../..", "Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-hermes/runtime/startup-seal.py /usr/local/lib/nemoclaw/seal-config",
    );
    expect(dockerfile).toContain(
      "check_metadata /usr/local/lib/nemoclaw/seal-config 'root:root 555'",
    );
  });

  it("rejects arguments and an ambiguous replay mode before loading runtime state", () => {
    const invalidArgument = spawnSync("python3", ["-I", STARTUP_SEAL, "attacker"], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_MANAGED_STARTUP_REPLAY: "0" },
    });
    const invalidReplay = spawnSync("python3", ["-I", STARTUP_SEAL], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_MANAGED_STARTUP_REPLAY: "sometimes" },
    });

    expect(invalidArgument.status).toBe(1);
    expect(invalidArgument.stderr).toContain("accepts no arguments");
    expect(invalidReplay.status).toBe(1);
    expect(invalidReplay.stderr).toContain("must be 0 or 1");
  });

  it("builds the existing config, environment, Fabric, and MCP integrity anchor", () => {
    const config = "model: test\nmcp_servers: {}\n";
    const environment = "HERMES_HOME=/sandbox/.hermes\n";
    const fabric = '{"endpoint":"https://example.test"}\n';
    const result = runPython(`${loadStartupSeal}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as root:
    config = os.path.join(root, "config.yaml")
    environment = os.path.join(root, ".env")
    fabric = os.path.join(root, "fabric.json")
    open(config, "w", encoding="utf-8").write(${JSON.stringify(config)})
    open(environment, "w", encoding="utf-8").write(${JSON.stringify(environment)})
    open(fabric, "w", encoding="utf-8").write(${JSON.stringify(fabric)})
    text, _config, _environment, _fabric = guard._hash_text(config, environment)
    print(json.dumps({"text": text, "mcp": guard._canonical_mcp_servers_digest(${JSON.stringify(config)})}))
`);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { text: string; mcp: string };
    expect(output.text).toBe(
      [
        `${createHash("sha256").update(config).digest("hex")}  CONFIG`,
        `${createHash("sha256").update(environment).digest("hex")}  ENV`,
        `${createHash("sha256").update(fabric).digest("hex")}  FABRIC`,
        `# nemoclaw-hermes-mcp-state-v1 intended=${output.mcp} applied=${output.mcp}`,
        "",
      ]
        .join("\n")
        .replace("CONFIG", expectPath(output.text, "config.yaml"))
        .replace("ENV", expectPath(output.text, ".env"))
        .replace("FABRIC", expectPath(output.text, "fabric.json")),
    );
  });

  it("normalizes only the expected sandbox-owned descriptor", () => {
    const result = runPython(`${loadStartupSeal}
import json
import os
import stat
import tempfile

with tempfile.TemporaryDirectory() as root:
    target = os.path.join(root, "config.yaml")
    open(target, "w", encoding="utf-8").write("model: test\\n")
    os.chmod(target, 0o600)
    seal.normalize_managed_descriptor(
        guard, target, os.getuid(), os.getgid(), 0o640
    )
    accepted = stat.S_IMODE(os.stat(target).st_mode)
    try:
        seal.normalize_managed_descriptor(
            guard, target, os.getuid() + 1, os.getgid(), 0o640
        )
    except guard.UnsafePathError as exc:
        refused = str(exc)
    print(json.dumps({"accepted": accepted, "refused": refused}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: 0o640,
      refused: expect.stringContaining("unexpected Hermes managed config descriptor"),
    });
  });

  it("rejects unsafe modes and a path replacement during normalization", () => {
    const result = runPython(`${loadStartupSeal}
import json
import os
import tempfile

errors = {}
with tempfile.TemporaryDirectory() as root:
    for mode in (0o440, 0o644, 0o660):
        target = os.path.join(root, f"config-{mode:o}.yaml")
        open(target, "w", encoding="utf-8").write("model: test\\n")
        os.chmod(target, mode)
        try:
            seal.normalize_managed_descriptor(
                guard, target, os.getuid(), os.getgid(), 0o640
            )
        except guard.UnsafePathError as exc:
            errors[f"mode-{mode:o}"] = str(exc)

    target = os.path.join(root, "config.yaml")
    displaced = os.path.join(root, "displaced.yaml")
    replacement = os.path.join(root, "replacement.yaml")
    open(target, "w", encoding="utf-8").write("model: trusted\\n")
    open(replacement, "w", encoding="utf-8").write("model: replaced\\n")
    os.chmod(target, 0o600)
    os.chmod(replacement, 0o640)
    real_fchmod = guard.os.fchmod
    def replace_after_chmod(descriptor, mode):
        real_fchmod(descriptor, mode)
        os.rename(target, displaced)
        os.rename(replacement, target)
    guard.os.fchmod = replace_after_chmod
    try:
        seal.normalize_managed_descriptor(
            guard, target, os.getuid(), os.getgid(), 0o640
        )
    except guard.UnsafePathError as exc:
        errors["replacement"] = str(exc)
print(json.dumps(errors))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "mode-440": expect.stringContaining("unexpected Hermes managed config descriptor"),
      "mode-644": expect.stringContaining("unexpected Hermes managed config descriptor"),
      "mode-660": expect.stringContaining("group/world-writable"),
      replacement: expect.stringContaining("changed during normalization"),
    });
  });

  it("replaces only an absent or expected seal target", () => {
    const result = runPython(`${loadStartupSeal}
import json
import os
import stat
import tempfile

with tempfile.TemporaryDirectory() as root:
    target = os.path.join(root, "config-hash")
    seal.replace_managed_file(
        guard, target, b"first\\n", mode=0o444, uid=os.getuid(), gid=os.getgid()
    )
    seal.replace_managed_file(
        guard, target, b"second\\n", mode=0o444, uid=os.getuid(), gid=os.getgid()
    )
    accepted = {
        "contents": open(target, encoding="utf-8").read(),
        "mode": stat.S_IMODE(os.stat(target).st_mode),
    }
    os.chmod(target, 0o600)
    try:
        seal.replace_managed_file(
            guard, target, b"third\\n", mode=0o444, uid=os.getuid(), gid=os.getgid()
        )
    except guard.UnsafePathError as exc:
        refused = str(exc)
    print(json.dumps({"accepted": accepted, "refused": refused}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: { contents: "second\n", mode: 0o444 },
      refused: expect.stringContaining("unexpected managed startup seal target"),
    });
  });

  it("promotes the generated policy with root-only intent and detects cleanup races", () => {
    const result = runPython(`${loadStartupSeal}
import json
import os
import tempfile

outcomes = {}
for raced in (False, True):
    with tempfile.TemporaryDirectory() as root:
        source = os.path.join(root, "managed-policy.json")
        target = os.path.join(root, "installed-policy.json")
        open(source, "w", encoding="utf-8").write('{"schema_version":1}\\n')
        os.chmod(source, 0o600)
        seal.POLICY_SOURCE_PATH = source
        seal.POLICY_TARGET_PATH = target
        captured = {}

        def replace(_guard, path, data, **metadata):
            captured.update({
                "path": path,
                "data": data.decode("utf-8"),
                "mode": metadata["mode"],
                "uid": metadata["uid"],
                "gid": metadata["gid"],
            })
            if raced:
                open(source, "a", encoding="utf-8").write("changed\\n")

        seal.replace_managed_file = replace
        try:
            seal.install_managed_policy(guard, os.getuid(), os.getgid())
        except guard.UnsafePathError as exc:
            error = str(exc)
        else:
            error = None
        outcomes[str(raced)] = {
            "captured": captured,
            "error": error,
            "source_exists": os.path.exists(source),
        }
print(json.dumps(outcomes))
`);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Record<
      string,
      {
        captured: { data: string; gid: number; mode: number; path: string; uid: number };
        error: string | null;
        source_exists: boolean;
      }
    >;
    expect(output.False).toMatchObject({
      captured: { data: '{"schema_version":1}\n', mode: 0o444, uid: 0, gid: 0 },
      error: null,
      source_exists: false,
    });
    expect(output.True).toMatchObject({
      error: expect.stringContaining("refusing raced runtime config path"),
      source_exists: true,
    });
  });

  it("uses one bounded initial seal and replay repair workflow", () => {
    const result = runPython(`${loadStartupSeal}
import json
from types import SimpleNamespace

calls = []
snapshots = {
    "config.yaml": object(),
    ".env": object(),
    "fabric.json": object(),
}

class Opened:
    def __init__(self, snapshot):
        self.snapshot = snapshot
    def close(self):
        pass

guard.os.geteuid = lambda: 0
seal.pwd.getpwnam = lambda _name: SimpleNamespace(pw_uid=501, pw_gid=20)
seal.install_managed_policy = lambda _guard, uid, gid: calls.append(["policy", uid, gid])
guard._hash_text = lambda _config, _env: (
    "sealed\\n", snapshots["config.yaml"], snapshots[".env"], snapshots["fabric.json"]
)
guard._open_regular = lambda target: Opened(snapshots[target.rsplit("/", 1)[-1]])
seal.replace_managed_file = lambda _guard, target, data, **metadata: calls.append(
    ["replace", target, data.decode("utf-8"), metadata["mode"], metadata["uid"], metadata["gid"]]
)
seal.normalize_managed_descriptor = lambda _guard, target, uid, gid, mode: calls.append(
    ["normalize", target, uid, gid, mode]
)

seal.seal_managed_configuration(guard, False)
initial = list(calls)
calls.clear()
seal.seal_managed_configuration(guard, True)
print(json.dumps({"initial": initial, "replay": calls}))
`);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      initial: unknown[][];
      replay: unknown[][];
    };
    expect(output.initial.filter(([kind]) => kind === "policy")).toEqual([["policy", 501, 20]]);
    expect(output.initial.filter(([kind]) => kind === "replace")).toEqual([
      ["replace", "/etc/nemoclaw/hermes.config-hash", "sealed\n", 0o444, 0, 0],
      ["replace", "/sandbox/.hermes/.config-hash", "sealed\n", 0o640, 501, 20],
    ]);
    expect(output.initial.filter(([kind]) => kind === "normalize")).toHaveLength(3);
    expect(output.replay).toEqual([
      ["normalize", "/sandbox/.hermes/config.yaml", 501, 20, 0o640],
      ["normalize", "/sandbox/.hermes/.env", 501, 20, 0o640],
      ["normalize", "/sandbox/.hermes/fabric.json", 501, 20, 0o600],
    ]);
  });
});

function expectPath(hashText: string, basename: string): string {
  const line = hashText.split("\n").find((candidate) => candidate.endsWith(`/${basename}`));
  if (!line) throw new Error(`missing ${basename} hash entry`);
  return line.slice(66);
}
