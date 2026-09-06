// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "./nemoclaw-oclif-command";

/** Shared base for implementation-only CLI commands that must stay out of public help. */
export abstract class NemoClawInternalCommand extends NemoClawCommand {
  static hidden = true;
}
