# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import importlib.util
import base64
import binascii
import hashlib
import os
import re
import stat
import subprocess
import sys
import time

LAST_SANITIZED_STATUS = None
STATUS_PATH = '/tmp/nemoclaw-auto-pair-status.json'


def publish_status(state):
    global LAST_SANITIZED_STATUS
    if state == LAST_SANITIZED_STATUS:
        return
    LAST_SANITIZED_STATUS = state
    status = json.dumps({
        'schemaVersion': 1,
        'state': state,
    }, separators=(',', ':'))
    print('[auto-pair-status] ' + status, flush=True)
    status_fd = None
    try:
        status_fd = os.open(
            STATUS_PATH,
            os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        metadata = os.fstat(status_fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise OSError('unsafe watcher status metadata')
        os.ftruncate(status_fd, 0)
        remaining = status.encode('utf-8')
        while remaining:
            written = os.write(status_fd, remaining)
            if written <= 0:
                raise OSError('watcher status write made no progress')
            remaining = remaining[written:]
    except Exception:
        pass
    finally:
        if status_fd is not None:
            os.close(status_fd)


print('[auto-pair] watcher started', flush=True)
publish_status('running')


def report_unhandled_watcher_exception(exc_type, _exc_value, _traceback):
    publish_status('stopped')
    print(f'[auto-pair] stage=watcher-execution failed error={exc_type.__name__}', flush=True)


sys.excepthook = report_unhandled_watcher_exception

APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'


def load_approval_policy(path):
    helper_stat = os.stat(path)
    mode = helper_stat.st_mode
    if mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RuntimeError('approval policy helper is writable by group or other')
    if helper_stat.st_uid == os.geteuid() and mode & stat.S_IWUSR:
        raise RuntimeError('approval policy helper is writable by the current user')
    spec = importlib.util.spec_from_file_location('openclaw_device_approval_policy', path)
    if spec is None or spec.loader is None:
        raise RuntimeError('approval policy helper could not be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return (
        module.approval_request_decision,
        module.gateway_approval_env,
        module.ALLOWED_SCOPES,
    )


approval_request_decision, gateway_approval_env, policy_allowed_scopes = load_approval_policy(APPROVAL_POLICY_FILE)

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')


def _env_seconds(name, default):
    raw = os.environ.get(name, '').strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


# Total runtime cap. After convergence the watcher polls at a slow cadence,
# so it can stay alive for the typical sandbox session without saturating
# the gateway. Late `openclaw agent` runs (NemoClaw#4263) request additional
# scopes that the gateway holds as pending until something approves them; an
# exited watcher leaves those upgrades stuck and the agent falls back to
# embedded mode. Defaults: 8h total, 5s slow-mode cadence.
DEADLINE = time.time() + _env_seconds('NEMOCLAW_AUTO_PAIR_DEADLINE_SECS', 28800)
# After convergence the watcher polls at SLOW_INTERVAL. A late allowlisted
# scope upgrade — e.g. `openclaw tui` or `openclaw agent` invoked after the
# watcher entered slow mode — can wait up to SLOW_INTERVAL before being
# approved, which is longer than the OpenClaw client's tolerance for `scope
# upgrade pending approval` and forces a fallback to embedded mode. The
# default sits well below typical client-side wait windows; raise it through
# NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS when the gateway connect handler is
# load-sensitive. When the watcher successfully approves a fresh allowlisted
# request during slow mode it also bumps a bounded fast-reentry counter
# (NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS) that drops polling back to 1s for
# the next few iterations, so cascading upgrades and transient approve
# failures both clear before the OpenClaw client gives up. The counter is
# only bumped on the rising edge for each requestId (tracked in
# FAST_REENTRY_BUMPED_REQUEST_IDS and garbage-collected against the live
# pending list). After canonical settlement, a sticky failing request cannot
# repeatedly rearm fast reentry. Before settlement, the watcher stays at the
# 1s cadence by design. This is a polling-cadence fix only. Non-allowlisted scopes such
# as `operator.admin` are still rejected by the device approval policy, and
# requests that need them must be approved through a separate operator path.
SLOW_INTERVAL = _env_seconds('NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS', 5)
# Fast reentry temporarily restores 1s polling after a fresh allowlisted
# request; canonical settlement and approval policy remain unchanged.
FAST_REENTRY_POLLS = int(_env_seconds('NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS', 5))
FAST_REENTRY_INTERVAL = _env_seconds('NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS', 1)
FAST_REENTRY_REMAINING = 0
FAST_REENTRY_BUMPED_REQUEST_IDS = set()
APPROVED = 0
SLOW_MODE = False
HANDLED = set()  # Track rejected/approved requestIds to avoid reprocessing
OBSERVED_REQUEST_IDS = set()
VALIDATED_REQUEST_IDS = set()
LAST_LIST_FAILURE_REASON = None
REQUEST_CREATION_WAITING_REPORTED = False
PAIRING_BOOTSTRAPPED = False
MALFORMED_REQUEST_ID_REPORTED = False
# SECURITY NOTE: clientId/clientMode are client-supplied and spoofable
# (the gateway stores connectParams.client.id verbatim). The policy requires
# an explicit known clientId and never trusts an allowlisted mode by itself.
# This remains defense-in-depth, not a trust boundary. PR #690 adds one-shot
# exit, timeout reduction, and token cleanup for a more comprehensive fix.
# The approval_request_decision helper is shared with connect-time approvals.

RUN_TIMEOUT_SECS = _env_seconds('NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS', 10)


def _read_json_object(path):
    with open(path, 'r', encoding='utf-8') as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f'{path} is not a JSON object')
    return data


def _identity_public_key(identity):
    raw = str(identity.get('publicKey', '') or '').strip()
    if raw:
        return raw
    pem = str(identity.get('publicKeyPem', '') or '')
    body = ''.join(line.strip() for line in pem.splitlines() if '---' not in line)
    if not body:
        return ''
    der = base64.b64decode(body)
    if len(der) < 32:
        return ''
    return base64.urlsafe_b64encode(der[-32:]).decode('ascii').rstrip('=')


def _local_device_identity():
    state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
    identity = _read_json_object(os.path.join(state_dir, 'identity', 'device.json'))
    device_id = str(identity.get('deviceId', '') or '').strip()
    public_key = _identity_public_key(identity)
    public_key_raw = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
    if (
        not device_id
        or len(public_key_raw) != 32
        or hashlib.sha256(public_key_raw).hexdigest() != device_id
    ):
        raise RuntimeError('local device identity is invalid')
    return device_id, public_key


def is_local_cli_request(request):
    if not isinstance(request, dict):
        return False
    try:
        device_id, public_key = _local_device_identity()
    except (OSError, ValueError, RuntimeError, binascii.Error):
        return False
    return (
        request.get('deviceId') == device_id
        and request.get('publicKey') == public_key
        and request.get('clientId') == 'cli'
        and request.get('clientMode') == 'cli'
    )


def initial_cli_request_is_allowlisted(request_id):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list bootstrap):
    # Invalid state: `devices list --json` can be gated by the same initial
    # CLI pairing request the watcher needs to approve, so the request id is
    # only available in the structured error text.
    # Source boundary: this function reads local OpenClaw pending/identity
    # state only to validate the parsed request id before delegating approval
    # back to `openclaw devices approve`, which owns locking, token creation,
    # and state publication. The watcher never writes OpenClaw state.
    # Source-fix constraint: OpenClaw should expose a first-run local
    # bootstrap/list API that returns the pending request without requiring an
    # already-approved device. This compatibility path supports packaged
    # gateway builds that still gate list.
    # Removal condition: delete this branch once the pinned OpenClaw release
    # exposes that bootstrap/list API and NemoClaw no longer supports gated
    # list behavior for first-run CLI pairing.
    state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
    pending_path = os.path.join(state_dir, 'devices', 'pending.json')
    identity_path = os.path.join(state_dir, 'identity', 'device.json')
    try:
        pending = _read_json_object(pending_path)
        identity = _read_json_object(identity_path)
        request = pending.get(request_id)
        if not isinstance(request, dict):
            return False
        # The map key is the authoritative request id. Reject a record whose
        # embedded requestId is missing or disagrees with its key, so a
        # malformed/tampered pending.json cannot approve a mismatched request.
        # (PR #6330 review, cv item 3.)
        if str(request.get('requestId', '') or '').strip() != str(request_id).strip():
            return False
        device_id = str(identity.get('deviceId', '') or '').strip()
        public_key = _identity_public_key(identity)
        if not device_id or not public_key:
            return False
        public_key_raw = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
        if len(public_key_raw) != 32 or hashlib.sha256(public_key_raw).hexdigest() != device_id:
            return False
        if str(request.get('deviceId', '')).strip() != device_id:
            return False
        if str(request.get('publicKey', '')).strip() != public_key:
            return False
        # OpenClaw CLI initial pairing records use clientId/clientMode `cli`
        # in the observed DGX Spark/Station repros and in the paired-state
        # fixtures for this PR. The broader policy still handles normal
        # openclaw-cli scope upgrades through the main pending-list branch.
        if str(request.get('clientId', '')).strip() != 'cli':
            return False
        if str(request.get('clientMode', '')).strip() != 'cli':
            return False
        roles = set()
        role = request.get('role')
        if role is not None:
            if not isinstance(role, str) or not role.strip():
                return False
            roles.add(role.strip())
        raw_roles = request.get('roles')
        if raw_roles is not None:
            if not isinstance(raw_roles, list):
                return False
            for item in raw_roles:
                if not isinstance(item, str) or not item.strip():
                    return False
                roles.add(item.strip())
        if roles != {'operator'}:
            return False
        raw_scopes = request.get('scopes')
        if not isinstance(raw_scopes, list) or not raw_scopes:
            return False
        scopes = set()
        for item in raw_scopes:
            if not isinstance(item, str) or not item.strip():
                return False
            scope = item.strip()
            if scope not in policy_allowed_scopes or scope in scopes:
                return False
            scopes.add(scope)
        if scopes != {'operator.pairing'}:
            return False
        return approval_request_decision(request)['allowed'] is True
    except (OSError, ValueError, RuntimeError, binascii.Error) as err:
        print(f'[auto-pair] initial CLI pairing validation skipped request={request_id}: {brief_child_error("", str(err))}')
        return False


def is_pairing_required_list_failure(out, err):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list failure detection):
    # Invalid state: initial `openclaw devices list --json` returns the gateway
    # pairing-required denial instead of the pending request list.
    # Source boundary: the compatibility trigger only recognizes the stable
    # gateway denial text and still requires local pending/identity validation
    # before approval is delegated to OpenClaw.
    # Source-fix constraint: OpenClaw should expose a structured bootstrap/list
    # API for first-run CLI pairing.
    # Regression test: the non-pairing error fixture must not call approve.
    # Removal condition: delete with initial_cli_request_is_allowlisted once the
    # pinned OpenClaw release exposes that bootstrap/list API.
    message = f'{out}\n{err}'.lower()
    return 'pairing required' in message and 'device is not approved yet' in message


REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')


def _structured_request_ids(text):
    try:
        data = json.loads(text)
    except Exception:
        return []
    found = []

    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {'requestId', 'request_id'} and isinstance(item, str):
                    found.append(item.strip())
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(data)
    return found


def pairing_required_request_id(out, err):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list requestId extraction):
    # Invalid state: the requestId needed for canonical `devices approve` is
    # sometimes only present in the list denial payload.
    # Source boundary: parse one bounded requestId from structured JSON first,
    # then from the reviewed error-text forms; ambiguous, overlong, or malformed
    # output fails closed and never reaches approve.
    # Source-fix constraint: OpenClaw should return requestId in a stable
    # structured error field for this first-run bootstrap path.
    # Regression test: malformed, overlong, whitespace, and multiple requestIds
    # must not call approve.
    # Removal condition: delete with initial_cli_request_is_allowlisted once the
    # pinned OpenClaw release exposes a bootstrap/list API.
    if not is_pairing_required_list_failure(out, err):
        return None
    message = f'{out}\n{err}'
    if len(re.findall(r'\brequestId\b', message)) != 1:
        return None
    candidates = []
    for text in (out, err):
        candidates.extend(_structured_request_ids(text))
    candidates.extend(
        next(group for group in match.groups() if group is not None)
        for match in re.finditer(
            r'\brequestId\b["\']?\s*[:=]\s*(?:"([A-Za-z0-9._:-]{1,128})"(?=$|[,}\]\)])|\'([A-Za-z0-9._:-]{1,128})\'(?=$|[,}\]\)])|([A-Za-z0-9._:-]{1,128})(?=$|[,}\]\)]))',
            message,
        )
    )
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(r'\(requestId:\s*([A-Za-z0-9._:-]{1,128})\)', message)
    )
    valid = [candidate for candidate in candidates if REQUEST_ID_RE.fullmatch(candidate)]
    if not valid or len(set(valid)) != 1 or len(valid) != len(candidates):
        return None
    return valid[0]


def brief_child_error(out, err):
    # SOURCE_OF_TRUTH_REVIEW (auto-pair child error summary):
    # Invalid state: child openclaw failures often include noisy locale/setup
    # output before the actual error.
    # Source boundary: logs only the last non-empty child line, capped to 400
    # characters; decisions never depend on this summary.
    # Source-fix constraint: OpenClaw should expose structured error codes so
    # callers do not need stdout/stderr message summaries.
    # Regression test: approve-failure fixtures assert the actionable child
    # error remains visible.
    # Removal condition: retire when OpenClaw CLI returns structured errors for
    # the watched devices list/approve calls.
    lines = [line.strip() for line in f'{err}\n{out}'.splitlines() if line.strip()]
    return (lines[-1] if lines else '')[:400]


def report_request_observed(request_id, publish_sanitized=True):
    if request_id in OBSERVED_REQUEST_IDS:
        return
    OBSERVED_REQUEST_IDS.add(request_id)
    if publish_sanitized:
        publish_status('request-observed')
    print(f'[auto-pair] stage=request-creation observed request={request_id}')


def report_request_validation(request_id, accepted, reason, publish_sanitized=True):
    if request_id in VALIDATED_REQUEST_IDS:
        return
    VALIDATED_REQUEST_IDS.add(request_id)
    outcome = 'accepted' if accepted else 'rejected'
    if not accepted and publish_sanitized:
        publish_status('request-rejected')
    print(f'[auto-pair] stage=validation {outcome} request={request_id} reason={reason}')


def exact_string_set(value, expected):
    return (
        isinstance(value, list)
        and len(value) == len(expected)
        and all(isinstance(item, str) for item in value)
        and set(value) == expected
    )


def canonical_cli_baseline_settled(paired, pending):
    try:
        local_device_id, local_public_key = _local_device_identity()
    except (OSError, ValueError, RuntimeError, binascii.Error):
        return False
    candidates = [
        device for device in paired
        if isinstance(device, dict)
        and device.get('deviceId') == local_device_id
        and device.get('publicKey') == local_public_key
        and device.get('clientId') == 'cli'
        and device.get('clientMode') == 'cli'
        and device.get('role') == 'operator'
        and exact_string_set(device.get('roles'), {'operator'})
        and exact_string_set(device.get('scopes'), {'operator.pairing', 'operator.write'})
        and exact_string_set(device.get('approvedScopes'), {'operator.pairing', 'operator.write'})
    ]
    if len(candidates) != 1:
        return False
    device = candidates[0]
    device_id = str(device.get('deviceId', '') or '').strip()
    tokens = device.get('tokens')
    operator = tokens.get('operator') if isinstance(tokens, dict) and set(tokens) == {'operator'} else None
    if (
        not device_id
        or not isinstance(operator, dict)
        or operator.get('role') != 'operator'
        or operator.get('revokedAtMs') is not None
        or not exact_string_set(
            operator.get('scopes'),
            {'operator.pairing', 'operator.read', 'operator.write'},
        )
    ):
        return False
    return not any(
        isinstance(request, dict) and str(request.get('deviceId', '') or '').strip() == device_id
        for request in pending
    )


def list_failure_reason(rc, out, err):
    if rc == 124:
        return 'timeout'
    if is_pairing_required_list_failure(out, err):
        return 'pairing-required'
    if rc != 0:
        return 'command-failed'
    return 'empty-output'

# Workaround boundary (NemoClaw#4462): the watcher child sources the trusted
# runtime environment, so its first list call resolves the live gateway through
# local loopback and retains the shared token plus a private child marker. The
# reviewed 2026.7.1 dist patch uses that marker to retain CLI identity before a
# stored device credential exists. Once OpenClaw issues that credential, later
# list calls drop the gateway env triplet and use the reviewed settlement marker
# to select pairing-only stored-device auth. Approval calls keep their separate
# bounded credential selection. Remove these pieces when upstream supports that
# flow.
def run(*args, strip_gateway_env=False, force_device_pairing=False, pairing_settlement=False):
    # Bound every openclaw CLI invocation so a wedged child cannot pin
    # the watcher beyond DEADLINE (CodeRabbit #4292): subprocess.run with
    # no timeout would hold a hung `openclaw devices list/approve` past
    # the fast→slow transition and the 8h deadline check.
    env = None
    if strip_gateway_env:
        env = gateway_approval_env(os.environ)
        env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
        if pairing_settlement:
            env['NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT'] = '1'
    elif force_device_pairing:
        env = dict(os.environ)
        env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
        env['NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING'] = '1'
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=RUN_TIMEOUT_SECS, env=env,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired as exc:
        # 124 matches GNU `timeout` exit status so log scrapers can spot it.
        out = (exc.stdout or '') if isinstance(exc.stdout, str) else ''
        err = (exc.stderr or '') if isinstance(exc.stderr, str) else ''
        print(f'[auto-pair] timeout calling {args[1] if len(args) > 1 else "openclaw"} {args[2] if len(args) > 2 else ""}'.rstrip())
        return 124, out.strip(), err.strip()


def sleep_for_next_poll(default_seconds, productive=True):
    # Apply the bounded fast-reentry override before the caller's default
    # sleep so a recent allowlisted approval (which bumps the remaining
    # counter) drops polling to FAST_REENTRY_INTERVAL for the next few
    # iterations. Mutates the global counter so callers do not need to
    # thread the state through. The override is floored by the caller's
    # default so it never increases the inter-poll latency (e.g. when the
    # default is already tighter than FAST_REENTRY_INTERVAL during a
    # bounded retry pass in fast mode).
    #
    # Error-path callers pass productive=False so a string of gateway
    # errors or JSON-parse failures after a fast-reentry bump does not
    # silently drain the bounded window before a productive poll observes
    # the cascading upgrades.
    global FAST_REENTRY_REMAINING
    if FAST_REENTRY_REMAINING > 0:
        if productive:
            FAST_REENTRY_REMAINING -= 1
        time.sleep(min(FAST_REENTRY_INTERVAL, default_seconds))
        return
    time.sleep(default_seconds)


while time.time() < DEADLINE:
    rc, out, err = run(
        OPENCLAW,
        'devices',
        'list',
        '--json',
        strip_gateway_env=PAIRING_BOOTSTRAPPED,
        force_device_pairing=not PAIRING_BOOTSTRAPPED,
        pairing_settlement=PAIRING_BOOTSTRAPPED,
    )
    if rc != 0 or not out:
        failure_reason = list_failure_reason(rc, out, err)
        if failure_reason != LAST_LIST_FAILURE_REASON:
            print(f'[auto-pair] stage=listing failed reason={failure_reason}')
            LAST_LIST_FAILURE_REASON = failure_reason
        initial_request_id = pairing_required_request_id(out, err)
        if initial_request_id and initial_request_id not in HANDLED:
            live_request_ids = {initial_request_id}
            HANDLED.intersection_update(live_request_ids)
            OBSERVED_REQUEST_IDS.intersection_update(live_request_ids)
            VALIDATED_REQUEST_IDS.intersection_update(live_request_ids)
            FAST_REENTRY_BUMPED_REQUEST_IDS.intersection_update(live_request_ids)
            report_request_observed(initial_request_id)
            initial_request_allowed = initial_cli_request_is_allowlisted(initial_request_id)
            report_request_validation(
                initial_request_id,
                initial_request_allowed,
                'allowlisted-initial-cli' if initial_request_allowed else 'not-allowlisted',
            )
        else:
            initial_request_allowed = False
        if initial_request_id and initial_request_id not in HANDLED and initial_request_allowed:
            print(f'[auto-pair] stage=approval attempting request={initial_request_id}')
            arc, aout, aerr = run(
                OPENCLAW, 'devices', 'approve', initial_request_id, '--json', strip_gateway_env=True,
            )
            if arc == 0:
                HANDLED.add(initial_request_id)
                APPROVED += 1
                publish_status('approval-completed')
                print(f'[auto-pair] approved initial CLI pairing request={initial_request_id}')
                FAST_REENTRY_REMAINING = max(FAST_REENTRY_REMAINING, FAST_REENTRY_POLLS)
                sleep_for_next_poll(FAST_REENTRY_INTERVAL)
                continue
            approval_failure_reason = 'timeout' if arc == 124 else 'command-failed'
            publish_status('approval-timeout' if arc == 124 else 'approval-failed')
            print(f'[auto-pair] stage=approval failed reason={approval_failure_reason}')
            failure = brief_child_error(aout, aerr)
            if arc != 124 and failure:
                print(f'[auto-pair] initial CLI approve failed request={initial_request_id}: {failure}')
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue
    try:
        data = json.loads(out)
    except Exception:
        if LAST_LIST_FAILURE_REASON != 'invalid-json':
            print('[auto-pair] stage=listing failed reason=invalid-json')
            LAST_LIST_FAILURE_REASON = 'invalid-json'
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue
    if not isinstance(data, dict):
        if LAST_LIST_FAILURE_REASON != 'invalid-response':
            print('[auto-pair] stage=listing failed reason=invalid-response')
            LAST_LIST_FAILURE_REASON = 'invalid-response'
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue
    pending = data.get('pending')
    paired = data.get('paired')
    if not isinstance(pending, list) or not isinstance(paired, list):
        if LAST_LIST_FAILURE_REASON != 'invalid-response':
            print('[auto-pair] stage=listing failed reason=invalid-response')
            LAST_LIST_FAILURE_REASON = 'invalid-response'
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue
    LAST_LIST_FAILURE_REASON = None
    has_cli_pairing = any(
        d.get('clientId') == 'cli' and d.get('clientMode') == 'cli'
        for d in paired
        if isinstance(d, dict)
    )
    if not PAIRING_BOOTSTRAPPED and has_cli_pairing:
        PAIRING_BOOTSTRAPPED = True
        print('[auto-pair] loopback CLI pairing bootstrap completed')
    normalized_pending = []
    saw_malformed_request_id = False
    for device in pending:
        request_id = device.get('requestId') if isinstance(device, dict) else None
        if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
            saw_malformed_request_id = True
            if not MALFORMED_REQUEST_ID_REPORTED:
                print('[auto-pair] stage=validation rejected reason=malformed-request-id')
                MALFORMED_REQUEST_ID_REPORTED = True
            continue
        normalized_pending.append((request_id, device))
    if not saw_malformed_request_id:
        MALFORMED_REQUEST_ID_REPORTED = False
    pending_request_ids = {request_id for request_id, _device in normalized_pending}
    HANDLED.intersection_update(pending_request_ids)
    OBSERVED_REQUEST_IDS.intersection_update(pending_request_ids)
    VALIDATED_REQUEST_IDS.intersection_update(pending_request_ids)
    FAST_REENTRY_BUMPED_REQUEST_IDS.intersection_update(pending_request_ids)

    if not normalized_pending and not paired and APPROVED == 0 and not REQUEST_CREATION_WAITING_REPORTED:
        publish_status('request-not-produced')
        print('[auto-pair] stage=request-creation waiting reason=no-request')
        REQUEST_CREATION_WAITING_REPORTED = True

    if normalized_pending:
        attempted_request_ids = set()
        for request_id, device in normalized_pending:
            if request_id in HANDLED:
                continue
            tracks_canonical_cli = is_local_cli_request(device)
            report_request_observed(request_id, tracks_canonical_cli)
            decision = approval_request_decision(device)
            client_id = decision['client_id']
            client_mode = decision['client_mode']
            if decision['reason'] == 'unknown-client':
                HANDLED.add(request_id)
                report_request_validation(
                    request_id, False, 'unknown-client', tracks_canonical_cli,
                )
                print(f'[auto-pair] rejected unknown client={client_id} mode={client_mode}')
                continue
            if decision['reason'] == 'malformed-scopes':
                HANDLED.add(request_id)
                report_request_validation(
                    request_id, False, 'malformed-scopes', tracks_canonical_cli,
                )
                print(f'[auto-pair] rejected malformed scopes client={client_id} mode={client_mode}')
                continue
            if decision['reason'] == 'disallowed-scopes':
                HANDLED.add(request_id)
                scopes = decision['scopes']
                report_request_validation(
                    request_id, False, 'disallowed-scopes', tracks_canonical_cli,
                )
                print(f'[auto-pair] rejected disallowed scopes={sorted(scopes)} client={client_id} mode={client_mode}')
                continue
            report_request_validation(
                request_id, True, 'allowlisted-request', tracks_canonical_cli,
            )
            attempted_request_ids.add(request_id)
            print(f'[auto-pair] stage=approval attempting request={request_id}')
            arc, aout, aerr = run(
                OPENCLAW, 'devices', 'approve', request_id, '--json', strip_gateway_env=True,
            )
            # rc=124 is the timeout sentinel from run() — do NOT add the
            # request to HANDLED on a transient timeout, so the next poll
            # can retry (CodeRabbit #4292). Other approve failures stay
            # retryable too; only intentionally rejected unknown clients
            # and confirmed successful approvals are marked handled.
            if arc == 124:
                if tracks_canonical_cli:
                    publish_status('approval-timeout')
                print('[auto-pair] stage=approval failed reason=timeout')
                continue
            if arc == 0:
                HANDLED.add(request_id)
                APPROVED += 1
                if tracks_canonical_cli:
                    publish_status('approval-completed')
                print(f'[auto-pair] approved request={request_id} client={client_id} mode={client_mode}')
            else:
                if tracks_canonical_cli:
                    publish_status('approval-failed')
                print('[auto-pair] stage=approval failed reason=command-failed')
                failure = brief_child_error(aout, aerr)
                if failure:
                    print(f'[auto-pair] approve failed request={request_id}: {failure}')
        # Fast reentry is armed once for each freshly observed allowlisted
        # request. After canonical settlement, a sticky failure cannot
        # repeatedly rearm the temporary 1s cadence. Cascading approvals from
        # new request IDs still trigger the bounded override.
        new_attempted_ids = attempted_request_ids - FAST_REENTRY_BUMPED_REQUEST_IDS
        # Bump in fast mode too: the cadence override is a no-op there
        # (min(FAST_REENTRY_INTERVAL=1, default=1) = 1) but the requestId
        # is still recorded in FAST_REENTRY_BUMPED_REQUEST_IDS so the same
        # sticky id cannot re-arm the counter later when the watcher
        # transitions into slow mode.
        if new_attempted_ids and FAST_REENTRY_POLLS > 0:
            FAST_REENTRY_REMAINING = FAST_REENTRY_POLLS
            FAST_REENTRY_BUMPED_REQUEST_IDS.update(new_attempted_ids)
            mode_label = 'slow' if SLOW_MODE else 'fast'
            print(f'[auto-pair] fast-reentry bumped polls={FAST_REENTRY_POLLS} approved={APPROVED} mode={mode_label}')
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1)
        continue

    # Fresh onboarding relies on this watcher as the only scope-upgrade
    # approver. Keep the one-second cadence until the canonical CLI record has
    # the exact baseline scopes and no same-device pending request. Browser
    # pairing, an unrelated paired device, or elapsed time cannot establish
    # this transition.
    if not SLOW_MODE and canonical_cli_baseline_settled(paired, pending):
        SLOW_MODE = True
        publish_status('canonical-settled')
        print(f'[auto-pair] canonical CLI baseline settled; entering slow-mode approvals={APPROVED}')

    # Poll every 1s until canonical CLI settlement, then use SLOW_INTERVAL
    # (default 5s). Slow-mode keepalive lets late CLI
    # scope upgrades get approved through the rest of DEADLINE without
    # hammering the gateway. The bounded fast-reentry counter (bumped above
    # when an allowlisted upgrade was attempted) overrides whichever tier
    # is selected here so the next few polls catch cascading upgrades.
    if SLOW_MODE:
        sleep_for_next_poll(SLOW_INTERVAL)
    else:
        sleep_for_next_poll(1)
else:
    publish_status('stopped')
    print(f'[auto-pair] watcher deadline reached approvals={APPROVED}')
