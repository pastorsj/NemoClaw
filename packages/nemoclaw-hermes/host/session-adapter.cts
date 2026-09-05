// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
function buildSessionListPlan(request) {
    return {
        kind: "stream",
        command: ["hermes", "sessions", "list", ...request.arguments],
    };
}
function interpretSessionListOutput(request) {
    return { kind: "output", output: request.output };
}
const sessionAdapter = {
    buildSessionListPlan,
    interpretSessionListOutput,
};
module.exports = sessionAdapter;
