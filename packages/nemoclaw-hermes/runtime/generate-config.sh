#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

exec /usr/local/bin/node \
  --experimental-strip-types \
  /opt/nemoclaw-hermes-config/generate-config.ts \
  "$@"
