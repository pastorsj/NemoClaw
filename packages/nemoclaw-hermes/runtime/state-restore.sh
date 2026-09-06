#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

config_root=/sandbox/.hermes
dashboard_home="$config_root/profiles/dashboard-home"
legacy_home="$config_root/dashboard-home"

# Dashboard state is optional. Rebuild should not create a dashboard profile
# for an installation that never used one.
if [ ! -d "$dashboard_home" ] && [ ! -d "$legacy_home" ]; then
  exit 0
fi

dashboard_config="$dashboard_home/config.yaml"
output="$({
  /opt/hermes/.venv/bin/python3 -I \
    /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py \
    --merge-legacy \
    /usr/local/share/nemoclaw/hermes-managed-policy.json \
    "$config_root/config.yaml" \
    "$dashboard_config" \
    "$config_root/.env" \
    "$dashboard_home/.env"
} 2>&1)" || {
  printf '%s\n' "$output" >&2
  exit 1
}
printf '%s\n' "$output" >&2
printf '%s\n' "$output" | grep -F -x \
  "[dashboard] seeded model routing and reviewed policy into $dashboard_config" >/dev/null
