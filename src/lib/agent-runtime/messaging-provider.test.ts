// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseMessagingCredentialProviderProfile } from "./messaging-provider";

function googleServiceAccountProfile(
  strategy = "google_service_account_jwt",
  clientEmailFlags = "required: true\n          secret: false",
  scopeFlags = "required: false\n          secret: false",
): string {
  return `
id: google-chat-bridge
credentials:
  - name: access_token
    env_vars: [GOOGLE_CHAT_ACCESS_TOKEN]
    refresh:
      strategy: ${strategy}
      scopes: [https://www.googleapis.com/auth/chat.bot]
      material:
        - name: client_email
          ${clientEmailFlags}
        - name: private_key
          required: true
          secret: true
        - name: scope
          ${scopeFlags}
endpoints: []
binaries: []
inference_capable: false
`;
}

describe("parseMessagingCredentialProviderProfile", () => {
  it("accepts only the canonical stored Google service-account refresh contract", () => {
    expect(parseMessagingCredentialProviderProfile(googleServiceAccountProfile())).toEqual({
      profileId: "google-chat-bridge",
      credentialEnv: "GOOGLE_CHAT_ACCESS_TOKEN",
      refresh: {
        strategy: "google_service_account_jwt",
        scopes: ["https://www.googleapis.com/auth/chat.bot"],
        secretMaterialKeys: ["private_key"],
      },
    });
    expect(
      parseMessagingCredentialProviderProfile(
        googleServiceAccountProfile("google-service-account-jwt"),
      ),
    ).toBeNull();
    expect(
      parseMessagingCredentialProviderProfile(
        googleServiceAccountProfile("google_service_account_jwt", "required: true", ""),
      ),
    ).toBeNull();
    expect(
      parseMessagingCredentialProviderProfile(
        googleServiceAccountProfile().replace(
          "endpoints: []",
          "        - name: undeclared_material\nendpoints: []",
        ),
      ),
    ).toBeNull();
  });
});
