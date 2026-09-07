// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingChannelId,
  SandboxMessagingPlan,
  SandboxMessagingProviderReceipt,
} from "./manifest";

function receiptKey(receipt: Pick<SandboxMessagingProviderReceipt, "channelId" | "providerName">) {
  return `${receipt.channelId}:${receipt.providerName}`;
}

/** Replace exact channel/provider ownership receipts without disturbing other channels. */
export function bindMessagingProviderReceipts(
  plan: SandboxMessagingPlan,
  receipts: readonly SandboxMessagingProviderReceipt[],
): SandboxMessagingPlan {
  if (receipts.length === 0) return plan;
  const replacements = new Map(receipts.map((receipt) => [receiptKey(receipt), receipt]));
  const retained = (plan.providerReceipts ?? []).filter(
    (receipt) => !replacements.has(receiptKey(receipt)),
  );
  return {
    ...plan,
    providerReceipts: [...retained, ...receipts].sort((left, right) =>
      receiptKey(left).localeCompare(receiptKey(right)),
    ),
  };
}

/** Read the unique immutable provider receipt recorded for one channel binding. */
export function findMessagingProviderReceipt(
  plan: SandboxMessagingPlan | null | undefined,
  channelId: MessagingChannelId,
  providerName: string,
): SandboxMessagingProviderReceipt | undefined {
  return plan?.providerReceipts?.find(
    (receipt) => receipt.channelId === channelId && receipt.providerName === providerName,
  );
}
