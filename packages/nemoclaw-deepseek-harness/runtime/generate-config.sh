#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

exec /usr/bin/python3 -I /opt/nemoclaw-deepseek-harness/generate-config.py "$@"
