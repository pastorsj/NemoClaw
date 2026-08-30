# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Run the NemoClaw Fabric command as a Python module."""

from nemoclaw_fabric.command import main


if __name__ == "__main__":
    raise SystemExit(main())
