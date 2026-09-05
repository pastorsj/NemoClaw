# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local POC final image. Source builds must provide the package base explicitly.

ARG BASE_IMAGE
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# hadolint ignore=DL3066
USER root

COPY packages/nemoclaw-fabric/pyproject.toml packages/nemoclaw-fabric/README.md /opt/nemoclaw-fabric-runner/
COPY packages/nemoclaw-fabric/src/ /opt/nemoclaw-fabric-runner/src/
COPY packages/nemoclaw-fabric/build-requirements.lock /tmp/nemoclaw-fabric-build-requirements.lock
COPY packages/nemoclaw-deepseek-harness/fabric/pyproject.toml /opt/nemoclaw-deepseek-fabric/
COPY packages/nemoclaw-deepseek-harness/fabric/src/ /opt/nemoclaw-deepseek-fabric/src/
COPY packages/nemoclaw-deepseek-harness/fabric/deepseek.fabric-adapter.json /usr/local/share/nemoclaw/deepseek.fabric-adapter.json
COPY packages/nemoclaw-deepseek-harness/config/generate-config.py /opt/nemoclaw-deepseek-harness/generate-config.py
COPY packages/nemoclaw-deepseek-harness/runtime/generate-config.sh /usr/local/lib/nemoclaw/generate-config
COPY packages/nemoclaw-deepseek-harness/start.sh /usr/local/bin/nemoclaw-start
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Build only the two first-party wheels. Third-party dependencies were installed
# from the package lock in Dockerfile.base.
RUN set -eu; \
    python3 -I -c 'import tomllib; from pathlib import Path; runner = tomllib.loads(Path("/opt/nemoclaw-fabric-runner/pyproject.toml").read_text(encoding="utf-8"))["project"]; adapter = tomllib.loads(Path("/opt/nemoclaw-deepseek-fabric/pyproject.toml").read_text(encoding="utf-8"))["project"]; assert (runner["name"], runner["version"]) == ("nemoclaw-fabric", "0.1.2"); assert (adapter["name"], adapter["version"]) == ("nemoclaw-deepseek-fabric", "0.1.0")' \
    && python3 -m venv --copies /tmp/nemoclaw-fabric-build-venv \
    && /tmp/nemoclaw-fabric-build-venv/bin/pip3 install --no-cache-dir --require-hashes \
        -r /tmp/nemoclaw-fabric-build-requirements.lock \
    && install -d -o root -g root -m 0755 /tmp/nemoclaw-fabric-wheels \
    && /tmp/nemoclaw-fabric-build-venv/bin/pip3 wheel --no-index --no-deps --no-build-isolation \
        --wheel-dir /tmp/nemoclaw-fabric-wheels /opt/nemoclaw-fabric-runner /opt/nemoclaw-deepseek-fabric \
    && set -- /tmp/nemoclaw-fabric-wheels/nemoclaw_fabric-0.1.2-*.whl \
    && test "$#" -eq 1 \
    && runner_wheel="$1" \
    && set -- /tmp/nemoclaw-fabric-wheels/nemoclaw_deepseek_fabric-0.1.0-*.whl \
    && test "$#" -eq 1 \
    && adapter_wheel="$1" \
    && /opt/nemoclaw-fabric-venv/bin/pip3 install --no-index --no-cache-dir --no-deps \
        "$runner_wheel" "$adapter_wheel" \
    && /opt/nemoclaw-fabric-venv/bin/pip3 check \
    && /opt/nemoclaw-fabric-venv/bin/python3 -I -c \
        'from importlib.metadata import version; assert version("nemoclaw-fabric") == "0.1.2"; assert version("nemoclaw-deepseek-fabric") == "0.1.0"; import nemoclaw_deepseek_fabric.adapter' \
    && ln -s /opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric /usr/local/bin/nemoclaw-fabric \
    && ln -s /opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run /usr/local/bin/nemoclaw-fabric-run \
    && test "$(readlink /usr/local/bin/nemoclaw-fabric-run)" = "/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run" \
    && /usr/local/bin/nemoclaw-fabric-run --help >/dev/null \
    && test "$(/usr/local/bin/nemoclaw-fabric --version)" = "nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)" \
    && chown root:root /usr/local/share/nemoclaw/deepseek.fabric-adapter.json \
        /opt/nemoclaw-deepseek-harness/generate-config.py \
        /usr/local/lib/nemoclaw/generate-config /usr/local/bin/nemoclaw-start \
    && chmod 0444 /usr/local/share/nemoclaw/deepseek.fabric-adapter.json \
        /opt/nemoclaw-deepseek-harness/generate-config.py \
    && chmod 0555 /usr/local/lib/nemoclaw/generate-config /usr/local/bin/nemoclaw-start \
    && chmod -R a+rX /opt/nemoclaw-blueprint \
    && rm -rf /opt/nemoclaw-fabric-runner /opt/nemoclaw-deepseek-fabric \
        /tmp/nemoclaw-fabric-build-venv /tmp/nemoclaw-fabric-wheels \
        /tmp/nemoclaw-fabric-build-requirements.lock

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions

# hadolint ignore=DL3064
ENV HOME=/sandbox \
    PATH="/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DSH_HOME=/sandbox/.deepseek-harness \
    DSH_TELEMETRY_MODE=DISABLED \
    DSH_TELEMETRY_DISABLED=1 \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API}

WORKDIR /sandbox
# hadolint ignore=DL3066
USER sandbox
RUN umask 077 \
    && mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && /usr/local/lib/nemoclaw/generate-config \
    && test "$(stat -c %a /sandbox/.deepseek-harness/fabric.json)" = "600" \
    && DEEPSEEK_FABRIC_API_KEY=nemoclaw-managed-inference /usr/local/bin/nemoclaw-fabric doctor \
        --config /sandbox/.deepseek-harness/fabric.json --json >/tmp/nemoclaw-deepseek-doctor.json \
    && python3 -I -c 'import json; report=json.load(open("/tmp/nemoclaw-deepseek-doctor.json", encoding="utf-8")); assert report["status"] in {"pass", "warn"}' \
    && rm -f /tmp/nemoclaw-deepseek-doctor.json

# The entrypoint needs its initial root identity only to repair ownership on a
# mounted state directory, then drops to the sandbox user before running work.
# hadolint ignore=DL3002,DL3066
USER root
RUN chown root:sandbox /sandbox \
    && chmod 1775 /sandbox \
    && chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 0755 /sandbox/.nemoclaw/blueprints \
    && install -d -o sandbox -g sandbox -m 0700 \
        /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration \
        /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD []
