import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type InstructionId,
  type PlanningDecision,
  type RunId,
  type TaskId,
  type ValidationLevel,
  asDecisionId,
  asInstructionId,
  parsePlanningDecision,
  parseSteerText,
} from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import type { FailureAction } from "./phase3.js";
import type { TrustedRoutingDecision } from "./routing.js";

export interface Phase2ActionInput {
  decisionId: string;
  runId: RunId;
  taskId: TaskId;
  objective: string;
  acceptance: string[];
  positiveScope: string[];
  negativeScope: string[];
  model: string;
  reasoning?: string;
  canonicalContext: string;
}

export function createPhase2PlanningDecision(input: Phase2ActionInput): PlanningDecision {
  if (input.positiveScope.length < 1 || input.acceptance.length < 1 || input.negativeScope.length < 1) {
    throw new Error("Phase 2 actions require positive scope, negative scope, and acceptance criteria");
  }
  return parsePlanningDecision({
    schemaVersion: CONTRACT_VERSIONS.planningDecision,
    decisionId: asDecisionId(input.decisionId),
    runId: input.runId,
    taskId: input.taskId,
    action: {
      kind: "implementation",
      summary: input.objective,
      acceptance: input.acceptance,
      validationLevel: "focused",
      positiveScope: input.positiveScope,
      negativeScope: input.negativeScope,
    },
    route: {
      adapter: "codex",
      model: input.model,
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    },
    requiredCapabilities: ["jsonl", "final_json_schema", "workspace_write_sandbox", "process_cancellation"],
    selectedSkills: [],
    canonicalContextHash: createHash("sha256").update(input.canonicalContext).digest("hex"),
    policyVersion: "kerbsflow.phase2/v1",
  });
}

export function buildExecutorPrompt(decision: PlanningDecision): string {
  const lines = [
    "You are the bounded KerbsFlow implementation executor for one approved action.",
    `Objective: ${decision.action.summary}`,
    "Positive scope:",
    ...decision.action.positiveScope.map((value) => `- ${value}`),
    "Negative scope:",
    ...decision.action.negativeScope.map((value) => `- ${value}`),
    "Acceptance criteria:",
    ...decision.action.acceptance.map((value) => `- ${value}`),
    "Invariants:",
    "- Work only inside the current assigned Git worktree.",
    "- Do not push, merge, tag, release, deploy, access production, or expose credentials.",
    "- Do not broaden scope or modify orchestration authority.",
    "- Run only the focused checks needed for this action and report them honestly.",
    "- Finish with the requested ExecutorResult JSON; claims are evidence, not verifier authority.",
    "- Use the exact run/task/attempt IDs supplied below; ValidationEvidence IDs must start with validation_.",
    "- Leave every evidenceRefs and artifacts array empty because only KerbsFlow allocates artifact IDs.",
  ];
  const prompt = lines.join("\n");
  if (prompt.length > 4000) {
    throw new Error("bounded executor prompt exceeds the ExecutionRequest contract limit");
  }
  return prompt;
}

export const buildCodexPrompt = buildExecutorPrompt;

export interface PlanningSteerObservation {
  instructionId: InstructionId | null;
  text: string | null;
}

export function noneSteerObservation(): PlanningSteerObservation {
  return { instructionId: null, text: null };
}

export function parsePlanningSteerObservation(value: unknown, path = "observedSteer"): PlanningSteerObservation {
  if (value === undefined) {
    return noneSteerObservation();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path} must be an object with instructionId and text`);
  }
  const record = value as Record<string, unknown>;
  const keys = new Set(Object.keys(record));
  for (const key of keys) {
    if (key !== "instructionId" && key !== "text") {
      throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path}.${key} is an unknown field`);
    }
  }
  const rawId = record.instructionId ?? null;
  const rawText = record.text ?? null;
  if (rawId === null || rawId === undefined) {
    if (rawText !== null && rawText !== undefined) {
      throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path} cannot carry text without an instruction ID`);
    }
    return noneSteerObservation();
  }
  if (typeof rawId !== "string") {
    throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path}.instructionId must be a string`);
  }
  let instructionId: InstructionId;
  try {
    instructionId = asInstructionId(rawId);
  } catch {
    throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path}.instructionId is not a valid instruction ID`);
  }
  if (typeof rawText !== "string") {
    throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path}.text must be bounded instruction text when an instruction is observed`);
  }
  try {
    parseSteerText(rawText, `${path}.text`);
  } catch {
    throw new KerbsFlowError("PLANNING_STEER_INVALID", `${path}.text must be non-empty and at most 4096 UTF-8 bytes`);
  }
  return { instructionId, text: rawText };
}

export interface InitialPlanningInput {
  runId: RunId;
  taskId: TaskId;
  objective: string;
  steer: PlanningSteerObservation;
}

interface ReworkFailureContextBase {
  failureClass: string;
  reasonCode: string;
  summary: string;
}

export type ReworkFailureContext = Readonly<ReworkFailureContextBase & (
  | {
    resultingAction: "escalate";
    escalationReason: string;
    requiredRoute: Readonly<{ adapter: "codex"; model: string; reasoning?: string }>;
  }
  | {
    resultingAction: Exclude<FailureAction, "escalate">;
    escalationReason?: string;
    requiredRoute?: never;
  }
)>;

export interface ReworkPlanningInput {
  runId: RunId;
  taskId: TaskId;
  priorDecision: PlanningDecision;
  failure: ReworkFailureContext;
  steer: PlanningSteerObservation;
}

export interface PlanningMasterResult {
  decision: PlanningDecision;
  routingDecision?: TrustedRoutingDecision;
}

export interface PlanningMaster {
  planInitial(input: InitialPlanningInput): PlanningMasterResult | Promise<PlanningMasterResult>;
  planRework(input: ReworkPlanningInput): PlanningMasterResult | Promise<PlanningMasterResult>;
}

export function assertReworkDecisionBounds(prior: PlanningDecision, corrected: PlanningDecision, allowedAdapters: readonly string[]): void {
  if (corrected.runId !== prior.runId || corrected.taskId !== prior.taskId) {
    throw new KerbsFlowError("REWORK_SCOPE_MISMATCH", "rework must preserve run and task identity without a human gate");
  }
  if (corrected.canonicalContextHash !== prior.canonicalContextHash) {
    throw new KerbsFlowError("REWORK_CANONICAL_DRIFT", "rework must preserve the canonical context binding without a human gate");
  }
  if (corrected.policyVersion !== prior.policyVersion) {
    throw new KerbsFlowError("REWORK_POLICY_MISMATCH", "rework must preserve the policy version without a human gate");
  }
  if (JSON.stringify(corrected.action.acceptance) !== JSON.stringify(prior.action.acceptance)) {
    throw new KerbsFlowError("REWORK_ACCEPTANCE_CHANGED", "rework must preserve acceptance criteria without a human gate");
  }
  if (JSON.stringify(corrected.action.negativeScope) !== JSON.stringify(prior.action.negativeScope)) {
    throw new KerbsFlowError("REWORK_NEGATIVE_SCOPE_CHANGED", "rework must preserve negative scope without a human gate");
  }
  if (validationRank(corrected.action.validationLevel) < validationRank(prior.action.validationLevel)) {
    throw new KerbsFlowError("REWORK_VALIDATION_WEAKENED", "rework must not weaken the validation level without a human gate");
  }
  if (JSON.stringify(corrected.requiredCapabilities) !== JSON.stringify(prior.requiredCapabilities)) {
    throw new KerbsFlowError("REWORK_CAPABILITIES_CHANGED", "rework must preserve required capabilities without a human gate");
  }
  if (JSON.stringify(corrected.selectedSkills) !== JSON.stringify(prior.selectedSkills)) {
    throw new KerbsFlowError("REWORK_SKILLS_CHANGED", "rework must preserve selected skills without a human gate");
  }
  const priorScope = new Set(prior.action.positiveScope);
  for (const entry of corrected.action.positiveScope) {
    if (!priorScope.has(entry)) {
      throw new KerbsFlowError("REWORK_SCOPE_BROADENED", "rework must not broaden positive scope without a human gate");
    }
  }
  if (corrected.action.kind !== prior.action.kind && corrected.action.kind !== "rework") {
    throw new KerbsFlowError("REWORK_KIND_INVALID", "a corrected rework decision may only retain its action kind or move to rework");
  }
  if (!allowedAdapters.includes(corrected.route.adapter)) {
    throw new KerbsFlowError("ROUTE_NOT_ALLOWED", `adapter ${corrected.route.adapter} is not enabled by project policy`);
  }
}

function validationRank(level: ValidationLevel): number {
  return level === "focused" ? 1 : level === "phase" ? 2 : 3;
}
