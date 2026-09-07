// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** How core delivers one package-declared prompt to its headless command. */
export type HarnessPromptTransport = "argv" | "stdin";

/** The finite protocol used to translate CLI prompt arguments onto stdin. */
export type HarnessPromptProtocol = "fabric-cli" | "raw-stdin";

/** How core relays one package-native agent command without giving the package host authority. */
export type HarnessAgentCommandOutputMode = "direct" | "bounded-text";

/** Optional finite interpretation for captured output. Absence means raw relay. */
export type HarnessAgentCommandOutputInterpretation = "structured-turn-envelope";

/** Failure metadata carried by a structured turn. */
export interface HarnessStructuredTurnError {
  readonly kind: string;
}

/**
 * Authoritative completion metadata for a structured turn.
 *
 * NemoClaw treats a replay-invalid, abandoned, timed-out, or explicitly
 * incomplete turn as unfinished. Packages omit these fields after a complete
 * turn rather than placing lookalike values in tool payloads.
 */
export interface HarnessStructuredTurnMetadata {
  readonly replayInvalid?: boolean;
  readonly livenessState?: string;
  readonly timeoutPhase?: string;
  readonly error?: HarnessStructuredTurnError;
}

/** One package-native response interpreted by NemoClaw's bounded turn relay. */
export interface HarnessStructuredTurnResponse {
  readonly payloads?: readonly unknown[];
  readonly meta: HarnessStructuredTurnMetadata;
}

/**
 * Accepted local and gateway forms for `structured-turn-envelope` output.
 * JSON log records may precede this final response; they are not completion
 * authority. Payload contents are relayed as untrusted harness output.
 */
export type HarnessStructuredTurnEnvelope =
  | HarnessStructuredTurnResponse
  | {
      readonly status: string;
      readonly result: HarnessStructuredTurnResponse;
    };

/**
 * Finite argv grammar for a package-native `nemoclaw <sandbox> agent` invocation.
 *
 * The package owns command names and option grammar. NemoClaw owns sandbox
 * execution, capture limits, deadlines, redaction, and operator-facing text.
 */
export interface HarnessAgentCommandDeclaration {
  readonly argv: readonly string[];
  readonly output_mode: HarnessAgentCommandOutputMode;
  readonly output_interpretation?: HarnessAgentCommandOutputInterpretation;
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

/**
 * Read-only package command that returns one stable, credential-free session-state digest.
 *
 * NemoClaw appends a core-created nonce and accepts only the bounded structured
 * completion record defined by the runtime executor. The package owns how its
 * native session or pairing state is inspected; core owns execution identity,
 * authority checks, deadlines, output limits, and lease comparison.
 */
export interface HarnessSessionQualificationDeclaration {
  readonly command: readonly string[];
  readonly timeout_seconds: number;
}

/** Failure outcomes a package may report across the semantic-turn boundary. */
export type HarnessSemanticTurnFailureReason =
  | "agent_failed"
  | "agent_gateway_unavailable"
  | "agent_protocol_error"
  | "response_too_large";

/** One bounded turn delivered privately to a package-owned sandbox command. */
export interface HarnessSemanticTurnRequest {
  readonly type: "turn";
  readonly message: string;
  /** Opaque NemoClaw conversation identity. Packages translate it to native session grammar. */
  readonly conversationKey: string;
  /** Operator-selected package target, such as a native agent or profile. */
  readonly runtimeTarget: string;
  readonly idempotencyKey: string;
}

/**
 * Finite NDJSON records emitted by a package-owned semantic-turn command.
 *
 * Core accepts either one `failed` record before native work starts, or one
 * `started` record, zero or more `text` records, and exactly one terminal
 * record. It owns output limits, delivery, timeout, and command cancellation;
 * native transport frames never cross this boundary.
 */
export type HarnessSemanticTurnEvent =
  | { readonly type: "started" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "completed" }
  | {
      readonly type: "failed";
      readonly reason: HarnessSemanticTurnFailureReason;
    };

/** Package-owned command that adapts one native harness turn to finite NDJSON. */
export type HarnessSemanticTurnDeclaration =
  | {
      readonly support: "managed";
      readonly command: readonly string[];
      readonly timeout_seconds: number;
      readonly protocol: "semantic-turn-ndjson";
      readonly reason?: never;
    }
  | {
      readonly support: "unsupported";
      readonly reason: string;
      readonly command?: never;
      readonly timeout_seconds?: never;
      readonly protocol?: never;
    };

/**
 * Read-only package command that proves the live native configuration still
 * represents the inference selection accepted by NemoClaw.
 *
 * NemoClaw appends a base64url-encoded {@link HarnessSelectionQualificationRequest}
 * and a core-created nonce. The package owns native parsing and normalization;
 * core owns the bounded execution and accepts only the fixed completion record.
 */
export interface HarnessSelectionQualificationDeclaration {
  readonly command: readonly string[];
  readonly timeout_seconds: number;
}

/** Credential-free inference intent presented to one package-owned qualification command. */
export interface HarnessSelectionQualificationRequest {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly selection: {
    readonly upstreamProvider: string;
    readonly model: string;
    readonly providerKey: string;
    readonly baseUrl: string;
    readonly api: "openai-completions" | "openai-responses" | "anthropic-messages";
    readonly endpointUrl: string | null;
  };
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
  readonly selection_qualification?: HarnessSelectionQualificationDeclaration;
  readonly session_qualification?: HarnessSessionQualificationDeclaration;
  readonly semantic_turn?: HarnessSemanticTurnDeclaration;
}

type HarnessHeadlessCommandFields =
  | {
      readonly headless_command: string;
      readonly prompt_transport?: HarnessPromptTransport;
      readonly prompt_protocol?: HarnessPromptProtocol;
      readonly headless_environment?: Readonly<Record<string, string>>;
    }
  | {
      readonly headless_command?: never;
      readonly prompt_transport?: never;
      readonly prompt_protocol?: never;
      readonly headless_environment?: never;
    };

export type HarnessGatewayRuntimeCommandDeclaration = HarnessRuntimeCommandFields &
  HarnessHeadlessCommandFields &
  (
    | { readonly interactive_command: string }
    | { readonly interactive_command?: never; readonly headless_command: string }
  ) & {
    readonly kind: "gateway";
    readonly gateway_log_path?: string;
    readonly interactive_command?: string;
    /** Every gateway package explicitly declares whether core may manage its process. */
    readonly process_lifecycle: HarnessProcessLifecycleDeclaration;
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
