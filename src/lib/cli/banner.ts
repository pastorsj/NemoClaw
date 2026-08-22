// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: packages/nemoclaw-openclaw/plugin/src/shared/banner-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// module is compiled (mirrors src/lib/policy/merge.ts). Keep this file
// implementation-free. It keeps the ../cli/banner import path stable for
// src/lib/tunnel/services.ts.
import { renderBox as canonicalRenderBox } from "../../../packages/nemoclaw-openclaw/plugin/dist/shared/banner-boundary.cjs";

export type {
  BannerLine,
  RenderBoxOptions,
} from "../../../packages/nemoclaw-openclaw/plugin/dist/shared/banner-boundary.cjs";

export const renderBox = canonicalRenderBox;
