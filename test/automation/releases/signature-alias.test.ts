// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeOpenClawSignatureAlias } from "../../../scripts/audit-reviewed-npm-graph.mts";

const DOMEXCEPTION_INTEGRITY =
  "sha512-tlc/FcYIv5i8RYsl2iDil4A0gOihaas1R5jPcIC4Zw3GhjKsVilw90aHcVlhZPTBLGBzd379S+VcnsDjd9ChiA==";

describe("reviewed npm signature alias", () => {
  it("normalizes only the reviewed OpenClaw npm alias for registry signature verification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-signature-alias-"));
    const aliasPath = path.join("node_modules", "openclaw", "node_modules", "node-domexception");
    const actualPath = path.join(
      "node_modules",
      "openclaw",
      "node_modules",
      "@nolyfill",
      "domexception",
    );
    const requesterPath = path.join("node_modules", "openclaw", "node_modules", "fetch-blob");
    const aliasManifest = { name: "@nolyfill/domexception", version: "1.0.28" };
    const requesterManifest = {
      name: "fetch-blob",
      version: "3.2.0",
      dependencies: { "node-domexception": "^1.0.0" },
    };
    const lock = {
      lockfileVersion: 3,
      packages: {
        [aliasPath]: {
          ...aliasManifest,
          resolved: "https://registry.npmjs.org/@nolyfill/domexception/-/domexception-1.0.28.tgz",
          integrity: DOMEXCEPTION_INTEGRITY,
        },
        [requesterPath]: requesterManifest,
      },
    };
    try {
      fs.mkdirSync(path.join(root, aliasPath), { recursive: true });
      fs.writeFileSync(
        path.join(root, aliasPath, "package.json"),
        `${JSON.stringify(aliasManifest)}\n`,
      );
      fs.mkdirSync(path.join(root, requesterPath), { recursive: true });
      fs.writeFileSync(
        path.join(root, requesterPath, "package.json"),
        `${JSON.stringify(requesterManifest)}\n`,
      );
      fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);

      normalizeOpenClawSignatureAlias(root);

      const normalizedLock = JSON.parse(
        fs.readFileSync(path.join(root, "package-lock.json"), "utf-8"),
      );
      const normalizedRequester = createRequire(import.meta.url)(
        path.join(root, requesterPath, "package.json"),
      );
      expect(fs.existsSync(path.join(root, aliasPath))).toBe(false);
      expect(fs.existsSync(path.join(root, actualPath, "package.json"))).toBe(true);
      expect(normalizedLock.packages[aliasPath]).toBeUndefined();
      expect(normalizedLock.packages[actualPath]).toMatchObject(aliasManifest);
      expect(normalizedLock.packages[requesterPath].dependencies).toEqual({
        "@nolyfill/domexception": "1.0.28",
      });
      expect(normalizedRequester.dependencies).toEqual({
        "@nolyfill/domexception": "1.0.28",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
