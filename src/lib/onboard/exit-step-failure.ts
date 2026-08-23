// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { printOnboardResumeHint } from "./resume-hint";

export interface ExitStepFailureSessionDeps {
  loadSession(): Pick<Session, "lastStepStarted"> | null;
  finalizeIncompleteOnboardStep(
    stepName: string,
    message?: string | null,
    interrupted?: boolean,
  ): Session | null;
}

export interface OnboardExitFailureProcessLike {
  once(event: "exit", listener: (code: number) => void): unknown;
  on?(event: OnboardInterruptSignal, listener: () => void): unknown;
  removeListener?(
    event: "exit" | OnboardInterruptSignal,
    listener: ((code: number) => void) | (() => void),
  ): unknown;
  kill?(pid: number, signal: OnboardInterruptSignal): unknown;
  pid?: number;
}

type OnboardInterruptSignal = "SIGINT" | "SIGTERM";

const ACTIVE_INCOMPLETE_ONBOARD_HANDLER = Symbol.for("nemoclaw.onboard.incomplete-exit-handler");

type ProcessWithIncompleteOnboardHandler = OnboardExitFailureProcessLike & {
  [ACTIVE_INCOMPLETE_ONBOARD_HANDLER]?: () => void;
};

export function markLastStartedStepFailed(
  deps: ExitStepFailureSessionDeps,
  message: string,
  interrupted = false,
): Session | null {
  // Repairs the invalid state where onboard/rebuild exits nonzero after a step
  // starts but before normal completion handlers can run. Routes through the
  // single terminal-failure owner (finalizeIncompleteOnboardStep), which
  // validates the failed transition and is idempotent against an already
  // terminal machine, rather than the legacy step-mutation escape hatch.
  // Covered by exit-step-failure, rebuild-flow, and onboard-exit-handler tests.
  const failedStep = deps.loadSession()?.lastStepStarted;
  if (!failedStep) return null;
  return deps.finalizeIncompleteOnboardStep(failedStep, message, interrupted);
}

export function registerIncompleteOnboardExitFailureHandler(
  deps: ExitStepFailureSessionDeps,
  isComplete: () => boolean,
  message: string,
  processLike: OnboardExitFailureProcessLike = process,
  portable = isPortableExperimentalProfile(),
): () => void {
  const processState = processLike as ProcessWithIncompleteOnboardHandler;
  processState[ACTIVE_INCOMPLETE_ONBOARD_HANDLER]?.();
  const failIncompleteStep = (force = false): void => {
    if (!force && isComplete()) return;
    // A non-null return means a step was in progress, so surface the
    // profile-appropriate recovery command for exit paths that don't print
    // their own guidance (#6003, #8873). When an explicit cancel has already
    // cleared the session (or no step started), this is null and stays silent.
    // printOnboardResumeHint also self-dedupes against tailored hints.
    const interrupted = markLastStartedStepFailed(deps, message, true);
    if (!interrupted) return;
    printOnboardResumeHint(portable, undefined, interrupted.sandboxName);
  };

  const onExit = (code: number): void => {
    if (code === 0) return;
    failIncompleteStep();
  };
  processLike.once("exit", onExit);

  const on = processLike.on?.bind(processLike);
  const kill = processLike.kill?.bind(processLike);
  const pid = processLike.pid;

  let pendingSignal: OnboardInterruptSignal | null = null;
  const handleSignal = (signal: OnboardInterruptSignal): void => {
    // Prompt handlers restore the terminal and may synchronously re-raise the
    // signal. Keep this listener installed until the next turn so a nested
    // delivery cannot terminate the process before the resume hint is printed.
    if (pendingSignal) return;
    pendingSignal = signal;
    setImmediate(() => {
      processLike.removeListener?.("SIGINT", onSigint);
      processLike.removeListener?.("SIGTERM", onSigterm);
      failIncompleteStep(true);
      if (kill && pid !== undefined) kill(pid, signal);
    });
  };
  const onSigint = (): void => handleSignal("SIGINT");
  const onSigterm = (): void => handleSignal("SIGTERM");

  if (on && kill && pid !== undefined) {
    on("SIGINT", onSigint);
    on("SIGTERM", onSigterm);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    processLike.removeListener?.("exit", onExit);
    processLike.removeListener?.("SIGINT", onSigint);
    processLike.removeListener?.("SIGTERM", onSigterm);
    if (processState[ACTIVE_INCOMPLETE_ONBOARD_HANDLER] === dispose) {
      delete processState[ACTIVE_INCOMPLETE_ONBOARD_HANDLER];
    }
  };
  processState[ACTIVE_INCOMPLETE_ONBOARD_HANDLER] = dispose;
  return dispose;
}
