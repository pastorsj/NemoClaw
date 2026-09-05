# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Local-only Haystack Agent POC image. Direct builds must supply the immutable
# base image produced from Dockerfile.base.
# hadolint global ignore=DL3066,SC2016

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_TEMPERATURE=0
ARG NEMOCLAW_MAX_TURNS=8

USER root

# The current immutable POC base predates the shared NemoClaw curl probe.
# Dockerfile.base now owns this dependency; keep this conditional compatibility
# install until every consumed base digest has been rebuilt from that source.
# hadolint ignore=DL3008
RUN if [ ! -x /usr/bin/curl ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends curl=8.14.1-2+deb13u4 \
        && rm -rf /var/lib/apt/lists/*; \
    fi \
    && test -x /usr/bin/curl \
    && test -z "$(dpkg --audit)"

COPY packages/nemoclaw-fabric/pyproject.toml packages/nemoclaw-fabric/README.md /opt/nemoclaw-fabric-runner/
COPY packages/nemoclaw-fabric/src/ /opt/nemoclaw-fabric-runner/src/
COPY packages/nemoclaw-fabric/build-requirements.lock /tmp/fabric-build-requirements.lock
COPY packages/nemoclaw-haystack-agent/fabric/pyproject.toml /opt/nemoclaw-haystack-fabric/
COPY packages/nemoclaw-haystack-agent/fabric/src/ /opt/nemoclaw-haystack-fabric/src/
COPY packages/nemoclaw-haystack-agent/fabric/haystack-agent.fabric-adapter.json /usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json
COPY packages/nemoclaw-haystack-agent/config/generate-config.ts /usr/local/lib/nemoclaw-haystack/generate-config.ts
COPY packages/nemoclaw-haystack-agent/runtime/generate-config.sh /usr/local/lib/nemoclaw-haystack/generate-config
COPY packages/nemoclaw-haystack-agent/runtime/version-check.py /usr/local/bin/nemoclaw-haystack-version
COPY packages/nemoclaw-haystack-agent/start.sh /usr/local/bin/nemoclaw-start
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

RUN python3 -m venv --copies /tmp/fabric-build-venv \
    && /tmp/fabric-build-venv/bin/pip3 install --no-cache-dir --require-hashes \
        -r /tmp/fabric-build-requirements.lock \
    && install -d -o root -g root -m 0755 /tmp/fabric-wheels \
    && /tmp/fabric-build-venv/bin/pip3 wheel --no-index --no-deps --no-build-isolation \
        --wheel-dir /tmp/fabric-wheels \
        /opt/nemoclaw-fabric-runner /opt/nemoclaw-haystack-fabric \
    && set -- /tmp/fabric-wheels/nemoclaw_fabric-0.1.2-*.whl \
    && [ "$#" -eq 1 ] \
    && runner_wheel="$1" \
    && set -- /tmp/fabric-wheels/nemoclaw_haystack_fabric-0.1.0-*.whl \
    && [ "$#" -eq 1 ] \
    && adapter_wheel="$1" \
    && /opt/nemoclaw-fabric-venv/bin/pip3 install --no-index --no-cache-dir --no-deps \
        "$runner_wheel" "$adapter_wheel" \
    && /opt/nemoclaw-fabric-venv/bin/pip3 check \
    && /opt/nemoclaw-fabric-venv/bin/python3 -I -c \
        'from importlib.metadata import version; expected = {"haystack-ai": "3.1.1", "nemoclaw-fabric": "0.1.2", "nemoclaw-haystack-fabric": "0.1.0", "nemo-fabric": "0.2.0"}; actual = {name: version(name) for name in expected}; assert actual == expected, actual; import nemoclaw_haystack_fabric.adapter' \
    && ln -s /opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric /usr/local/bin/nemoclaw-fabric \
    && ln -s /opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run /usr/local/bin/nemoclaw-fabric-run \
    && chown root:root \
        /usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json \
        /usr/local/lib/nemoclaw-haystack/generate-config.ts \
        /usr/local/lib/nemoclaw-haystack/generate-config \
        /usr/local/bin/nemoclaw-haystack-version \
        /usr/local/bin/nemoclaw-start \
    && chmod 0444 \
        /usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json \
        /usr/local/lib/nemoclaw-haystack/generate-config.ts \
    && chmod 0555 \
        /usr/local/lib/nemoclaw-haystack/generate-config \
        /usr/local/bin/nemoclaw-haystack-version \
        /usr/local/bin/nemoclaw-start \
    && install -d -o root -g root -m 0755 /etc/profile.d \
    && printf '%s\n' \
        'export HAYSTACK_TELEMETRY_ENABLED=false' \
        'export HAYSTACK_AUTO_TRACE_ENABLED=false' \
        'export HAYSTACK_CONTENT_TRACING_ENABLED=false' \
        'export NO_PROXY=localhost,127.0.0.1,::1' \
        'export no_proxy="$NO_PROXY"' \
        'unset ALL_PROXY all_proxy OPENAI_PROXY' \
        > /etc/profile.d/nemoclaw-haystack-agent.sh \
    && chown root:root /etc/profile.d/nemoclaw-haystack-agent.sh \
    && chmod 0444 /etc/profile.d/nemoclaw-haystack-agent.sh \
    && install -d -o sandbox -g sandbox -m 0700 \
        /sandbox/.haystack-agent /sandbox/.haystack-agent/fabric-artifacts \
    && install -d -o root -g root -m 0755 /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -R /opt/nemoclaw-blueprint/. /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && chown -R root:root /opt/nemoclaw-blueprint /sandbox/.nemoclaw/blueprints \
    && chmod -R a+rX /opt/nemoclaw-blueprint /sandbox/.nemoclaw/blueprints \
    && rm -rf /opt/nemoclaw-fabric-runner /opt/nemoclaw-haystack-fabric \
        /tmp/fabric-build-venv /tmp/fabric-wheels /tmp/fabric-build-requirements.lock

ENV HOME=/sandbox \
    PATH="/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/bin:/bin" \
    HAYSTACK_TELEMETRY_ENABLED=false \
    HAYSTACK_AUTO_TRACE_ENABLED=false \
    HAYSTACK_CONTENT_TRACING_ENABLED=false \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_TEMPERATURE=${NEMOCLAW_TEMPERATURE} \
    NEMOCLAW_MAX_TURNS=${NEMOCLAW_MAX_TURNS}

USER sandbox
WORKDIR /sandbox

RUN /usr/local/lib/nemoclaw-haystack/generate-config \
    && test "$(stat -c %a /sandbox/.haystack-agent/fabric.json)" = 600 \
    && test -s /sandbox/.nemoclaw/blueprints/0.1.0/blueprint.yaml \
    && test "$(nemoclaw-haystack-version)" = 3.1.1 \
    && test "$(nemoclaw-fabric --version)" = "nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)" \
    && nemoclaw-fabric-run --help >/dev/null \
    && HAYSTACK_MANAGED_INFERENCE_ROUTE=nemoclaw-managed-inference \
        nemoclaw-fabric doctor --config /sandbox/.haystack-agent/fabric.json >/dev/null

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

USER sandbox

ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD []
