// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFull } from "../../../security/redact";

/** Redact untrusted agent-command output before it reaches the terminal. */
export const redactAgentDiagnostic = redactFull;
