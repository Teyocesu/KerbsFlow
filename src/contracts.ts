import { createHash } from "node:crypto";

export const CONTRACT_VERSIONS = {
  command: "kerbsflow.command/v1",
  commandResult: "kerbsflow.command-result/v1",
  pause: "kerbsflow.pause-contract/v1",
  planningDecision: "kerbsflow.planning-decision/v1",
  adapterDescriptor: "kerbsflow.adapter-descriptor/v1",
  normalizedEvent: "kerbsflow.normalized-event/v1",
  executionRequest: "kerbsflow.execution-request/v1",
  attemptHandle: "kerbsflow.attempt-handle/v1",
  executorResult: "kerbsflow.executor-result/v1",
  validation: "kerbsflow.validation/v1",
  humanGate: "kerbsflow.human-gate/v1",
  reviewDecision: "kerbsflow.review-decision/v1",
  semanticReviewRequest: "kerbsflow.semantic-review-request/v1",
  semanticReviewResult: "kerbsflow.semantic-review-result/v1",
  semanticReviewHandle: "kerbsflow.semantic-review-handle/v1",
  recoveryDecision: "kerbsflow.recovery-decision/v1",
  config: "kerbsflow.config/v1",
} as const;

export type ContractVersion = (typeof CONTRACT_VERSIONS)[keyof typeof CONTRACT_VERSIONS];

export class ContractValidationError extends Error {
  readonly code = "CONTRACT_INVALID";
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type BrandedId<Name extends string> = string & { readonly __brand: Name };
export type RunId = BrandedId<"RunId">;
export type TaskId = BrandedId<"TaskId">;
export type AttemptId = BrandedId<"AttemptId">;
export type ArtifactId = BrandedId<"ArtifactId">;
export type GateId = BrandedId<"GateId">;
export type TransitionId = BrandedId<"TransitionId">;
export type CommandId = BrandedId<"CommandId">;
export type DecisionId = BrandedId<"DecisionId">;
export type ValidationId = BrandedId<"ValidationId">;
export type ReviewId = BrandedId<"ReviewId">;

const ID_PREFIXES = {
  run: "run_",
  task: "task_",
  attempt: "attempt_",
  artifact: "artifact_",
  gate: "gate_",
  transition: "transition_",
  command: "command_",
  decision: "decision_",
  validation: "validation_",
  review: "review_",
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

export function makeId(prefix: IdPrefix, suffix: string): string {
  assertIdSuffix(suffix, "suffix");
  return `${ID_PREFIXES[prefix]}${suffix}`;
}

export function asRunId(value: string): RunId {
  return asId(value, ID_PREFIXES.run, "runId") as RunId;
}

export function asTaskId(value: string): TaskId {
  return asId(value, ID_PREFIXES.task, "taskId") as TaskId;
}

export function asAttemptId(value: string): AttemptId {
  return asId(value, ID_PREFIXES.attempt, "attemptId") as AttemptId;
}

export function asArtifactId(value: string): ArtifactId {
  return asId(value, ID_PREFIXES.artifact, "artifactId") as ArtifactId;
}

export function asGateId(value: string): GateId {
  return asId(value, ID_PREFIXES.gate, "gateId") as GateId;
}

export function asTransitionId(value: string): TransitionId {
  return asId(value, ID_PREFIXES.transition, "transitionId") as TransitionId;
}

export function asCommandId(value: string): CommandId {
  return asId(value, ID_PREFIXES.command, "commandId") as CommandId;
}

export function asDecisionId(value: string): DecisionId {
  return asId(value, ID_PREFIXES.decision, "decisionId") as DecisionId;
}

export function asValidationId(value: string): ValidationId {
  return asId(value, ID_PREFIXES.validation, "validationId") as ValidationId;
}

export function asReviewId(value: string): ReviewId {
  return asId(value, ID_PREFIXES.review, "reviewId") as ReviewId;
}

function assertIdSuffix(value: string, path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) {
    throw new ContractValidationError(path, "must be a bounded identifier suffix");
  }
}

function asId(value: string, prefix: string, path: string): string {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new ContractValidationError(path, `must start with ${prefix}`);
  }
  assertIdSuffix(value.slice(prefix.length), path);
  return value;
}

export type RunState =
  | "IDLE"
  | "INTAKE"
  | "PLAN"
  | "READY"
  | "EXECUTE"
  | "VERIFY_FOCUSED"
  | "REVIEW"
  | "REWORK"
  | "VERIFY_PHASE"
  | "NEXT_PHASE"
  | "FINAL_VERIFY"
  | "HUMAN_GATE"
  | "HUMAN_RELEASE_GATE"
  | "PAUSED"
  | "RECOVERY"
  | "FAILED"
  | "CANCELLED"
  | "DONE";

export const RUN_STATES: readonly RunState[] = [
  "IDLE",
  "INTAKE",
  "PLAN",
  "READY",
  "EXECUTE",
  "VERIFY_FOCUSED",
  "REVIEW",
  "REWORK",
  "VERIFY_PHASE",
  "NEXT_PHASE",
  "FINAL_VERIFY",
  "HUMAN_GATE",
  "HUMAN_RELEASE_GATE",
  "PAUSED",
  "RECOVERY",
  "FAILED",
  "CANCELLED",
  "DONE",
];

export const TERMINAL_STATES: readonly RunState[] = ["FAILED", "CANCELLED", "DONE"];

export const PAUSE_RESUME_TARGETS: readonly RunState[] = [
  "INTAKE",
  "PLAN",
  "READY",
  "VERIFY_FOCUSED",
  "REVIEW",
  "REWORK",
  "VERIFY_PHASE",
  "NEXT_PHASE",
  "FINAL_VERIFY",
  "HUMAN_GATE",
  "HUMAN_RELEASE_GATE",
  "RECOVERY",
];

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function parseRunState(value: unknown, path = "state"): RunState {
  if (!isRunState(value)) {
    throw new ContractValidationError(path, "unknown run state");
  }
  return value;
}

export function isTerminalState(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isPauseResumeTarget(state: RunState): boolean {
  return (PAUSE_RESUME_TARGETS as readonly string[]).includes(state);
}

export type Actor = "human" | "core" | "planner" | "adapter" | "verifier" | "recovery";

export function parseActor(value: unknown, path = "actor"): Actor {
  if (value === "human" || value === "core" || value === "planner" || value === "adapter" || value === "verifier" || value === "recovery") {
    return value;
  }
  throw new ContractValidationError(path, "unknown actor");
}

export type CommandKind = "start" | "transition" | "pause" | "resume" | "cancel" | "begin_attempt" | "complete_attempt" | "validation" | "review" | "phase" | "gate_resolution" | "recovery";

export interface CommandBase {
  schemaVersion: typeof CONTRACT_VERSIONS.command;
  commandId: CommandId;
  idempotencyKey: string;
  runId: RunId;
  expectedStateVersion: number;
}

export interface TransitionCommand extends CommandBase {
  kind: "transition";
  target: RunState;
  actor: Actor;
  reasonCode: string;
  payload?: JsonValue;
}

export interface StartCommand extends CommandBase {
  kind: "start";
  objective: string;
}

export interface PauseCommand extends CommandBase {
  kind: "pause";
}

export interface ResumeCommand extends CommandBase {
  kind: "resume";
}

export interface CancelCommand extends CommandBase {
  kind: "cancel";
  reason: string;
}

export interface SpecializedCommand extends CommandBase {
  kind: Exclude<CommandKind, "start" | "transition" | "pause" | "resume" | "cancel">;
  payload: JsonValue;
}

export type Command = TransitionCommand | StartCommand | PauseCommand | ResumeCommand | CancelCommand | SpecializedCommand;

export interface CommandResult {
  schemaVersion: typeof CONTRACT_VERSIONS.commandResult;
  commandId: CommandId;
  idempotencyKey: string;
  runId: RunId;
  accepted: true;
  replayed: boolean;
  from: RunState;
  to: RunState;
  stateVersion: number;
  transitionId?: TransitionId;
  details?: JsonValue;
}

export interface PauseContract {
  schemaVersion: typeof CONTRACT_VERSIONS.pause;
  originState: Exclude<RunState, "IDLE" | "PAUSED" | "FAILED" | "CANCELLED" | "DONE">;
  durableBoundary: "quiescent" | "uncertain_activity";
  resumeTarget: Exclude<RunState, "IDLE" | "PAUSED" | "FAILED" | "CANCELLED" | "DONE">;
}

export type ValidationLevel = "focused" | "phase" | "full";
export type ValidationOutcome = "passed" | "failed" | "unknown";

export type FailureClassification =
  | "executor_error"
  | "implementation_failure"
  | "validation_failure"
  | "scope_violation"
  | "invariant_violation"
  | "environment_or_tool_failure"
  | "requirement_or_architecture_ambiguity"
  | "security_or_privilege_gate"
  | "repeated_loop"
  | "cancelled"
  | "unknown";

export const FAILURE_CLASSIFICATIONS: readonly FailureClassification[] = [
  "executor_error",
  "implementation_failure",
  "validation_failure",
  "scope_violation",
  "invariant_violation",
  "environment_or_tool_failure",
  "requirement_or_architecture_ambiguity",
  "security_or_privilege_gate",
  "repeated_loop",
  "cancelled",
  "unknown",
];

export function isFailureClassification(value: unknown): value is FailureClassification {
  return typeof value === "string" && (FAILURE_CLASSIFICATIONS as readonly string[]).includes(value);
}

export type EvidenceClassification = "automatically_tested" | "manually_validated" | "inspected" | "inferred" | "simulated" | "not_tested";
export type EvidenceKind = "command" | "diff" | "check" | "review" | "event" | "result" | "other";

export interface ValidationEvidence {
  schemaVersion: typeof CONTRACT_VERSIONS.validation;
  id: ValidationId;
  kind: EvidenceKind;
  classification: EvidenceClassification;
  summary: string;
  artifactRef?: ArtifactId;
}

export interface ValidationCheck {
  name: string;
  outcome: "passed" | "failed" | "skipped" | "not_run" | "unknown";
  evidenceClass: EvidenceClassification;
  evidenceRefs: ArtifactId[];
}

export interface ValidationBundle {
  schemaVersion: typeof CONTRACT_VERSIONS.validation;
  validationId: ValidationId;
  runId: RunId;
  taskId: TaskId;
  attemptId?: AttemptId;
  level: ValidationLevel;
  outcome: ValidationOutcome;
  summary: string;
  checks: ValidationCheck[];
  evidence: ValidationEvidence[];
}

export interface HumanGateOption {
  id: string;
  label: string;
  consequence: string;
  target: RunState;
}

export interface HumanGateResolution {
  optionId: string;
  actor: "human";
  resolvedAt: string;
  note?: string;
}

export interface HumanGate {
  schemaVersion: typeof CONTRACT_VERSIONS.humanGate;
  gateId: GateId;
  runId: RunId;
  taskId?: TaskId;
  attemptId?: AttemptId;
  reasonCode: string;
  summary: string;
  evidenceRefs: ArtifactId[];
  evidence?: ValidationEvidence[];
  options: HumanGateOption[];
  recommendation?: string;
  status: "open" | "resolved" | "rejected";
  resolution?: HumanGateResolution;
}

export interface PlanningDecision {
  schemaVersion: typeof CONTRACT_VERSIONS.planningDecision;
  decisionId: DecisionId;
  runId: RunId;
  taskId: TaskId;
  action: {
    kind: "implementation" | "rework" | "verification" | "phase_close";
    summary: string;
    acceptance: string[];
    validationLevel: ValidationLevel;
    positiveScope: string[];
    negativeScope: string[];
  };
  route: {
    adapter: string;
    model: string;
    reasoning?: string;
  };
  requiredCapabilities: string[];
  selectedSkills: string[];
  canonicalContextHash: string;
  policyVersion: string;
}

export type EventTransport = "jsonl" | "async_iterable" | "sse" | "text" | "none";
export type EnforcementStrength = "enforced" | "tool_policy_only" | "unavailable";

export interface AdapterDescriptor {
  schemaVersion: typeof CONTRACT_VERSIONS.adapterDescriptor;
  adapter: string;
  provider: string;
  adapterVersion: string;
  capabilities: {
    eventTransport: EventTransport;
    finalJsonSchema: boolean;
    modelSelection: boolean;
    reasoningEffort: string[];
    agentSelection: boolean;
    filesystemEnforcement: EnforcementStrength;
    network: {
      providerControlPlane: "provider_owned" | "not_applicable";
      workload: EnforcementStrength;
    };
    cancellation: "native" | "process_only" | "simulated" | "none";
    resumableSession: boolean;
    authentication: {
      owner: "provider" | "kerbsflow" | "none";
      mode: string;
    };
    healthProbe: boolean;
  };
}

export type NormalizedEventKind = "started" | "progress" | "tool" | "permission" | "warning" | "completed" | "failed";

export interface NormalizedEvent {
  schemaVersion: typeof CONTRACT_VERSIONS.normalizedEvent;
  runId: RunId;
  attemptId: AttemptId;
  sequence: number;
  providerTimestamp?: string;
  kind: NormalizedEventKind;
  summary: string;
  artifactRef?: ArtifactId;
}

export type ExecutorOutcome = "succeeded" | "failed" | "blocked" | "partial" | "cancelled";
export type ScopeClaim = "within_scope" | "questionable" | "violated" | "unknown";
export type CheckOutcome = "passed" | "failed" | "skipped" | "not_run" | "unknown";
export type RecommendedNext = "verify_focused" | "rework" | "escalate" | "human_gate" | "fail";
export type ExitKind = "normal" | "signal" | "spawn_error" | "timeout" | "protocol_error" | "unknown";

export interface ExecutorResult {
  schemaVersion: typeof CONTRACT_VERSIONS.executorResult;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  executor: {
    adapter: string;
    adapterVersion: string;
    provider: string;
    model: string;
    reasoning?: string;
  };
  outcome: ExecutorOutcome;
  failureClass: FailureClassification | null;
  scopeClaim: ScopeClaim;
  summary: string;
  filesChanged: Array<{ path: string; change: "added" | "modified" | "deleted" | "renamed" | "unknown" }>;
  checks: Array<{
    name: string;
    outcome: CheckOutcome;
    evidenceClass: EvidenceClassification;
    evidenceRefs: ArtifactId[];
  }>;
  evidence: ValidationEvidence[];
  invariantViolations: string[];
  risks: string[];
  warnings: string[];
  artifacts: ArtifactId[];
  humanGate: HumanGate | null;
  recommendedNext: RecommendedNext;
  exit: {
    kind: ExitKind;
    code?: number;
    signal?: string;
    detail?: string;
  };
}

export type AttemptLifecycle = "PREPARED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "PARTIAL" | "CANCELLED" | "UNKNOWN";

export interface ExecutionRequest {
  schemaVersion: typeof CONTRACT_VERSIONS.executionRequest;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  role: "implementation";
  workingDirectory: string;
  promptSummary: string;
  model: string;
  reasoning?: string;
  permissionPolicy: {
    filesystem: "worktree_only";
    network: "denied";
  };
  timeoutMs: number;
  expectedResultSchema: typeof CONTRACT_VERSIONS.executorResult;
}

export interface AttemptHandle {
  schemaVersion: typeof CONTRACT_VERSIONS.attemptHandle;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  providerSessionId?: string;
}

export interface CancelOutcome {
  outcome: "cancelled" | "already_terminal" | "unknown";
  summary: string;
}

export interface ReconcileOutcome {
  outcome: "running" | "terminal" | "not_found" | "unknown";
  result?: ExecutorResult;
  summary: string;
}

export interface ReviewDecision {
  schemaVersion: typeof CONTRACT_VERSIONS.reviewDecision;
  reviewId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  outcome: "rework" | "verify_phase" | "next_phase" | "final_verify" | "human_gate" | "failed";
  failureClass?: FailureClassification;
  summary: string;
  evidenceRefs: ArtifactId[];
  evidence?: ValidationEvidence[];
  reasonCode: string;
}

export type SemanticReviewOutcome = "supports_continuation" | "rework_required" | "escalation_required" | "human_gate_required" | "evidence_insufficient";

export interface SemanticReviewRequest {
  schemaVersion: typeof CONTRACT_VERSIONS.semanticReviewRequest;
  reviewAttemptId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  role: "review";
  workingDirectory: string;
  promptSummary: string;
  model: string;
  reasoning?: string;
  permissionPolicy: {
    filesystem: "read_only";
    network: "denied";
  };
  canonicalContextHash: string;
  diffHash: string;
  validationIds: ValidationId[];
  expectedResultSchema: typeof CONTRACT_VERSIONS.semanticReviewResult;
}

export interface SemanticReviewResult {
  schemaVersion: typeof CONTRACT_VERSIONS.semanticReviewResult;
  reviewAttemptId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  reviewer: {
    adapter: string;
    adapterVersion: string;
    provider: string;
    model: string;
    reasoning?: string;
  };
  outcome: SemanticReviewOutcome;
  summary: string;
  findings: Array<{
    code: string;
    severity: "info" | "warning" | "blocking";
    summary: string;
    path?: string;
  }>;
  evidence: ValidationEvidence[];
  scopeConcerns: string[];
  invariantViolations: string[];
}

export interface SemanticReviewHandle {
  schemaVersion: typeof CONTRACT_VERSIONS.semanticReviewHandle;
  reviewAttemptId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  providerSessionId?: string;
}

export interface RecoveryDecision {
  schemaVersion: typeof CONTRACT_VERSIONS.recoveryDecision;
  runId: RunId;
  target: "EXECUTE" | "VERIFY_FOCUSED" | "REVIEW" | "READY" | "HUMAN_GATE" | "FAILED" | "CANCELLED";
  summary: string;
  evidenceRefs: ArtifactId[];
}

export interface HardInvariants {
  schemaVersion: typeof CONTRACT_VERSIONS.config;
  legalTransitions: true;
  singleActiveExecutor: true;
  independentEvidence: true;
  secretsAbsentFromPersistence: true;
  highImpactHumanGates: true;
  automaticReleaseActions: false;
  ambiguousReplay: false;
  executorCannotVerify: true;
  maxImplementationAttempts: 2;
}

export interface ProjectPolicy {
  schemaVersion: typeof CONTRACT_VERSIONS.config;
  allowedAdapters: string[];
  maxImplementationAttempts: 1 | 2;
  validationLevel: ValidationLevel;
  workloadNetwork: "denied";
  automaticReleaseActions: false;
}

export interface UserPreferences {
  schemaVersion: typeof CONTRACT_VERSIONS.config;
  preferredAdapter?: string;
  notificationMode: "quiet" | "normal";
}

export interface RunOverride {
  schemaVersion: typeof CONTRACT_VERSIONS.config;
  preferredAdapter?: string;
  maxImplementationAttempts?: 1 | 2;
  validationLevel?: ValidationLevel;
}

export interface ConfigLayers {
  hardInvariants: HardInvariants;
  projectPolicy: ProjectPolicy;
  userPreferences: UserPreferences;
  runOverride: RunOverride;
}

export interface EffectiveConfiguration extends ConfigLayers {
  effectiveAdapter: string;
  effectiveMaxImplementationAttempts: 1 | 2;
  effectiveValidationLevel: ValidationLevel;
}

export const DEFAULT_HARD_INVARIANTS: HardInvariants = {
  schemaVersion: CONTRACT_VERSIONS.config,
  legalTransitions: true,
  singleActiveExecutor: true,
  independentEvidence: true,
  secretsAbsentFromPersistence: true,
  highImpactHumanGates: true,
  automaticReleaseActions: false,
  ambiguousReplay: false,
  executorCannotVerify: true,
  maxImplementationAttempts: 2,
};

export const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  schemaVersion: CONTRACT_VERSIONS.config,
  allowedAdapters: ["fake"],
  maxImplementationAttempts: 2,
  validationLevel: "focused",
  workloadNetwork: "denied",
  automaticReleaseActions: false,
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  schemaVersion: CONTRACT_VERSIONS.config,
  notificationMode: "normal",
};

export const DEFAULT_RUN_OVERRIDE: RunOverride = {
  schemaVersion: CONTRACT_VERSIONS.config,
};

export function mergeConfiguration(layers: ConfigLayers): EffectiveConfiguration {
  assertHardInvariants(layers.hardInvariants);
  assertProjectPolicy(layers.projectPolicy);
  assertUserPreferences(layers.userPreferences);
  assertRunOverride(layers.runOverride);

  const allowed = new Set(layers.projectPolicy.allowedAdapters);
  const requestedAdapter = layers.runOverride.preferredAdapter ?? layers.userPreferences.preferredAdapter;
  if (requestedAdapter !== undefined && !allowed.has(requestedAdapter)) {
    throw new ContractValidationError("configuration.preferredAdapter", "lower configuration layer cannot select an adapter outside project policy");
  }

  const maxAttempts = layers.runOverride.maxImplementationAttempts ?? layers.projectPolicy.maxImplementationAttempts;
  if (maxAttempts > layers.projectPolicy.maxImplementationAttempts || maxAttempts > layers.hardInvariants.maxImplementationAttempts) {
    throw new ContractValidationError("configuration.maxImplementationAttempts", "lower configuration layer cannot increase the hard retry ceiling");
  }

  const validationLevel = layers.runOverride.validationLevel ?? layers.projectPolicy.validationLevel;
  if (validationRank(validationLevel) < validationRank(layers.projectPolicy.validationLevel)) {
    throw new ContractValidationError("configuration.validationLevel", "lower configuration layer cannot weaken project validation");
  }

  return {
    ...layers,
    effectiveAdapter: requestedAdapter ?? layers.projectPolicy.allowedAdapters[0]!,
    effectiveMaxImplementationAttempts: maxAttempts,
    effectiveValidationLevel: validationLevel,
  };
}

function validationRank(level: ValidationLevel): number {
  return level === "focused" ? 1 : level === "phase" ? 2 : 3;
}

export function parseCommand(value: unknown, path = "command"): Command {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.command, path);
  const base = parseCommandBase(object, path);
  const kind = requiredString(object, "kind", path);

  switch (kind) {
    case "start":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind", "objective"], path);
      return { ...base, kind, objective: boundedString(object.objective, `${path}.objective`, 10000) };
    case "transition":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind", "target", "actor", "reasonCode", "payload"], path);
      return {
        ...base,
        kind,
        target: parseRunState(object.target, `${path}.target`),
        actor: parseActor(object.actor, `${path}.actor`),
        reasonCode: boundedString(object.reasonCode, `${path}.reasonCode`, 120),
        ...(object.payload === undefined ? {} : { payload: jsonValue(object.payload, `${path}.payload`) }),
      };
    case "pause":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind"], path);
      return { ...base, kind };
    case "resume":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind"], path);
      return { ...base, kind };
    case "cancel":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind", "reason"], path);
      return { ...base, kind, reason: boundedString(object.reason, `${path}.reason`, 1000) };
    case "begin_attempt":
    case "complete_attempt":
    case "validation":
    case "review":
    case "phase":
    case "gate_resolution":
    case "recovery":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind", "payload"], path);
      return { ...base, kind, payload: jsonValue(object.payload, `${path}.payload`) };
    default:
      throw new ContractValidationError(`${path}.kind`, "unsupported command kind");
  }
}

export function parseCommandResult(value: unknown, path = "commandResult"): CommandResult {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.commandResult, path);
  assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "accepted", "replayed", "from", "to", "stateVersion", "transitionId", "details"], path);
  if (object.accepted !== true || typeof object.replayed !== "boolean") {
    throw new ContractValidationError(path, "command result flags are invalid");
  }
  const result: CommandResult = {
    schemaVersion: CONTRACT_VERSIONS.commandResult,
    commandId: asCommandId(requiredString(object, "commandId", path)),
    idempotencyKey: boundedString(object.idempotencyKey, `${path}.idempotencyKey`, 200),
    runId: asRunId(requiredString(object, "runId", path)),
    accepted: true,
    replayed: object.replayed,
    from: parseRunState(object.from, `${path}.from`),
    to: parseRunState(object.to, `${path}.to`),
    stateVersion: positiveInteger(object.stateVersion, `${path}.stateVersion`, true),
    ...(object.transitionId === undefined ? {} : { transitionId: asTransitionId(requiredString(object, "transitionId", path)) }),
    ...(object.details === undefined ? {} : { details: jsonValue(object.details, `${path}.details`) }),
  };
  return result;
}

export function parsePauseContract(value: unknown, path = "pauseContract"): PauseContract {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.pause, path);
  assertKeys(object, ["schemaVersion", "originState", "durableBoundary", "resumeTarget"], path);
  const originState = parseRunState(object.originState, `${path}.originState`);
  const resumeTarget = parseRunState(object.resumeTarget, `${path}.resumeTarget`);
  if (originState === "IDLE" || originState === "PAUSED" || isTerminalState(originState) || !isPauseResumeTarget(resumeTarget)) {
    throw new ContractValidationError(path, "pause origin or resume target is not a valid Phase 1 state");
  }
  if (object.durableBoundary !== "quiescent" && object.durableBoundary !== "uncertain_activity") {
    throw new ContractValidationError(`${path}.durableBoundary`, "unknown durable boundary");
  }
  if (object.durableBoundary === "quiescent" && resumeTarget !== originState) {
    throw new ContractValidationError(path, "a quiescent pause must resume to its originating state");
  }
  if (object.durableBoundary === "uncertain_activity" && resumeTarget !== "RECOVERY") {
    throw new ContractValidationError(path, "an uncertain pause must resume through RECOVERY");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.pause,
    originState: originState as PauseContract["originState"],
    durableBoundary: object.durableBoundary as PauseContract["durableBoundary"],
    resumeTarget: resumeTarget as PauseContract["resumeTarget"],
  };
}

export function parsePlanningDecision(value: unknown, path = "planningDecision"): PlanningDecision {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.planningDecision, path);
  assertKeys(object, ["schemaVersion", "decisionId", "runId", "taskId", "action", "route", "requiredCapabilities", "selectedSkills", "canonicalContextHash", "policyVersion"], path);
  const action = record(object.action, `${path}.action`);
  assertKeys(action, ["kind", "summary", "acceptance", "validationLevel", "positiveScope", "negativeScope"], `${path}.action`);
  const actionKind = action.kind;
  if (actionKind !== "implementation" && actionKind !== "rework" && actionKind !== "verification" && actionKind !== "phase_close") {
    throw new ContractValidationError(`${path}.action.kind`, "unsupported action kind");
  }
  const route = record(object.route, `${path}.route`);
  assertKeys(route, ["adapter", "model", "reasoning"], `${path}.route`);
  const result: PlanningDecision = {
    schemaVersion: CONTRACT_VERSIONS.planningDecision,
    decisionId: asDecisionId(requiredString(object, "decisionId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    action: {
      kind: actionKind,
      summary: boundedString(action.summary, `${path}.action.summary`, 2000),
      acceptance: boundedStringArray(action.acceptance, `${path}.action.acceptance`, 50, 2000),
      validationLevel: parseValidationLevel(action.validationLevel, `${path}.action.validationLevel`),
      positiveScope: boundedStringArray(action.positiveScope, `${path}.action.positiveScope`, 100, 1000),
      negativeScope: boundedStringArray(action.negativeScope, `${path}.action.negativeScope`, 100, 1000),
    },
    route: {
      adapter: boundedString(route.adapter, `${path}.route.adapter`, 100),
      model: boundedString(route.model, `${path}.route.model`, 200),
      ...(route.reasoning === undefined ? {} : { reasoning: boundedString(route.reasoning, `${path}.route.reasoning`, 100) }),
    },
    requiredCapabilities: boundedStringArray(object.requiredCapabilities, `${path}.requiredCapabilities`, 50, 100),
    selectedSkills: boundedStringArray(object.selectedSkills, `${path}.selectedSkills`, 50, 120),
    canonicalContextHash: boundedString(object.canonicalContextHash, `${path}.canonicalContextHash`, 200),
    policyVersion: boundedString(object.policyVersion, `${path}.policyVersion`, 100),
  };
  return result;
}

export function parseAdapterDescriptor(value: unknown, path = "adapterDescriptor"): AdapterDescriptor {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.adapterDescriptor, path);
  assertKeys(object, ["schemaVersion", "adapter", "provider", "adapterVersion", "capabilities"], path);
  const capabilities = record(object.capabilities, `${path}.capabilities`);
  assertKeys(capabilities, ["eventTransport", "finalJsonSchema", "modelSelection", "reasoningEffort", "agentSelection", "filesystemEnforcement", "network", "cancellation", "resumableSession", "authentication", "healthProbe"], `${path}.capabilities`);
  const network = record(capabilities.network, `${path}.capabilities.network`);
  assertKeys(network, ["providerControlPlane", "workload"], `${path}.capabilities.network`);
  const authentication = record(capabilities.authentication, `${path}.capabilities.authentication`);
  assertKeys(authentication, ["owner", "mode"], `${path}.capabilities.authentication`);
  const eventTransport = capabilities.eventTransport;
  if (eventTransport !== "jsonl" && eventTransport !== "async_iterable" && eventTransport !== "sse" && eventTransport !== "text" && eventTransport !== "none") {
    throw new ContractValidationError(`${path}.capabilities.eventTransport`, "unknown event transport");
  }
  if (network.providerControlPlane !== "provider_owned" && network.providerControlPlane !== "not_applicable") {
    throw new ContractValidationError(`${path}.capabilities.network.providerControlPlane`, "unknown provider network ownership");
  }
  if (authentication.owner !== "provider" && authentication.owner !== "kerbsflow" && authentication.owner !== "none") {
    throw new ContractValidationError(`${path}.capabilities.authentication.owner`, "unknown authentication owner");
  }
  const cancellation = capabilities.cancellation;
  if (cancellation !== "native" && cancellation !== "process_only" && cancellation !== "simulated" && cancellation !== "none") {
    throw new ContractValidationError(`${path}.capabilities.cancellation`, "unknown cancellation capability");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
    adapter: boundedString(object.adapter, `${path}.adapter`, 100),
    provider: boundedString(object.provider, `${path}.provider`, 100),
    adapterVersion: boundedString(object.adapterVersion, `${path}.adapterVersion`, 100),
    capabilities: {
      eventTransport,
      finalJsonSchema: booleanValue(capabilities.finalJsonSchema, `${path}.capabilities.finalJsonSchema`),
      modelSelection: booleanValue(capabilities.modelSelection, `${path}.capabilities.modelSelection`),
      reasoningEffort: boundedStringArray(capabilities.reasoningEffort, `${path}.capabilities.reasoningEffort`, 50, 100),
      agentSelection: booleanValue(capabilities.agentSelection, `${path}.capabilities.agentSelection`),
      filesystemEnforcement: parseEnforcement(capabilities.filesystemEnforcement, `${path}.capabilities.filesystemEnforcement`),
      network: {
        providerControlPlane: network.providerControlPlane,
        workload: parseEnforcement(network.workload, `${path}.capabilities.network.workload`),
      },
      cancellation,
      resumableSession: booleanValue(capabilities.resumableSession, `${path}.capabilities.resumableSession`),
      authentication: {
        owner: authentication.owner,
        mode: boundedString(authentication.mode, `${path}.capabilities.authentication.mode`, 100),
      },
      healthProbe: booleanValue(capabilities.healthProbe, `${path}.capabilities.healthProbe`),
    },
  };
}

export function parseNormalizedEvent(value: unknown, path = "normalizedEvent"): NormalizedEvent {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.normalizedEvent, path);
  assertKeys(object, ["schemaVersion", "runId", "attemptId", "sequence", "providerTimestamp", "kind", "summary", "artifactRef"], path);
  const kind = object.kind;
  if (kind !== "started" && kind !== "progress" && kind !== "tool" && kind !== "permission" && kind !== "warning" && kind !== "completed" && kind !== "failed") {
    throw new ContractValidationError(`${path}.kind`, "unknown normalized event kind");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.normalizedEvent,
    runId: asRunId(requiredString(object, "runId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    sequence: positiveInteger(object.sequence, `${path}.sequence`, false),
    ...(object.providerTimestamp === undefined ? {} : { providerTimestamp: boundedString(object.providerTimestamp, `${path}.providerTimestamp`, 100) }),
    kind,
    summary: boundedString(object.summary, `${path}.summary`, 2000),
    ...(object.artifactRef === undefined ? {} : { artifactRef: asArtifactId(requiredString(object, "artifactRef", path)) }),
  };
}

export function parseExecutionRequest(value: unknown, path = "executionRequest"): ExecutionRequest {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.executionRequest, path);
  assertKeys(object, ["schemaVersion", "runId", "taskId", "attemptId", "role", "workingDirectory", "promptSummary", "model", "reasoning", "permissionPolicy", "timeoutMs", "expectedResultSchema"], path);
  const permissionPolicy = record(object.permissionPolicy, `${path}.permissionPolicy`);
  assertKeys(permissionPolicy, ["filesystem", "network"], `${path}.permissionPolicy`);
  if (object.role !== "implementation" || permissionPolicy.filesystem !== "worktree_only" || permissionPolicy.network !== "denied") {
    throw new ContractValidationError(path, "Phase 1 execution requests must use the implementation role and denied-by-default fake permissions");
  }
  if (object.expectedResultSchema !== CONTRACT_VERSIONS.executorResult) {
    throw new ContractValidationError(`${path}.expectedResultSchema`, `expected ${CONTRACT_VERSIONS.executorResult}`);
  }
  const timeoutMs = integer(object.timeoutMs, `${path}.timeoutMs`);
  if (timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new ContractValidationError(`${path}.timeoutMs`, "must be between 1 millisecond and 24 hours");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.executionRequest,
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    role: "implementation",
    workingDirectory: boundedString(object.workingDirectory, `${path}.workingDirectory`, 2000),
    promptSummary: boundedString(object.promptSummary, `${path}.promptSummary`, 4000),
    model: boundedString(object.model, `${path}.model`, 200),
    ...(object.reasoning === undefined ? {} : { reasoning: boundedString(object.reasoning, `${path}.reasoning`, 100) }),
    permissionPolicy: { filesystem: "worktree_only", network: "denied" },
    timeoutMs,
    expectedResultSchema: CONTRACT_VERSIONS.executorResult,
  };
}

export function parseAttemptHandle(value: unknown, path = "attemptHandle"): AttemptHandle {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.attemptHandle, path);
  assertKeys(object, ["schemaVersion", "runId", "taskId", "attemptId", "providerSessionId"], path);
  return {
    schemaVersion: CONTRACT_VERSIONS.attemptHandle,
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    ...(object.providerSessionId === undefined ? {} : { providerSessionId: boundedString(object.providerSessionId, `${path}.providerSessionId`, 200) }),
  };
}

export function parseExecutorResult(value: unknown, path = "executorResult"): ExecutorResult {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.executorResult, path);
  assertKeys(object, ["schemaVersion", "runId", "taskId", "attemptId", "executor", "outcome", "failureClass", "scopeClaim", "summary", "filesChanged", "checks", "evidence", "invariantViolations", "risks", "warnings", "artifacts", "humanGate", "recommendedNext", "exit"], path);
  const executor = record(object.executor, `${path}.executor`);
  assertKeys(executor, ["adapter", "adapterVersion", "provider", "model", "reasoning"], `${path}.executor`);
  const outcome = object.outcome;
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "blocked" && outcome !== "partial" && outcome !== "cancelled") {
    throw new ContractValidationError(`${path}.outcome`, "unknown executor outcome");
  }
  const failureClass = object.failureClass === null ? null : parseFailureClass(object.failureClass, `${path}.failureClass`);
  if ((outcome === "succeeded" && failureClass !== null) || (outcome !== "succeeded" && failureClass === null)) {
    throw new ContractValidationError(`${path}.failureClass`, "successful results require null failureClass and other outcomes require a classification");
  }
  const scopeClaim = object.scopeClaim;
  if (scopeClaim !== "within_scope" && scopeClaim !== "questionable" && scopeClaim !== "violated" && scopeClaim !== "unknown") {
    throw new ContractValidationError(`${path}.scopeClaim`, "unknown scope claim");
  }
  const recommendedNext = object.recommendedNext;
  if (recommendedNext !== "verify_focused" && recommendedNext !== "rework" && recommendedNext !== "escalate" && recommendedNext !== "human_gate" && recommendedNext !== "fail") {
    throw new ContractValidationError(`${path}.recommendedNext`, "unknown recommended next action");
  }
  const exit = record(object.exit, `${path}.exit`);
  assertKeys(exit, ["kind", "code", "signal", "detail"], `${path}.exit`);
  const exitKind = exit.kind;
  if (exitKind !== "normal" && exitKind !== "signal" && exitKind !== "spawn_error" && exitKind !== "timeout" && exitKind !== "protocol_error" && exitKind !== "unknown") {
    throw new ContractValidationError(`${path}.exit.kind`, "unknown exit kind");
  }
  const result: ExecutorResult = {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    executor: {
      adapter: boundedString(executor.adapter, `${path}.executor.adapter`, 100),
      adapterVersion: boundedString(executor.adapterVersion, `${path}.executor.adapterVersion`, 100),
      provider: boundedString(executor.provider, `${path}.executor.provider`, 100),
      model: boundedString(executor.model, `${path}.executor.model`, 200),
      ...(executor.reasoning === undefined ? {} : { reasoning: boundedString(executor.reasoning, `${path}.executor.reasoning`, 100) }),
    },
    outcome,
    failureClass,
    scopeClaim,
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    filesChanged: parseFilesChanged(object.filesChanged, `${path}.filesChanged`),
    checks: parseChecks(object.checks, `${path}.checks`),
    evidence: parseEvidenceArray(object.evidence, `${path}.evidence`),
    invariantViolations: boundedStringArray(object.invariantViolations, `${path}.invariantViolations`, 50, 1000),
    risks: boundedStringArray(object.risks, `${path}.risks`, 50, 1000),
    warnings: boundedStringArray(object.warnings, `${path}.warnings`, 50, 1000),
    artifacts: parseIdArray(object.artifacts, `${path}.artifacts`, asArtifactId),
    humanGate: object.humanGate === null ? null : parseHumanGate(object.humanGate, `${path}.humanGate`),
    recommendedNext,
    exit: {
      kind: exitKind,
      ...(exit.code === undefined ? {} : { code: integer(exit.code, `${path}.exit.code`) }),
      ...(exit.signal === undefined ? {} : { signal: boundedString(exit.signal, `${path}.exit.signal`, 100) }),
      ...(exit.detail === undefined ? {} : { detail: boundedString(exit.detail, `${path}.exit.detail`, 1000) }),
    },
  };
  return result;
}

export function parseValidationBundle(value: unknown, path = "validation"): ValidationBundle {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.validation, path);
  assertKeys(object, ["schemaVersion", "validationId", "runId", "taskId", "attemptId", "level", "outcome", "summary", "checks", "evidence"], path);
  const outcome = object.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "unknown") {
    throw new ContractValidationError(`${path}.outcome`, "unknown validation outcome");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.validation,
    validationId: asValidationId(requiredString(object, "validationId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    ...(object.attemptId === undefined ? {} : { attemptId: asAttemptId(requiredString(object, "attemptId", path)) }),
    level: parseValidationLevel(object.level, `${path}.level`),
    outcome,
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    checks: parseChecks(object.checks, `${path}.checks`),
    evidence: parseEvidenceArray(object.evidence, `${path}.evidence`),
  };
}

export function parseHumanGate(value: unknown, path = "humanGate"): HumanGate {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.humanGate, path);
  assertKeys(object, ["schemaVersion", "gateId", "runId", "taskId", "attemptId", "reasonCode", "summary", "evidenceRefs", "evidence", "options", "recommendation", "status", "resolution"], path);
  const status = object.status;
  if (status !== "open" && status !== "resolved" && status !== "rejected") {
    throw new ContractValidationError(`${path}.status`, "unknown human gate status");
  }
  const options = array(object.options, `${path}.options`).map((entry, index) => {
    const option = record(entry, `${path}.options[${index}]`);
    assertKeys(option, ["id", "label", "consequence", "target"], `${path}.options[${index}]`);
    return {
      id: boundedString(option.id, `${path}.options[${index}].id`, 100),
      label: boundedString(option.label, `${path}.options[${index}].label`, 300),
      consequence: boundedString(option.consequence, `${path}.options[${index}].consequence`, 1000),
      target: parseRunState(option.target, `${path}.options[${index}].target`),
    };
  });
  if (options.length < 2) {
    throw new ContractValidationError(`${path}.options`, "a human gate requires at least two options");
  }
  const result: HumanGate = {
    schemaVersion: CONTRACT_VERSIONS.humanGate,
    gateId: asGateId(requiredString(object, "gateId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    ...(object.taskId === undefined ? {} : { taskId: asTaskId(requiredString(object, "taskId", path)) }),
    ...(object.attemptId === undefined ? {} : { attemptId: asAttemptId(requiredString(object, "attemptId", path)) }),
    reasonCode: boundedString(object.reasonCode, `${path}.reasonCode`, 120),
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    evidenceRefs: parseIdArray(object.evidenceRefs, `${path}.evidenceRefs`, asArtifactId),
    ...(object.evidence === undefined ? {} : { evidence: parseEvidenceArray(object.evidence, `${path}.evidence`) }),
    options,
    ...(object.recommendation === undefined ? {} : { recommendation: boundedString(object.recommendation, `${path}.recommendation`, 1000) }),
    status,
    ...(object.resolution === undefined ? {} : { resolution: parseGateResolution(object.resolution, `${path}.resolution`) }),
  };
  if (status === "open" && result.resolution !== undefined) {
    throw new ContractValidationError(path, "an open gate cannot contain a resolution");
  }
  if (status !== "open" && result.resolution === undefined) {
    throw new ContractValidationError(path, "a resolved or rejected gate requires a resolution");
  }
  return result;
}

export function parseReviewDecision(value: unknown, path = "reviewDecision"): ReviewDecision {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.reviewDecision, path);
  assertKeys(object, ["schemaVersion", "reviewId", "runId", "taskId", "outcome", "failureClass", "summary", "evidenceRefs", "evidence", "reasonCode"], path);
  const outcome = object.outcome;
  if (outcome !== "rework" && outcome !== "verify_phase" && outcome !== "next_phase" && outcome !== "final_verify" && outcome !== "human_gate" && outcome !== "failed") {
    throw new ContractValidationError(`${path}.outcome`, "unknown review outcome");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.reviewDecision,
    reviewId: asReviewId(requiredString(object, "reviewId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    outcome,
    ...(object.failureClass === undefined ? {} : { failureClass: parseFailureClass(object.failureClass, `${path}.failureClass`) }),
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    evidenceRefs: parseIdArray(object.evidenceRefs, `${path}.evidenceRefs`, asArtifactId),
    ...(object.evidence === undefined ? {} : { evidence: parseEvidenceArray(object.evidence, `${path}.evidence`) }),
    reasonCode: boundedString(object.reasonCode, `${path}.reasonCode`, 120),
  };
}

export function parseSemanticReviewRequest(value: unknown, path = "semanticReviewRequest"): SemanticReviewRequest {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.semanticReviewRequest, path);
  assertKeys(object, ["schemaVersion", "reviewAttemptId", "runId", "taskId", "attemptId", "role", "workingDirectory", "promptSummary", "model", "reasoning", "permissionPolicy", "canonicalContextHash", "diffHash", "validationIds", "expectedResultSchema"], path);
  const permissionPolicy = record(object.permissionPolicy, `${path}.permissionPolicy`);
  assertKeys(permissionPolicy, ["filesystem", "network"], `${path}.permissionPolicy`);
  if (object.role !== "review" || permissionPolicy.filesystem !== "read_only" || permissionPolicy.network !== "denied") {
    throw new ContractValidationError(path, "semantic review requires the review role with read-only filesystem and denied workload network");
  }
  if (object.expectedResultSchema !== CONTRACT_VERSIONS.semanticReviewResult) {
    throw new ContractValidationError(`${path}.expectedResultSchema`, `expected ${CONTRACT_VERSIONS.semanticReviewResult}`);
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewRequest,
    reviewAttemptId: asReviewId(requiredString(object, "reviewAttemptId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    role: "review",
    workingDirectory: boundedString(object.workingDirectory, `${path}.workingDirectory`, 2000),
    promptSummary: boundedString(object.promptSummary, `${path}.promptSummary`, 20_000),
    model: boundedString(object.model, `${path}.model`, 200),
    ...(object.reasoning === undefined ? {} : { reasoning: boundedString(object.reasoning, `${path}.reasoning`, 100) }),
    permissionPolicy: { filesystem: "read_only", network: "denied" },
    canonicalContextHash: boundedString(object.canonicalContextHash, `${path}.canonicalContextHash`, 200),
    diffHash: boundedString(object.diffHash, `${path}.diffHash`, 200),
    validationIds: parseIdArray(object.validationIds, `${path}.validationIds`, asValidationId),
    expectedResultSchema: CONTRACT_VERSIONS.semanticReviewResult,
  };
}

export function parseSemanticReviewResult(value: unknown, path = "semanticReviewResult"): SemanticReviewResult {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.semanticReviewResult, path);
  assertKeys(object, ["schemaVersion", "reviewAttemptId", "runId", "taskId", "attemptId", "reviewer", "outcome", "summary", "findings", "evidence", "scopeConcerns", "invariantViolations"], path);
  const reviewer = record(object.reviewer, `${path}.reviewer`);
  assertKeys(reviewer, ["adapter", "adapterVersion", "provider", "model", "reasoning"], `${path}.reviewer`);
  const outcome = object.outcome;
  if (outcome !== "supports_continuation" && outcome !== "rework_required" && outcome !== "escalation_required" && outcome !== "human_gate_required" && outcome !== "evidence_insufficient") {
    throw new ContractValidationError(`${path}.outcome`, "unknown semantic review outcome");
  }
  const findings = array(object.findings, `${path}.findings`).map((entry, index) => {
    const finding = record(entry, `${path}.findings[${index}]`);
    assertKeys(finding, ["code", "severity", "summary", "path"], `${path}.findings[${index}]`);
    if (finding.severity !== "info" && finding.severity !== "warning" && finding.severity !== "blocking") {
      throw new ContractValidationError(`${path}.findings[${index}].severity`, "unknown finding severity");
    }
    return {
      code: boundedString(finding.code, `${path}.findings[${index}].code`, 120),
      severity: finding.severity as SemanticReviewResult["findings"][number]["severity"],
      summary: boundedString(finding.summary, `${path}.findings[${index}].summary`, 2000),
      ...(finding.path === undefined ? {} : { path: boundedString(finding.path, `${path}.findings[${index}].path`, 1000) }),
    };
  });
  const result: SemanticReviewResult = {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewResult,
    reviewAttemptId: asReviewId(requiredString(object, "reviewAttemptId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    reviewer: {
      adapter: boundedString(reviewer.adapter, `${path}.reviewer.adapter`, 100),
      adapterVersion: boundedString(reviewer.adapterVersion, `${path}.reviewer.adapterVersion`, 100),
      provider: boundedString(reviewer.provider, `${path}.reviewer.provider`, 100),
      model: boundedString(reviewer.model, `${path}.reviewer.model`, 200),
      ...(reviewer.reasoning === undefined ? {} : { reasoning: boundedString(reviewer.reasoning, `${path}.reviewer.reasoning`, 100) }),
    },
    outcome,
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    findings,
    evidence: parseEvidenceArray(object.evidence, `${path}.evidence`),
    scopeConcerns: boundedStringArray(object.scopeConcerns, `${path}.scopeConcerns`, 50, 1000),
    invariantViolations: boundedStringArray(object.invariantViolations, `${path}.invariantViolations`, 50, 1000),
  };
  if (result.outcome === "supports_continuation" && (result.findings.some((finding) => finding.severity === "blocking") || result.scopeConcerns.length > 0 || result.invariantViolations.length > 0)) {
    throw new ContractValidationError(path, "a reviewer cannot support continuation while reporting blocking, scope, or invariant concerns");
  }
  return result;
}

export function parseSemanticReviewHandle(value: unknown, path = "semanticReviewHandle"): SemanticReviewHandle {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.semanticReviewHandle, path);
  assertKeys(object, ["schemaVersion", "reviewAttemptId", "runId", "taskId", "attemptId", "providerSessionId"], path);
  return {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewHandle,
    reviewAttemptId: asReviewId(requiredString(object, "reviewAttemptId", path)),
    runId: asRunId(requiredString(object, "runId", path)),
    taskId: asTaskId(requiredString(object, "taskId", path)),
    attemptId: asAttemptId(requiredString(object, "attemptId", path)),
    ...(object.providerSessionId === undefined ? {} : { providerSessionId: boundedString(object.providerSessionId, `${path}.providerSessionId`, 300) }),
  };
}

export function parseRecoveryDecision(value: unknown, path = "recoveryDecision"): RecoveryDecision {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.recoveryDecision, path);
  assertKeys(object, ["schemaVersion", "runId", "target", "summary", "evidenceRefs"], path);
  const target = object.target;
  if (target !== "EXECUTE" && target !== "VERIFY_FOCUSED" && target !== "REVIEW" && target !== "READY" && target !== "HUMAN_GATE" && target !== "FAILED" && target !== "CANCELLED") {
    throw new ContractValidationError(`${path}.target`, "target is not legal from RECOVERY");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
    runId: asRunId(requiredString(object, "runId", path)),
    target,
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    evidenceRefs: parseIdArray(object.evidenceRefs, `${path}.evidenceRefs`, asArtifactId),
  };
}

export function canonicalJson(value: JsonValue | object): string {
  return JSON.stringify(sortJson(value));
}

export function parseJsonValue(value: unknown, path = "value"): JsonValue {
  return jsonValue(value, path);
}

export function requestHash(value: JsonValue | object): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function parseCommandBase(object: Record<string, unknown>, path: string): CommandBase {
  return {
    schemaVersion: CONTRACT_VERSIONS.command,
    commandId: asCommandId(requiredString(object, "commandId", path)),
    idempotencyKey: boundedString(object.idempotencyKey, `${path}.idempotencyKey`, 200),
    runId: asRunId(requiredString(object, "runId", path)),
    expectedStateVersion: positiveInteger(object.expectedStateVersion, `${path}.expectedStateVersion`, true),
  };
}

function parseFailureClass(value: unknown, path: string): FailureClassification {
  if (!isFailureClassification(value)) {
    throw new ContractValidationError(path, "unknown failure classification");
  }
  return value;
}

function parseValidationLevel(value: unknown, path: string): ValidationLevel {
  if (value !== "focused" && value !== "phase" && value !== "full") {
    throw new ContractValidationError(path, "unknown validation level");
  }
  return value;
}

function parseEnforcement(value: unknown, path: string): EnforcementStrength {
  if (value !== "enforced" && value !== "tool_policy_only" && value !== "unavailable") {
    throw new ContractValidationError(path, "unknown enforcement strength");
  }
  return value;
}

function parseFilesChanged(value: unknown, path: string): ExecutorResult["filesChanged"] {
  return array(value, path).map((entry, index) => {
    const object = record(entry, `${path}[${index}]`);
    assertKeys(object, ["path", "change"], `${path}[${index}]`);
    const change = object.change;
    if (change !== "added" && change !== "modified" && change !== "deleted" && change !== "renamed" && change !== "unknown") {
      throw new ContractValidationError(`${path}[${index}].change`, "unknown file change");
    }
    return { path: boundedString(object.path, `${path}[${index}].path`, 1000), change };
  });
}

function parseChecks(value: unknown, path: string): ValidationCheck[] {
  return array(value, path).map((entry, index) => {
    const object = record(entry, `${path}[${index}]`);
    assertKeys(object, ["name", "outcome", "evidenceClass", "evidenceRefs"], `${path}[${index}]`);
    const outcome = object.outcome;
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped" && outcome !== "not_run" && outcome !== "unknown") {
      throw new ContractValidationError(`${path}[${index}].outcome`, "unknown check outcome");
    }
    return {
      name: boundedString(object.name, `${path}[${index}].name`, 300),
      outcome,
      evidenceClass: parseEvidenceClass(object.evidenceClass, `${path}[${index}].evidenceClass`),
      evidenceRefs: parseIdArray(object.evidenceRefs, `${path}[${index}].evidenceRefs`, asArtifactId),
    };
  });
}

function parseEvidenceArray(value: unknown, path: string): ValidationEvidence[] {
  return array(value, path).map((entry, index) => parseValidationEvidence(entry, `${path}[${index}]`));
}

function parseValidationEvidence(value: unknown, path: string): ValidationEvidence {
  const object = record(value, path);
  assertVersion(object, CONTRACT_VERSIONS.validation, path);
  assertKeys(object, ["schemaVersion", "id", "kind", "classification", "summary", "artifactRef"], path);
  const kind = object.kind;
  if (kind !== "command" && kind !== "diff" && kind !== "check" && kind !== "review" && kind !== "event" && kind !== "result" && kind !== "other") {
    throw new ContractValidationError(`${path}.kind`, "unknown evidence kind");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.validation,
    id: asValidationId(requiredString(object, "id", path)),
    kind,
    classification: parseEvidenceClass(object.classification, `${path}.classification`),
    summary: boundedString(object.summary, `${path}.summary`, 4000),
    ...(object.artifactRef === undefined ? {} : { artifactRef: asArtifactId(requiredString(object, "artifactRef", path)) }),
  };
}

function parseEvidenceClass(value: unknown, path: string): EvidenceClassification {
  if (value !== "automatically_tested" && value !== "manually_validated" && value !== "inspected" && value !== "inferred" && value !== "simulated" && value !== "not_tested") {
    throw new ContractValidationError(path, "unknown evidence classification");
  }
  return value;
}

function parseGateResolution(value: unknown, path: string): HumanGateResolution {
  const object = record(value, path);
  assertKeys(object, ["optionId", "actor", "resolvedAt", "note"], path);
  if (object.actor !== "human") {
    throw new ContractValidationError(`${path}.actor`, "only a human can resolve a gate");
  }
  return {
    optionId: boundedString(object.optionId, `${path}.optionId`, 100),
    actor: "human",
    resolvedAt: boundedString(object.resolvedAt, `${path}.resolvedAt`, 100),
    ...(object.note === undefined ? {} : { note: boundedString(object.note, `${path}.note`, 2000) }),
  };
}

function parseIdArray<T extends string>(value: unknown, path: string, parser: (value: string) => T): T[] {
  return array(value, path).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new ContractValidationError(`${path}[${index}]`, "must be an identifier string");
    }
    return parser(entry);
  });
}

function assertHardInvariants(value: HardInvariants): void {
  const object = record(value, "hardInvariants");
  assertVersion(object, CONTRACT_VERSIONS.config, "hardInvariants");
  if (object.legalTransitions !== true || object.singleActiveExecutor !== true || object.independentEvidence !== true || object.secretsAbsentFromPersistence !== true || object.highImpactHumanGates !== true || object.automaticReleaseActions !== false || object.ambiguousReplay !== false || object.executorCannotVerify !== true || object.maxImplementationAttempts !== 2) {
    throw new ContractValidationError("hardInvariants", "hard invariants cannot be relaxed");
  }
}

function assertProjectPolicy(value: ProjectPolicy): void {
  const object = record(value, "projectPolicy");
  assertVersion(object, CONTRACT_VERSIONS.config, "projectPolicy");
  if (!Array.isArray(object.allowedAdapters) || object.allowedAdapters.length === 0 || object.allowedAdapters.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ContractValidationError("projectPolicy.allowedAdapters", "must contain at least one adapter");
  }
  if (object.maxImplementationAttempts !== 1 && object.maxImplementationAttempts !== 2) {
    throw new ContractValidationError("projectPolicy.maxImplementationAttempts", "must be within the hard retry ceiling");
  }
  parseValidationLevel(object.validationLevel, "projectPolicy.validationLevel");
  if (object.workloadNetwork !== "denied" || object.automaticReleaseActions !== false) {
    throw new ContractValidationError("projectPolicy", "Phase 1 policy cannot enable workload network or automatic release actions");
  }
}

function assertUserPreferences(value: UserPreferences): void {
  const object = record(value, "userPreferences");
  assertVersion(object, CONTRACT_VERSIONS.config, "userPreferences");
  assertKeys(object, ["schemaVersion", "preferredAdapter", "notificationMode"], "userPreferences");
  if (object.preferredAdapter !== undefined) {
    boundedString(object.preferredAdapter, "userPreferences.preferredAdapter", 100);
  }
  if (object.notificationMode !== "quiet" && object.notificationMode !== "normal") {
    throw new ContractValidationError("userPreferences.notificationMode", "unknown notification mode");
  }
}

function assertRunOverride(value: RunOverride): void {
  const object = record(value, "runOverride");
  assertVersion(object, CONTRACT_VERSIONS.config, "runOverride");
  assertKeys(object, ["schemaVersion", "preferredAdapter", "maxImplementationAttempts", "validationLevel"], "runOverride");
  if (object.preferredAdapter !== undefined) {
    boundedString(object.preferredAdapter, "runOverride.preferredAdapter", 100);
  }
  if (object.maxImplementationAttempts !== undefined && object.maxImplementationAttempts !== 1 && object.maxImplementationAttempts !== 2) {
    throw new ContractValidationError("runOverride.maxImplementationAttempts", "must be 1 or 2");
  }
  if (object.validationLevel !== undefined) {
    parseValidationLevel(object.validationLevel, "runOverride.validationLevel");
  }
}

function assertVersion(object: Record<string, unknown>, expected: string, path: string): void {
  if (object.schemaVersion !== expected) {
    throw new ContractValidationError(`${path}.schemaVersion`, `expected ${expected}`);
  }
}

function assertKeys(object: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ContractValidationError(`${path}.${key}`, "unknown field");
    }
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ContractValidationError(path, "must be an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(path, "must be an array");
  }
  return value;
}

function requiredString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new ContractValidationError(`${path}.${key}`, "must be a string");
  }
  return value;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ContractValidationError(path, `must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function boundedStringArray(value: unknown, path: string, maxItems: number, itemMaxLength: number): string[] {
  const values = array(value, path);
  if (values.length > maxItems) {
    throw new ContractValidationError(path, `must contain at most ${maxItems} items`);
  }
  return values.map((entry, index) => boundedString(entry, `${path}[${index}]`, itemMaxLength));
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractValidationError(path, "must be boolean");
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ContractValidationError(path, "must be a safe integer");
  }
  return value;
}

function positiveInteger(value: unknown, path: string, allowZero: boolean): number {
  const parsed = integer(value, path);
  if (allowZero ? parsed < 0 : parsed < 1) {
    throw new ContractValidationError(path, allowZero ? "must be non-negative" : "must be positive");
  }
  return parsed;
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${path}.${key}`)]));
  }
  throw new ContractValidationError(path, "must be JSON data");
}
