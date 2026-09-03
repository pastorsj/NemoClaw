// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const publisherPath = path.join(packageRoot, "runtime", "state", "publisher.py");
const stateGuardPath = path.resolve(packageRoot, "../..", "scripts", "state-dir-guard.py");

const VERIFY_MUTABLE_POSTURE = String.raw`
import importlib.util
import json
import os
import sys
import tempfile

publisher_path, guard_path = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("hermes_state_posture", publisher_path)
publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = publisher
spec.loader.exec_module(publisher)

real_load_module = publisher._load_module
current_uid = os.getuid()
current_gid = os.getgid()
service_uid = current_uid if current_uid > 0 else 1
publisher.ROOT_UID = current_uid
publisher.ROOT_GID = current_gid
guard_findings = []

def load_module(path, name):
    module = real_load_module(path, name)
    if path == guard_path:
        module._production_identity = lambda: module.Identity(
            root_uid=current_uid,
            root_gid=current_gid,
            sandbox_uid=current_uid,
            sandbox_gid=current_gid,
        )
        module._get_inode_flags = lambda _fd: 0
        real_run_guard = module.run_guard
        def run_guard(*args, **kwargs):
            result = real_run_guard(*args, **kwargs)
            guard_findings.extend(issue.as_json() for issue in result.issues)
            return result
        module.run_guard = run_guard
    return module

publisher._load_module = load_module
publisher.STATE_DIR_GUARD_PATH = guard_path
publisher.pwd.getpwnam = lambda _name: type("User", (), {"pw_uid": service_uid})()
plan = json.dumps({
    "version": 1,
    "readOnlyRoots": [],
    "confidentialRoots": [],
    "readOnlyPrefixes": [],
    "confidentialPrefixes": [],
    "writableSubpaths": [],
}, separators=(",", ":"))

results = {}
with tempfile.TemporaryDirectory() as temporary_path:
    temporary = os.path.realpath(temporary_path)
    sandbox_dir = os.path.join(temporary, "sandbox")
    config_dir = os.path.join(sandbox_dir, ".hermes")
    os.mkdir(sandbox_dir, 0o755)
    os.mkdir(config_dir, 0o700)
    os.chmod(sandbox_dir, 0o755)
    os.chmod(config_dir, 0o700)
    publisher.HERMES_DIR = config_dir
    for name in (".config-hash", ".env", "config.yaml"):
        with open(os.path.join(config_dir, name), "w", encoding="utf-8") as stream:
            stream.write("regular\n")
        os.chmod(os.path.join(config_dir, name), 0o640)
    fabric_path = os.path.join(config_dir, "fabric.json")
    with open(fabric_path, "w", encoding="utf-8") as stream:
        stream.write("private\n")
    os.chmod(fabric_path, 0o600)

    try:
        publisher._verify_state_posture("mutable", plan)
    except publisher.PublisherError as error:
        results["mixedModes"] = error.code
        results["guardFindings"] = guard_findings
    else:
        results["mixedModes"] = "accepted"

    os.chmod(fabric_path, 0o640)
    try:
        publisher._verify_state_posture("mutable", plan)
    except publisher.PublisherError as error:
        results["widenedPrivateFile"] = error.code
    else:
        results["widenedPrivateFile"] = "accepted"

print(json.dumps(results, sort_keys=True))
`;

describe("Hermes mutable state posture", () => {
  it("composes the package publisher with the core mixed-mode guard", () => {
    const result = spawnSync(
      "python3",
      ["-I", "-c", VERIFY_MUTABLE_POSTURE, publisherPath, stateGuardPath],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mixedModes: "accepted",
      widenedPrivateFile: "publisher-state-posture-invalid",
    });
  });
});
