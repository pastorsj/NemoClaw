// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  encodeSemanticTurnBinding,
  parseSemanticTurnBinding,
  semanticTurnBindingsEqual,
  type SandboxSemanticTurnBinding,
} from "./sandbox-authority";

const BINDING: SandboxSemanticTurnBinding = Object.freeze({
  sandboxName: "voice-sandbox",
  packageIdentity: Object.freeze({
    kind: "agent-runtime",
    id: "openclaw",
    packageVersion: "1.2.3",
    contentDigest: "a".repeat(64),
  }),
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
  lifecycleGeneration: "generation-one",
  lifecycleLiveIdentityFingerprint: "b".repeat(64),
});

describe("voice gateway sandbox authority", () => {
  it("round-trips the complete secret-free sandbox generation binding", () => {
    expect(parseSemanticTurnBinding(encodeSemanticTurnBinding(BINDING))).toEqual(BINDING);
  });

  it("rejects noncanonical, extra, and mismatched gateway authority", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

    expect(() => parseSemanticTurnBinding(`${encodeSemanticTurnBinding(BINDING)}=`)).toThrow(
      "malformed",
    );
    expect(() => parseSemanticTurnBinding(encoded({ ...BINDING, nativeField: true }))).toThrow(
      "malformed",
    );
    expect(() => parseSemanticTurnBinding(encoded({ ...BINDING, gatewayPort: 19081 }))).toThrow(
      "malformed",
    );
  });

  it("distinguishes same-package replacement generations", () => {
    expect(
      semanticTurnBindingsEqual(BINDING, {
        ...BINDING,
        lifecycleGeneration: "replacement-generation",
      }),
    ).toBe(false);
  });
});
