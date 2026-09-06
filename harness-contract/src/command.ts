// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** How core delivers one package-declared prompt to its headless command. */
export type HarnessPromptTransport = "argv" | "stdin";

/** How core relays one package-native agent command without giving the package host authority. */
export type HarnessAgentCommandOutputMode = "direct" | "bounded-text";

/**
 * Finite argv grammar for a package-native `nemoclaw <sandbox> agent` invocation.
 *
 * The package owns command names and option grammar. NemoClaw owns sandbox
 * execution, capture limits, deadlines, redaction, and operator-facing text.
 */
export interface HarnessAgentCommandDeclaration {
  readonly argv: readonly string[];
  readonly output_mode: HarnessAgentCommandOutputMode;
  readonly selector_options?: readonly string[];
  readonly selector_required?: boolean;
  readonly value_options?: readonly string[];
  readonly boolean_options?: readonly string[];
  readonly json_output_option?: string;
  readonly timeout_option?: string;
}

/** Finite lifecycle operations that core may ask a gateway package to perform. */
export type HarnessProcessLifecycleAction = "probe" | "restart" | "recover";

/**
 * Package-owned privileged command for gateway process lifecycle control.
 *
 * NemoClaw appends one {@link HarnessProcessLifecycleAction} and a core-created
 * nonce to this fixed command prefix. Core retains the sandbox lock, runtime
 * provider selection, resource pin, timeout, output limit, and redaction. A
 * successful command must echo that nonce in the fixed managed-control record
 * followed by its `GATEWAY_PID` record; core rejects unstructured success.
 */
export type HarnessProcessLifecycleDeclaration =
  | {
      readonly support: "managed";
      readonly command: readonly string[];
      /** Re-run the managed recovery controller when an already-running gateway fails its package boundary. */
      readonly revalidate_running_gateway?: true;
      readonly reason?: never;
    }
  | {
      readonly support: "unsupported";
      readonly reason: string;
      readonly command?: never;
    };

/** Package-owned bounded command that settles its browser/device authentication state. */
export interface HarnessDevicePairingSettlementDeclaration {
  readonly command: readonly string[];
  readonly timeout_seconds: number;
}

interface HarnessRuntimeCommandFields {
  readonly command_shell?: "/bin/sh" | "/bin/bash";
  readonly startup_environment?: Readonly<Record<string, string>>;
  readonly smoke_commands?: readonly string[];
  readonly smoke_boundary?:
    | { readonly kind: "login-shell" }
    | {
        readonly kind: "managed-launcher";
        readonly launcher: string;
        readonly home: string;
      };
  readonly agent_command?: HarnessAgentCommandDeclaration;
  readonly device_pairing_settlement?: HarnessDevicePairingSettlementDeclaration;
}

type HarnessHeadlessCommandFields =
  | {
      readonly headless_command: string;
      readonly prompt_transport?: HarnessPromptTransport;
      readonly headless_environment?: Readonly<Record<string, string>>;
    }
  | {
      readonly headless_command?: never;
      readonly prompt_transport?: never;
      readonly headless_environment?: never;
    };

export type HarnessGatewayRuntimeCommandDeclaration = HarnessRuntimeCommandFields &
  HarnessHeadlessCommandFields & {
    readonly kind: "gateway";
    readonly interactive_command?: string;
    readonly process_lifecycle?: HarnessProcessLifecycleDeclaration;
  };

type HarnessUnsupportedTerminalLifecycle = Extract<
  HarnessProcessLifecycleDeclaration,
  { readonly support: "unsupported" }
>;

export type HarnessTerminalRuntimeCommandDeclaration = HarnessRuntimeCommandFields &
  HarnessHeadlessCommandFields &
  (
    | { readonly interactive_command: string }
    | { readonly interactive_command?: never; readonly headless_command: string }
  ) & {
    readonly kind: "terminal";
    readonly process_lifecycle?: HarnessUnsupportedTerminalLifecycle;
  };

/** Typed runtime command surface shared by package manifests and NemoClaw. */
export type HarnessRuntimeCommandDeclaration =
  | HarnessGatewayRuntimeCommandDeclaration
  | HarnessTerminalRuntimeCommandDeclaration;
