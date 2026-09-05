// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPackageHostModule } from "../helpers/host-module";

const managedRuntimePath = path.join(
  path.resolve(import.meta.dirname, "../.."),
  "runtime",
  "managed-runtime.py",
);
const managedProjectionPath = "/sandbox/.deepagents/.nemoclaw-mcp.json";
const mcpAdapter = loadPackageHostModule<{
  buildStatusCommand(entry: {
    server: string;
    url: string;
    headers: Record<string, string>;
  }): string;
  buildMcpSnapshotRestorePlan(request: {
    sandboxName: string;
    entries: Array<{ server: string; url: string; headers: Record<string, string> }>;
  }): {
    kind: "conditional-repair";
    applicability: {
      command: string;
      repairWhenOutput: string;
      skipWhenOutput: string;
    };
    execution: { command: string };
  };
}>("mcp-adapter.cts");

function runPackageStatusCommand(configPath: string) {
  const command = mcpAdapter
    .buildStatusCommand({
      server: "docs",
      url: "https://example.test/mcp",
      headers: {},
    })
    .replace("/opt/venv/bin/python3", "python3")
    .replace(JSON.stringify(managedProjectionPath), JSON.stringify(configPath));
  return spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function runPackageSnapshotRepair(
  configPath: string,
  entries: Array<{ server: string; url: string; headers: Record<string, string> }> = [],
) {
  const plan = mcpAdapter.buildMcpSnapshotRestorePlan({ sandboxName: "sandbox", entries });
  const command = plan.execution.command
    .replace("/opt/venv/bin/python3", "python3")
    .replace(JSON.stringify(managedProjectionPath), JSON.stringify(configPath));
  return spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function runManagedHelper(source: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-mcp-"));
  try {
    const helperPath = path.join(tempDir, "_nemoclaw_managed.py");
    const helperSource = fs.readFileSync(managedRuntimePath, "utf-8");
    fs.writeFileSync(helperPath, helperSource, "utf-8");
    return spawnSync("python3", ["-I", "-c", source, helperPath], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Deep Agents managed MCP runtime hardening", () => {
  it("declares the finite managed and legacy snapshot restore paths", () => {
    const plan = mcpAdapter.buildMcpSnapshotRestorePlan({
      sandboxName: "sandbox",
      entries: [],
    });

    expect(plan).toMatchObject({
      kind: "conditional-repair",
      applicability: {
        repairWhenOutput: "v2",
        skipWhenOutput: "legacy",
      },
      execution: { command: expect.stringContaining("reset_projection(expected)") },
    });
    expect(plan.applicability.command).toContain("NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR");
  });

  it.each(["symlink", "FIFO"] as const)(
    "atomically replaces an unsafe %s during package-owned snapshot repair",
    (fixture) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-restore-"));
      const configPath = path.join(tempDir, "managed.json");
      const targetPath = path.join(tempDir, "target.json");
      try {
        fs.writeFileSync(targetPath, '{"outside":true}\n', { mode: 0o600 });
        if (fixture === "symlink") {
          fs.symlinkSync(targetPath, configPath);
        } else {
          const fifo = spawnSync("mkfifo", [configPath], { encoding: "utf-8" });
          expect(fifo.status, fifo.stderr).toBe(0);
        }

        const result = runPackageSnapshotRepair(configPath, [
          {
            server: "docs",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer openshell:resolve:env:DOCS_TOKEN" },
          },
        ]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual({
          mcpServers: {
            docs: {
              type: "http",
              url: "https://example.test/mcp",
              headers: { Authorization: "Bearer openshell:resolve:env:DOCS_TOKEN" },
            },
          },
        });
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(targetPath, "utf-8")).toBe('{"outside":true}\n');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("refuses to replace a directory during package-owned snapshot repair", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-restore-"));
    const configPath = path.join(tempDir, "managed.json");
    try {
      fs.mkdirSync(configPath);
      fs.writeFileSync(path.join(configPath, "keep.json"), '{"owned":false}\n');

      const result = runPackageSnapshotRepair(configPath);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("managed MCP projection path is a directory");
      expect(fs.readFileSync(path.join(configPath, "keep.json"), "utf-8")).toBe(
        '{"owned":false}\n',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports only a genuinely absent package projection as absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-status-"));
    try {
      const result = runPackageStatusCommand(path.join(tempDir, "missing.json"));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("absent");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["symlink", "unsafe-mode", "hard-link", "invalid-json", "invalid-utf8"] as const)(
    "fails closed for an unsafe or invalid package projection: %s",
    (fixture) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-status-"));
      const configPath = path.join(tempDir, "managed.json");
      try {
        if (fixture === "symlink") {
          const target = path.join(tempDir, "target.json");
          fs.writeFileSync(target, '{"mcpServers":{}}\n', { mode: 0o600 });
          fs.symlinkSync(target, configPath);
        } else if (fixture === "unsafe-mode") {
          fs.writeFileSync(configPath, '{"mcpServers":{}}\n', { mode: 0o644 });
        } else if (fixture === "hard-link") {
          fs.writeFileSync(configPath, '{"mcpServers":{}}\n', { mode: 0o600 });
          fs.linkSync(configPath, path.join(tempDir, "second-link.json"));
        } else if (fixture === "invalid-json") {
          fs.writeFileSync(configPath, "{not-json}\n", { mode: 0o600 });
        } else {
          fs.writeFileSync(configPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
        }

        const result = runPackageStatusCommand(configPath);

        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        if (fixture === "symlink") {
          expect(result.stderr.trim()).toBe(
            `Unsafe managed Deep Agents MCP projection path: symbolic link at ${configPath}`,
          );
        } else {
          expect(result.stderr.trim()).toBe(
            "Managed Deep Agents MCP projection is unsafe or invalid.",
          );
          expect(result.stderr).not.toContain(configPath);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps ownership and read-stability checks in the package status boundary", () => {
    const command = mcpAdapter.buildStatusCommand({
      server: "docs",
      url: "https://example.test/mcp",
      headers: {},
    });

    expect(command).toContain("opened.st_uid == os.getuid()");
    expect(command).toContain("opened.st_nlink == 1");
    expect(command).toContain("managed_fingerprint(before) == managed_fingerprint(after)");
    expect(command).toContain("managed_fingerprint(after) == managed_fingerprint(linked_after)");
  });

  it.runIf(process.platform === "linux")(
    "rejects OpenShell supervisor TLS identity from the managed child runtime",
    () => {
      const result = runManagedHelper(String.raw`
import importlib.util
import fcntl
import os
import sys

for name, value in {
    "F_SEAL_WRITE": 1,
    "F_SEAL_GROW": 2,
    "F_SEAL_SHRINK": 4,
    "F_SEAL_SEAL": 8,
}.items():
    setattr(fcntl, name, getattr(fcntl, name, value))
spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

original = os.environ.copy()
try:
    for name, value in {
        "OPENSHELL_TLS_CA": "/etc/openshell/tls/client/ca.crt",
        "OPENSHELL_TLS_CERT": "/etc/openshell/tls/client/tls.crt",
        "OPENSHELL_TLS_KEY": "/etc/openshell/tls/client/tls.key",
    }.items():
        os.environ.clear()
        os.environ[name] = value
        try:
            managed._assert_safe_environment()
        except RuntimeError as exc:
            assert name in str(exc)
            assert value not in str(exc)
        else:
            raise AssertionError(f"accepted supervisor-only identity variable {name}")
finally:
    os.environ.clear()
    os.environ.update(original)
print("supervisor-identity-boundary-ok")
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("supervisor-identity-boundary-ok");
    },
  );

  it.runIf(process.platform === "linux")(
    "treats only the exact empty managed projection as an absent snapshot",
    () => {
      const result = runManagedHelper(String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

tombstone = b'{"mcpServers":{}}\n'
assert managed._canonicalize_managed_mcp_config(tombstone) is None
managed._read_managed_mcp_config = lambda: tombstone
assert managed.managed_mcp_config_path() is None
assert managed._MANAGED_MCP_READY is True
assert managed._MANAGED_MCP_FD is None

invalid = (
    b'{}',
    b'[]',
    b'null',
    b'{"mcpServers":[]}',
    b'{"mcpServers":null}',
    b'{"mcpServers":{},"extra":{}}',
    b'{"mcpServers":{},"mcpServers":{}}',
    b'{"mcpServers":NaN}',
)
for raw in invalid:
    try:
        managed._canonicalize_managed_mcp_config(raw)
    except RuntimeError:
        pass
    else:
        raise AssertionError(f"accepted malformed empty projection: {raw!r}")
print("strict-tombstone-ok")
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("strict-tombstone-ok");
    },
  );

  it("accepts host-validated private targets without accepting malformed or unsupported hosts (#8267)", () => {
    const result = runManagedHelper(String.raw`
import fcntl
import importlib.util
import json
import sys

for name, value in {
    "F_SEAL_WRITE": 1,
    "F_SEAL_GROW": 2,
    "F_SEAL_SHRINK": 4,
    "F_SEAL_SEAL": 8,
}.items():
    setattr(fcntl, name, getattr(fcntl, name, value))
spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

accepted_urls = (
    "https://8.8.8.8/mcp",
    "https://10.20.30.40/mcp",
    "https://mcp.corp.internal/mcp",
)
rejected_urls = (
    "https://host.openshell.internal/mcp",
    "https://host.docker.internal/mcp",
    "https://host.containers.internal/mcp",
    "https://mcp..corp.internal/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/mcp",
    "https://0177.0.0.1/mcp",
    "https://[fc00::1]/mcp",
)

accepted = [managed._validate_managed_mcp_url(url) for url in accepted_urls]
rejected = []
for url in rejected_urls:
    try:
        managed._validate_managed_mcp_url(url)
    except RuntimeError:
        rejected.append(url)
print(json.dumps({"accepted": accepted, "rejected": rejected}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: ["https://8.8.8.8/mcp", "https://10.20.30.40/mcp", "https://mcp.corp.internal/mcp"],
      rejected: [
        "https://host.openshell.internal/mcp",
        "https://host.docker.internal/mcp",
        "https://host.containers.internal/mcp",
        "https://mcp..corp.internal/mcp",
        "https://127.0.0.1/mcp",
        "https://169.254.169.254/mcp",
        "https://0177.0.0.1/mcp",
        "https://[fc00::1]/mcp",
      ],
    });
  });

  it("rejects stacked private tmpfs mounts even when the lower mount is compliant (#8018)", () => {
    const result = runManagedHelper(String.raw`
import importlib.util
import fcntl
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

for name, value in {
    "F_SEAL_WRITE": 1,
    "F_SEAL_GROW": 2,
    "F_SEAL_SHRINK": 4,
    "F_SEAL_SEAL": 8,
}.items():
    setattr(fcntl, name, getattr(fcntl, name, value))
spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

directory = Path("/run/nemoclaw-dcode-mcp")
managed._MCP_PRIVATE_ANONYMOUS_DIRECTORY = directory
valid_mountinfo = (
    f"31 20 0:25 / {directory} rw,nosuid,nodev,noexec - "
    "tmpfs tmpfs rw,size=1024k,mode=1777\n"
)
mountinfo = valid_mountinfo
managed.os.lstat = lambda _path: SimpleNamespace(st_mode=stat.S_IFDIR | 0o1777)
managed.os.statvfs = lambda _path: SimpleNamespace(f_blocks=256, f_frsize=4096)
managed.os.path.ismount = lambda _path: True
managed.Path.read_text = lambda *_args, **_kwargs: mountinfo
managed._validate_private_managed_mcp_tmpfs()

mountinfo += (
    f"32 31 0:26 / {directory} rw,nosuid,nodev - "
    "tmpfs tmpfs rw,size=1024k,mode=1777\n"
)
try:
    managed._validate_private_managed_mcp_tmpfs()
except RuntimeError as exc:
    assert "private bounded tmpfs" in str(exc)
else:
    raise AssertionError("accepted an ambiguous stacked private tmpfs")
print("stacked-private-tmpfs-rejected")
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("stacked-private-tmpfs-rejected");
  });

  it.runIf(process.platform === "linux")(
    "rejects a same-sized fully sealed descriptor not created by this process state",
    () => {
      const result = runManagedHelper(String.raw`
import fcntl
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

raw = b'{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer openshell:resolve:env:GITHUB_TOKEN"}}}}'
payload = managed._canonicalize_managed_mcp_config(raw)
assert payload is not None
local_descriptor, local_binding = managed._managed_mcp_snapshot(payload)
foreign_descriptor, foreign_binding = managed._managed_mcp_snapshot(payload)
assert local_binding["kind"] == managed._MCP_SEALED_KIND
assert foreign_binding["kind"] == managed._MCP_SEALED_KIND
managed._MANAGED_MCP_FD = local_descriptor
managed._MANAGED_MCP_BINDING = local_binding
managed._MANAGED_MCP_READY = True
local_path = f"/proc/self/fd/{local_descriptor}"
foreign_path = f"/proc/self/fd/{foreign_descriptor}"

assert os.fstat(local_descriptor).st_size == os.fstat(foreign_descriptor).st_size
assert fcntl.fcntl(local_descriptor, fcntl.F_GET_SEALS) == managed._MCP_REQUIRED_SEALS
assert fcntl.fcntl(foreign_descriptor, fcntl.F_GET_SEALS) == managed._MCP_REQUIRED_SEALS
assert managed.managed_mcp_server_descriptor(local_path) == local_descriptor
try:
    managed.managed_mcp_server_descriptor(foreign_path)
except RuntimeError as exc:
    assert "process-local" in str(exc)
else:
    raise AssertionError("foreign sealed descriptor was accepted")
finally:
    os.close(local_descriptor)
    os.close(foreign_descriptor)
print("descriptor-provenance-ok")
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("descriptor-provenance-ok");
    },
  );

  it.runIf(process.platform === "linux")(
    "falls back on blocked memfd with repeatable digest-bound child reads",
    () => {
      const result = runManagedHelper(String.raw`
import errno
import fcntl
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

raw = b'{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer openshell:resolve:env:GITHUB_TOKEN"}}}}'
payload = managed._canonicalize_managed_mcp_config(raw)
assert payload is not None

def blocked_memfd(*_args, **_kwargs):
    raise PermissionError(errno.EPERM, "blocked by seccomp")

with tempfile.TemporaryDirectory() as tempdir:
    managed._MCP_CONFIG_FILE = Path(tempdir) / ".nemoclaw-mcp.json"
    managed._read_managed_mcp_config = lambda: raw
    managed.os.memfd_create = blocked_memfd
    snapshot_path = managed.managed_mcp_config_path()
    assert snapshot_path is not None
    descriptor = int(snapshot_path.removeprefix("/proc/self/fd/"))
    binding = managed._MANAGED_MCP_BINDING
    assert binding is not None
    assert binding["kind"] == managed._MCP_ANONYMOUS_KIND
    metadata = os.fstat(descriptor)
    assert metadata.st_nlink == 0
    assert metadata.st_mode & 0o777 == 0
    assert fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY
    assert managed.managed_mcp_config_bytes(snapshot_path) == payload
    assert managed.managed_mcp_config_bytes(snapshot_path) == payload

    bound_descriptor, child_binding = managed.managed_mcp_server_binding(snapshot_path)
    assert bound_descriptor == descriptor
    child_code = """
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("_nemoclaw_managed_child", sys.argv[1])
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)
assert child.managed_mcp_config_bytes(sys.argv[2]) == child.managed_mcp_config_bytes(sys.argv[2])
assert child._MCP_CHILD_BINDING_ENV not in os.environ
print(child.managed_mcp_config_bytes(sys.argv[2]).decode(), end="")
"""
    child_env = os.environ.copy()
    child_env[managed._MCP_CHILD_BINDING_ENV] = child_binding
    for _start_or_restart in range(2):
        result = subprocess.run(
            [sys.executable, "-I", "-c", child_code, sys.argv[1], snapshot_path],
            pass_fds=(descriptor,),
            env=child_env,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode()
        assert result.stdout == payload

    os.environ[managed._MCP_CHILD_BINDING_ENV] = child_binding
    child_spec = importlib.util.spec_from_file_location("_nemoclaw_managed_child", sys.argv[1])
    child = importlib.util.module_from_spec(child_spec)
    child_spec.loader.exec_module(child)
    assert child.managed_mcp_config_bytes(snapshot_path) == payload
    assert child.managed_mcp_config_bytes(snapshot_path) == payload
    assert managed._MCP_CHILD_BINDING_ENV not in os.environ

    foreign_descriptor = managed._anonymous_managed_mcp_snapshot(payload)
    foreign_path = f"/proc/self/fd/{foreign_descriptor}"
    try:
        managed.managed_mcp_server_binding(foreign_path)
    except RuntimeError as exc:
        assert "not process-local" in str(exc)
    else:
        raise AssertionError("foreign anonymous descriptor was accepted by parent")
    try:
        child.managed_mcp_config_bytes(foreign_path)
    except RuntimeError as exc:
        assert "binding does not match" in str(exc)
    else:
        raise AssertionError("foreign anonymous descriptor was accepted by child")
    os.close(foreign_descriptor)

    os.fchmod(descriptor, 0o600)
    writer = os.open(snapshot_path, os.O_RDWR | os.O_CLOEXEC)
    os.pwrite(writer, b"!" + payload[1:], 0)
    os.close(writer)
    os.fchmod(descriptor, 0)
    tampered_child = subprocess.run(
        [sys.executable, "-I", "-c", child_code, sys.argv[1], snapshot_path],
        pass_fds=(descriptor,),
        env=child_env,
        capture_output=True,
    )
    assert tampered_child.returncode != 0
    assert b"contents changed" in tampered_child.stderr
    try:
        managed.managed_mcp_config_bytes(snapshot_path)
    except RuntimeError as exc:
        assert "contents changed" in str(exc)
    else:
        raise AssertionError("same-size anonymous descriptor overwrite was accepted")
    os.close(descriptor)
print("anonymous-fallback-ok")
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("anonymous-fallback-ok");
    },
  );

  it.runIf(process.platform === "linux")(
    "uses private tmpfs after /tmp rejects O_TMPFILE and preserves fail-closed errors (#8018)",
    () => {
      const result = runManagedHelper(String.raw`
import errno
import importlib.util
import os
import stat
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)
raw = b'{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer openshell:resolve:env:GITHUB_TOKEN"}}}}'
managed._read_managed_mcp_config = lambda: raw
payload = managed._canonicalize_managed_mcp_config(raw)
assert payload is not None

real_sealed_snapshot = managed._sealed_managed_mcp_snapshot
real_anonymous_snapshot = managed._anonymous_managed_mcp_snapshot
anonymous_calls = []

def tracked_anonymous_snapshot(snapshot_payload):
    anonymous_calls.append(snapshot_payload)
    return real_anonymous_snapshot(snapshot_payload)

def wrapped_eperm(_payload):
    try:
        raise PermissionError(errno.EPERM, "blocked by seccomp")
    except PermissionError as cause:
        raise RuntimeError("sealed snapshot unavailable") from cause

managed._sealed_managed_mcp_snapshot = wrapped_eperm
managed._anonymous_managed_mcp_snapshot = tracked_anonymous_snapshot
descriptor, binding = managed._managed_mcp_snapshot(payload)
try:
    assert binding["kind"] == managed._MCP_ANONYMOUS_KIND
    assert anonymous_calls == [payload]
    assert managed._read_bound_managed_mcp_descriptor(descriptor, binding) == payload
finally:
    os.close(descriptor)

def wrapped_emfile(_payload):
    try:
        raise OSError(errno.EMFILE, "too many open files")
    except OSError as cause:
        raise RuntimeError("sealed snapshot unavailable") from cause

managed._sealed_managed_mcp_snapshot = wrapped_emfile
try:
    managed._managed_mcp_snapshot(payload)
except RuntimeError as exc:
    assert str(exc) == "sealed snapshot unavailable"
    assert isinstance(exc.__cause__, OSError)
    assert exc.__cause__.errno == errno.EMFILE
    assert managed._managed_mcp_fallback_allowed(exc) is False
else:
    raise AssertionError("nested unrelated errno was masked by fallback")
assert anonymous_calls == [payload]
managed._sealed_managed_mcp_snapshot = real_sealed_snapshot
managed._anonymous_managed_mcp_snapshot = real_anonymous_snapshot

def blocked_memfd(*_args, **_kwargs):
    raise PermissionError(errno.EPERM, "blocked by seccomp")

with tempfile.TemporaryDirectory() as tempdir:
    managed._MCP_CONFIG_FILE = Path(tempdir) / ".nemoclaw-mcp.json"
    private_directory = Path(tempdir) / "private-tmpfs"
    private_directory.mkdir(mode=0o1777)
    managed._MCP_PRIVATE_ANONYMOUS_DIRECTORY = private_directory

    real_lstat = managed.os.lstat
    real_statvfs = managed.os.statvfs
    real_ismount = managed.os.path.ismount
    real_read_text = managed.Path.read_text
    mountinfo = (
        f"31 20 0:25 / {private_directory} rw,nosuid,nodev,noexec - "
        "tmpfs tmpfs rw,size=1024k,mode=1777\n"
    )
    managed.os.lstat = lambda _path: SimpleNamespace(st_mode=stat.S_IFDIR | 0o1777)
    managed.os.statvfs = lambda _path: SimpleNamespace(f_blocks=256, f_frsize=4096)
    managed.os.path.ismount = lambda _path: True
    managed.Path.read_text = lambda *_args, **_kwargs: mountinfo
    managed._validate_private_managed_mcp_tmpfs()

    def reject_invalid_private_tmpfs(label):
        try:
            managed._validate_private_managed_mcp_tmpfs()
        except RuntimeError as exc:
            assert "private bounded tmpfs" in str(exc), label
        else:
            raise AssertionError(f"accepted invalid private tmpfs: {label}")

    managed.os.statvfs = lambda _path: SimpleNamespace(f_blocks=257, f_frsize=4096)
    reject_invalid_private_tmpfs("oversized")
    managed.os.statvfs = lambda _path: SimpleNamespace(f_blocks=256, f_frsize=4096)
    mountinfo = mountinfo.replace(",nodev", "")
    reject_invalid_private_tmpfs("missing nodev")
    mountinfo = mountinfo.replace("rw,nosuid,noexec", "rw,nosuid,nodev,noexec")
    managed.os.path.ismount = lambda _path: False
    reject_invalid_private_tmpfs("not a mount point")

    managed.os.lstat = real_lstat
    managed.os.statvfs = real_statvfs
    managed.os.path.ismount = real_ismount
    managed.Path.read_text = real_read_text
    managed._validate_private_managed_mcp_tmpfs = lambda: None
    managed.os.memfd_create = blocked_memfd
    real_open = managed.os.open
    before = set(os.listdir("/proc/self/fd"))
    opened_directories = []

    def unsupported_tmpfile(path, flags, *args, **kwargs):
        if flags & os.O_TMPFILE:
            opened_directories.append(Path(path))
            if Path(path) == managed._MCP_ANONYMOUS_DIRECTORY:
                raise OSError(errno.EOPNOTSUPP, "O_TMPFILE unavailable")
        return real_open(path, flags, *args, **kwargs)

    managed.os.open = unsupported_tmpfile
    try:
        snapshot_path = managed.managed_mcp_config_path()
    finally:
        managed.os.open = real_open
    assert snapshot_path is not None
    descriptor = int(snapshot_path.removeprefix(managed._MCP_DESCRIPTOR_PREFIX))
    binding = managed._MANAGED_MCP_BINDING
    assert binding is not None
    assert binding["kind"] == managed._MCP_ANONYMOUS_KIND
    assert opened_directories == [managed._MCP_ANONYMOUS_DIRECTORY, private_directory]
    assert managed.managed_mcp_config_bytes(snapshot_path) == payload
    assert list(private_directory.iterdir()) == []
    os.close(descriptor)
    assert set(os.listdir("/proc/self/fd")) == before
    managed._MANAGED_MCP_FD = None
    managed._MANAGED_MCP_BINDING = None
    managed._MANAGED_MCP_READY = False

    managed.os.memfd_create = blocked_memfd
    def invalid_private_tmpfs():
        raise RuntimeError("managed MCP config requires a private bounded tmpfs")

    managed._validate_private_managed_mcp_tmpfs = invalid_private_tmpfs
    managed.os.open = unsupported_tmpfile
    try:
        managed.managed_mcp_config_path()
    except RuntimeError as exc:
        assert "private bounded tmpfs" in str(exc)
    else:
        raise AssertionError("invalid private tmpfs was accepted")
    finally:
        managed.os.open = real_open
    assert managed._MANAGED_MCP_FD is None
    assert managed._MANAGED_MCP_BINDING is None
    assert managed._MANAGED_MCP_READY is False

    def exhausted_memfd(*_args, **_kwargs):
        raise OSError(errno.EMFILE, "too many open files")

    managed.os.memfd_create = exhausted_memfd
    try:
        managed.managed_mcp_config_path()
    except RuntimeError as exc:
        assert "sealed memfd support" in str(exc)
    else:
        raise AssertionError("unexpected memfd error was masked by fallback")
print("fallback-fail-closed-ok")
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("fallback-fail-closed-ok");
    },
  );
});
