import { createHash } from "node:crypto";

import type {
  EvidenceClassification,
  FailureClassification,
  AttemptId,
  PlanningDecision,
  RunId,
  TaskId,
  SemanticReviewResult,
  ValidationBundle,
  ValidationEvidence,
  ValidationLevel,
} from "./contracts.js";
import { parsePlanningDecision } from "./contracts.js";
import type { AntiGreenwashingSignal } from "./anti-greenwashing.js";
import { KerbsFlowError } from "./errors.js";
import { StateStore, type StoredFailureOccurrence } from "./persistence.js";

export type EvidenceSource = "executor_claim" | "verifier_command" | "deterministic_inspection" | "semantic_review" | "simulation" | "human_observation" | "none";

const MAXIMUM_CLASSIFICATION: Readonly<Record<EvidenceSource, EvidenceClassification>> = {
  executor_claim: "not_tested",
  verifier_command: "automatically_tested",
  deterministic_inspection: "inspected",
  semantic_review: "inspected",
  simulation: "simulated",
  human_observation: "manually_validated",
  none: "not_tested",
};

export function classificationForSource(source: EvidenceSource): EvidenceClassification {
  return MAXIMUM_CLASSIFICATION[source];
}

export function assertEvidenceAuthority(source: EvidenceSource, classification: EvidenceClassification): void {
  if (classification !== MAXIMUM_CLASSIFICATION[source]) {
    throw new KerbsFlowError(
      "EVIDENCE_CLASSIFICATION_INFLATED",
      `${source} evidence must be classified as ${MAXIMUM_CLASSIFICATION[source]}, not ${classification}`,
    );
  }
}

export function selectValidationLevel(actionLevel: ValidationLevel, policyLevel: ValidationLevel): ValidationLevel {
  return validationRank(actionLevel) >= validationRank(policyLevel) ? actionLevel : policyLevel;
}

export function validationSatisfiesLevel(bundle: ValidationBundle, required: ValidationLevel): boolean {
  return validationRank(bundle.level) >= validationRank(required);
}

export interface FailureFingerprintInput {
  failureClass: FailureClassification;
  reasonCode: string;
  diagnostic: string;
  category?: string;
  checkIdentity?: string;
}

export interface FailureFingerprint {
  fingerprint: string;
  normalized: {
    failureClass: FailureClassification;
    reasonCode: string;
    diagnostic: string;
    category: string;
    checkIdentity: string;
  };
}

export function createFailureFingerprint(input: FailureFingerprintInput): FailureFingerprint {
  const normalized = {
    failureClass: input.failureClass,
    reasonCode: normalizeToken(input.reasonCode),
    diagnostic: normalizeDiagnostic(input.diagnostic),
    category: normalizeToken(input.category ?? "unspecified"),
    checkIdentity: normalizeToken(input.checkIdentity ?? "unspecified"),
  };
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    normalized,
  };
}

export type FailureAction = "retry_same_route" | "rework" | "escalate" | "human_gate" | "failed";

export interface FailurePolicyInput {
  failureClass: FailureClassification;
  occurrence: number;
  implementationAttempts: number;
  maxImplementationAttempts: 1 | 2;
  transient: boolean;
  causalDiagnosis: boolean;
  scopeUnchanged: boolean;
  eligibleHigherRoute: boolean;
  alreadyEscalated: boolean;
}

export interface FailurePolicyDecision {
  action: FailureAction;
  reasonCode: string;
}

export function decideFailureAction(input: FailurePolicyInput): FailurePolicyDecision {
  if (input.occurrence > 1) {
    if (input.eligibleHigherRoute && !input.alreadyEscalated && input.implementationAttempts < input.maxImplementationAttempts) {
      return { action: "escalate", reasonCode: "repeated_fingerprint_escalate_once" };
    }
    return { action: "human_gate", reasonCode: "repeated_loop_human_gate" };
  }
  if (input.implementationAttempts >= input.maxImplementationAttempts) {
    return { action: "human_gate", reasonCode: "implementation_attempt_budget_exhausted" };
  }
  switch (input.failureClass) {
    case "executor_error":
    case "environment_or_tool_failure":
      return input.transient
        ? { action: "retry_same_route", reasonCode: "single_transient_retry" }
        : input.eligibleHigherRoute && !input.alreadyEscalated
          ? { action: "escalate", reasonCode: "nontransient_tool_escalation" }
          : { action: "human_gate", reasonCode: "tool_failure_not_safely_retryable" };
    case "implementation_failure":
    case "validation_failure":
      return input.causalDiagnosis && input.scopeUnchanged
        ? { action: "rework", reasonCode: "single_bounded_causal_rework" }
        : { action: "human_gate", reasonCode: "failure_not_bounded_for_rework" };
    case "scope_violation":
      return input.causalDiagnosis && input.scopeUnchanged
        ? { action: "rework", reasonCode: "scope_violation_controlled_rework" }
        : { action: "human_gate", reasonCode: "scope_violation_gate" };
    case "invariant_violation":
      return input.eligibleHigherRoute && !input.alreadyEscalated
        ? { action: "escalate", reasonCode: "invariant_violation_escalation" }
        : { action: "human_gate", reasonCode: "invariant_violation_gate" };
    case "requirement_or_architecture_ambiguity":
      return { action: "human_gate", reasonCode: "requirement_or_architecture_gate" };
    case "security_or_privilege_gate":
      return { action: "human_gate", reasonCode: "security_or_privilege_gate" };
    case "repeated_loop":
      return input.eligibleHigherRoute && !input.alreadyEscalated
        ? { action: "escalate", reasonCode: "repeated_loop_escalate_once" }
        : { action: "human_gate", reasonCode: "repeated_loop_human_gate" };
    case "cancelled":
      return { action: "failed", reasonCode: "cancelled_no_retry" };
    case "unknown":
      return { action: "human_gate", reasonCode: "unknown_failure_gate" };
  }
}

export interface RecordedFailureInput extends Omit<FailurePolicyInput, "occurrence" | "implementationAttempts" | "maxImplementationAttempts" | "alreadyEscalated"> {
  runId: RunId;
  taskId: TaskId;
  attemptId?: AttemptId;
  fingerprintInput: FailureFingerprintInput;
  route: { adapter: string; model: string; reasoning?: string };
}

export class FailurePolicyCoordinator {
  constructor(private readonly store: StateStore, private readonly maxImplementationAttempts: 1 | 2) {}

  recordAndDecide(input: RecordedFailureInput): StoredFailureOccurrence {
    const fingerprint = createFailureFingerprint(input.fingerprintInput);
    if (input.attemptId !== undefined) {
      const existing = this.store.getFailureOccurrenceForAttempt(input.runId, input.taskId, input.attemptId, fingerprint.fingerprint);
      if (existing !== undefined) {
        return existing;
      }
    }
    const occurrence = this.store.countFailureOccurrences(input.runId, input.taskId, fingerprint.fingerprint) + 1;
    const implementationAttempts = this.store.countTaskAttempts(input.runId, input.taskId);
    const decision = decideFailureAction({
      failureClass: input.failureClass,
      occurrence,
      implementationAttempts,
      maxImplementationAttempts: this.maxImplementationAttempts,
      transient: input.transient,
      causalDiagnosis: input.causalDiagnosis,
      scopeUnchanged: input.scopeUnchanged,
      eligibleHigherRoute: input.eligibleHigherRoute,
      alreadyEscalated: this.store.hasFailureEscalation(input.runId, input.taskId),
    });
    return this.store.recordFailureOccurrence({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId ?? null,
      fingerprint: fingerprint.fingerprint,
      failureClass: input.failureClass,
      reasonCode: input.fingerprintInput.reasonCode,
      normalizedJson: JSON.stringify(fingerprint.normalized),
      routeJson: JSON.stringify(input.route),
      resultingAction: decision.action,
      escalationReason: decision.action === "escalate" ? decision.reasonCode : null,
    });
  }
}

export function escalatePlanningRoute(
  decision: PlanningDecision,
  route: { model: string; reasoning?: string },
): PlanningDecision {
  return parsePlanningDecision({
    ...decision,
    route: {
      ...decision.route,
      model: route.model,
      ...(route.reasoning === undefined ? {} : { reasoning: route.reasoning }),
    },
  });
}

export interface TrustedReviewInput {
  requiredLevel: ValidationLevel;
  validation: ValidationBundle;
  antiGreenwashing: readonly AntiGreenwashingSignal[];
  semanticReview?: SemanticReviewResult;
  canonicalIntentCurrent: boolean;
  phaseCloseRequested: boolean;
}

export interface TrustedReviewOutcome {
  outcome: "next_phase" | "verify_phase" | "rework" | "human_gate";
  reasonCode: string;
  failureClass?: FailureClassification;
  evidence: ValidationEvidence[];
}

export function decideTrustedReview(input: TrustedReviewInput): TrustedReviewOutcome {
  if (!input.canonicalIntentCurrent) {
    return { outcome: "human_gate", reasonCode: "canonical_intent_drift", failureClass: "requirement_or_architecture_ambiguity", evidence: input.validation.evidence };
  }
  if (!validationSatisfiesLevel(input.validation, input.requiredLevel)) {
    return { outcome: "rework", reasonCode: "validation_level_insufficient", failureClass: "validation_failure", evidence: input.validation.evidence };
  }
  if (input.validation.evidence.length === 0) {
    return { outcome: "rework", reasonCode: "validation_evidence_missing", failureClass: "validation_failure", evidence: [] };
  }
  const independentProof = input.validation.evidence.some((evidence) => evidence.classification === "automatically_tested" || evidence.classification === "manually_validated");
  const checkAuthoritySupported = input.validation.checks.every((check) =>
    check.outcome !== "passed"
    || (check.evidenceClass !== "automatically_tested" && check.evidenceClass !== "manually_validated")
    || input.validation.evidence.some((evidence) => evidence.classification === check.evidenceClass));
  if (!independentProof || !checkAuthoritySupported) {
    return { outcome: "rework", reasonCode: "validation_proof_insufficient", failureClass: "validation_failure", evidence: input.validation.evidence };
  }
  if (input.validation.outcome !== "passed" || input.validation.checks.some((check) => check.outcome !== "passed")) {
    return { outcome: "rework", reasonCode: "validation_not_passed", failureClass: "validation_failure", evidence: input.validation.evidence };
  }
  const blocking = input.antiGreenwashing.filter((signal) => signal.blocksPass);
  if (blocking.length > 0) {
    return { outcome: "rework", reasonCode: `anti_greenwashing_${blocking[0]!.code}`, failureClass: "validation_failure", evidence: input.validation.evidence };
  }
  const semanticRequired = input.antiGreenwashing.some((signal) => signal.semanticReviewRequired);
  if (semanticRequired && input.semanticReview === undefined) {
    return { outcome: "human_gate", reasonCode: "semantic_review_required", failureClass: "unknown", evidence: input.validation.evidence };
  }
  if (input.semanticReview !== undefined) {
    if (input.semanticReview.evidence.length === 0) {
      return { outcome: "human_gate", reasonCode: "semantic_review_evidence_missing", failureClass: "unknown", evidence: input.validation.evidence };
    }
    if (input.semanticReview.evidence.some((evidence) => evidence.classification !== "inspected")) {
      throw new KerbsFlowError("EVIDENCE_CLASSIFICATION_INFLATED", "semantic reviewer evidence must remain inspected evidence");
    }
    switch (input.semanticReview.outcome) {
      case "rework_required":
        return { outcome: "rework", reasonCode: "semantic_review_rework", failureClass: "implementation_failure", evidence: [...input.validation.evidence, ...input.semanticReview.evidence] };
      case "escalation_required":
      case "human_gate_required":
      case "evidence_insufficient":
        return { outcome: "human_gate", reasonCode: `semantic_review_${input.semanticReview.outcome}`, failureClass: "unknown", evidence: [...input.validation.evidence, ...input.semanticReview.evidence] };
      case "supports_continuation":
        break;
    }
  }
  return {
    outcome: input.phaseCloseRequested ? "next_phase" : "verify_phase",
    reasonCode: input.phaseCloseRequested ? "trusted_phase_close" : "trusted_phase_verification_required",
    evidence: input.semanticReview === undefined ? input.validation.evidence : [...input.validation.evidence, ...input.semanticReview.evidence],
  };
}

function validationRank(level: ValidationLevel): number {
  return level === "focused" ? 1 : level === "phase" ? 2 : 3;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 200) || "unspecified";
}

function normalizeDiagnostic(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gu, "<timestamp>")
    .replace(/\b(?:run|task|attempt|review|command|artifact|validation|gate)_[a-z0-9_-]+\b/gu, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gu, "<hex>")
    .replace(/(?:\/[a-z0-9._-]+){2,}/giu, "<path>")
    .replace(/\b\d+\b/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1000);
}
