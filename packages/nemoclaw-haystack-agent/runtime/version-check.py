#!/opt/nemoclaw-fabric-venv/bin/python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Print the installed Haystack distribution version."""

from importlib.metadata import version

print(version("haystack-ai"))
