import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type PlanningDecision,
  type RunId,
  type TaskId,
  asDecisionId,
  parsePlanningDecision,
} from "./contracts.js";

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
