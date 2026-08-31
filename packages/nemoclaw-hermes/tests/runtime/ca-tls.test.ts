// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Simulates a corporate TLS interception endpoint against the package's real
// corporate-CA merge path. OpenShell trust must survive the same merge.

import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  type CaMaterial,
  cleanupCaSetup,
  httpsGetStatus,
  resolveCaSetup,
  runMergeBlock,
  startTlsServer,
} from "../helpers/corporate-ca";

const PACKAGE_ROOT = path.join(import.meta.dirname, "../..");
const HERMES_START = path.join(PACKAGE_ROOT, "start.sh");
const MERGE_END = "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.";
const setup = resolveCaSetup("hermes-corporate-ca-tls");

afterAll(() => cleanupCaSetup(setup));

describe.skipIf(!setup.ok)("Hermes corporate proxy CA TLS verification (#6210)", () => {
  const material = setup as CaMaterial;

  it("verifies a corporate-CA-signed endpoint only after the merge (#6210)", async () => {
    const merged = runMergeBlock(
      HERMES_START,
      material.openshellCaCert,
      material.corporateCaCert,
      material.dir,
      MERGE_END,
    );
    const server = await startTlsServer(material.serverKey, material.serverCert);
    try {
      await expect(httpsGetStatus(server.port, material.openshellCaCert)).rejects.toThrow(
        /unable to (get local issuer|verify)|self.signed|UNABLE_TO_/i,
      );
      await expect(httpsGetStatus(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });

  it("still trusts the OpenShell root through the merged bundle (#6210)", async () => {
    const merged = runMergeBlock(
      HERMES_START,
      material.openshellCaCert,
      material.corporateCaCert,
      material.dir,
      MERGE_END,
    );
    const server = await startTlsServer(material.openshellServerKey, material.openshellServerCert);
    try {
      await expect(httpsGetStatus(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });
});
