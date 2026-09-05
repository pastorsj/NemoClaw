# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Package-owned NeMo Fabric adapter for the local Haystack Agent POC."""

# Keep package import free of adapter side effects. Fabric executes the adapter
# module with ``python -m`` and must not find it preloaded by this package.
