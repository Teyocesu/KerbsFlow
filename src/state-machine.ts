import {
  PAUSE_RESUME_TARGETS,
  RunState,
  isPauseResumeTarget,
  isTerminalState,
} from "./contracts.js";

export class StateMachineError extends Error {
  readonly code: "ILLEGAL_TRANSITION" | "TERMINAL_STATE" | "INVALID_PAUSE_ORIGIN" | "INVALID_RESUME_TARGET";

  constructor(code: StateMachineError["code"], message: string) {
    super(message);
    this.name = "StateMachineError";
    this.code = code;
  }
}

export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  IDLE: ["INTAKE"],
  INTAKE: ["PLAN", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  PLAN: ["READY", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  READY: ["EXECUTE", "PLAN", "HUMAN_GATE", "PAUSED", "CANCELLED"],
  EXECUTE: ["VERIFY_FOCUSED", "HUMAN_GATE", "RECOVERY", "PAUSED", "CANCELLED"],
  VERIFY_FOCUSED: ["REVIEW", "HUMAN_GATE", "RECOVERY", "PAUSED", "CANCELLED"],
  REVIEW: ["REWORK", "VERIFY_PHASE", "NEXT_PHASE", "FINAL_VERIFY", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  REWORK: ["READY", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  VERIFY_PHASE: ["NEXT_PHASE", "REWORK", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  NEXT_PHASE: ["PLAN", "FINAL_VERIFY", "PAUSED", "CANCELLED"],
  FINAL_VERIFY: ["HUMAN_RELEASE_GATE", "REWORK", "HUMAN_GATE", "FAILED", "PAUSED", "CANCELLED"],
  HUMAN_GATE: ["PLAN", "READY", "REWORK", "FINAL_VERIFY", "FAILED", "CANCELLED", "PAUSED"],
  HUMAN_RELEASE_GATE: ["DONE", "REWORK", "CANCELLED", "PAUSED"],
  PAUSED: [...PAUSE_RESUME_TARGETS, "CANCELLED"],
  RECOVERY: ["EXECUTE", "VERIFY_FOCUSED", "REVIEW", "READY", "HUMAN_GATE", "FAILED", "CANCELLED", "PAUSED"],
  FAILED: [],
  CANCELLED: [],
  DONE: [],
};

export function isLegalTransition(from: RunState, to: RunState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertLegalTransition(from: RunState, to: RunState): void {
  if (isTerminalState(from)) {
    throw new StateMachineError("TERMINAL_STATE", `terminal state ${from} cannot transition`);
  }
  if (!isLegalTransition(from, to)) {
    throw new StateMachineError("ILLEGAL_TRANSITION", `transition ${from} -> ${to} is not legal`);
  }
}

export function choosePauseContract(originState: RunState, uncertainActivity: boolean): { resumeTarget: RunState; durableBoundary: "quiescent" | "uncertain_activity" } {
  if (originState === "IDLE" || originState === "PAUSED" || isTerminalState(originState)) {
    throw new StateMachineError("INVALID_PAUSE_ORIGIN", `cannot pause from ${originState}`);
  }
  const resumeTarget = originState === "EXECUTE" || uncertainActivity ? "RECOVERY" : originState;
  if (!isPauseResumeTarget(resumeTarget)) {
    throw new StateMachineError("INVALID_RESUME_TARGET", `pause target ${resumeTarget} is not an actual resumable state`);
  }
  return {
    resumeTarget,
    durableBoundary: resumeTarget === "RECOVERY" ? "uncertain_activity" : "quiescent",
  };
}

export function assertResumeTarget(target: RunState): void {
  if (!isPauseResumeTarget(target) || !isLegalTransition("PAUSED", target)) {
    throw new StateMachineError("INVALID_RESUME_TARGET", `resume target ${target} is not legal from PAUSED`);
  }
}

export function allLegalTransitions(): Array<readonly [RunState, RunState]> {
  return (Object.entries(LEGAL_TRANSITIONS) as Array<[RunState, readonly RunState[]]>).flatMap(([from, targets]) => targets.map((to) => [from, to] as const));
}
