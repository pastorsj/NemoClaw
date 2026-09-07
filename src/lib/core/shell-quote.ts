// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep the established core import stable while lower-level state boundaries
// consume the dependency-neutral shared implementation directly.
export { shellQuote } from "../shared/shell-quote";
