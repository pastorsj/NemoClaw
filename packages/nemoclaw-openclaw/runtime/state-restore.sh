#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

# OpenClaw owns both operations. NemoClaw invokes this fixed package command
# after restoring state and before restarting the runtime.
/usr/local/bin/openclaw doctor --fix
/usr/bin/python3 -I /usr/local/lib/nemoclaw/openclaw-state-restore.py
