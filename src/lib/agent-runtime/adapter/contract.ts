// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

declare const HARNESS_ADAPTER_REQUEST: unique symbol;
declare const HARNESS_ADAPTER_RESULT: unique symbol;

/** One fixed operation exported by a receipt-verified harness adapter module. */
export interface HarnessAdapterOperation<Request, Result> {
  readonly exportName: string;
  readonly requestSchema: AnySchemaObject;
  readonly resultSchema: AnySchemaObject;
  readonly resultDescription: string;
  readonly [HARNESS_ADAPTER_REQUEST]?: Request;
  readonly [HARNESS_ADAPTER_RESULT]?: Result;
}

export type HarnessAdapterOperations = Readonly<
  Record<string, HarnessAdapterOperation<unknown, unknown>>
>;

/**
 * Core-owned description of one fixed adapter module.
 *
 * Packages cannot supply this value or select another module path or export.
 */
export interface HarnessAdapterContract<Operations extends HarnessAdapterOperations> {
  readonly displayName: string;
  readonly modulePath: `host/${string}-adapter.cts`;
  readonly manifestSchema: AnySchemaObject;
  readonly sourceMaxBytes: number;
  readonly requestMaxBytes: number;
  readonly resultMaxBytes: number;
  readonly operations: Operations;
}

export type HarnessAdapterRequest<Operation> =
  Operation extends HarnessAdapterOperation<infer Request, unknown> ? Request : never;

export type HarnessAdapterResult<Operation> =
  Operation extends HarnessAdapterOperation<unknown, infer Result> ? Result : never;

export type LoadedHarnessAdapter<
  Contract extends HarnessAdapterContract<HarnessAdapterOperations>,
> = Readonly<{
  [Name in keyof Contract["operations"]]: (
    request: HarnessAdapterRequest<Contract["operations"][Name]>,
  ) => HarnessAdapterResult<Contract["operations"][Name]>;
}>;

/** Preserve request and result types while defining a data-only operation contract. */
export function defineHarnessAdapterOperation<Request, Result>(
  operation: Omit<
    HarnessAdapterOperation<Request, Result>,
    typeof HARNESS_ADAPTER_REQUEST | typeof HARNESS_ADAPTER_RESULT
  >,
): HarnessAdapterOperation<Request, Result> {
  return Object.freeze(operation);
}

/** Preserve operation names and types while defining a core-owned module contract. */
export function defineHarnessAdapterContract<const Operations extends HarnessAdapterOperations>(
  contract: HarnessAdapterContract<Operations>,
): HarnessAdapterContract<Operations> {
  return Object.freeze({
    ...contract,
    operations: Object.freeze({ ...contract.operations }),
  });
}
