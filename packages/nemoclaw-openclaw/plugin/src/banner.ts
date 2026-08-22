// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: src/lib/shared/banner-boundary.cts
// This package entry wrapper keeps the ./banner.js import path stable for
// packages/nemoclaw-openclaw/plugin/src/index.ts while the renderer lives in the shared boundary.
import { renderBox as canonicalRenderBox } from "#nemoclaw-shared/banner-boundary.cjs";

export type { BannerLine, RenderBoxOptions } from "#nemoclaw-shared/banner-boundary.cjs";

export const renderBox = canonicalRenderBox;
