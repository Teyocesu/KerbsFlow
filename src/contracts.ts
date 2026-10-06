import { containsLikelySecret, publicFixtureIssue } from "./secrets.js";

import { createHash } from "node:crypto";

export const CONTRACT_VERSIONS = {
  command: "kerbsflow.command/v1",
  commandResult: "kerbsflow.command-result/v1",
  pause: "kerbsflow.pause-contract/v1",
  planningDecision: "kerbsflow.planning-decision/v1",
  steerInstruction: "kerbsflow.steer-instruction/v1",
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
export type InstructionId = BrandedId<"InstructionId">;
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
  instruction: "instruction_",
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

export function asInstructionId(value: string): InstructionId {
  return asId(value, ID_PREFIXES.instruction, "instructionId") as InstructionId;
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

export type CommandKind = "start" | "transition" | "pause" | "resume" | "cancel" | "steer" | "begin_attempt" | "complete_attempt" | "validation" | "review" | "phase" | "gate_resolution" | "recovery";

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

export const STEER_TEXT_MAX_UTF8_BYTES = 4096;
export const CANCEL_REASON_MAX_UTF8_BYTES = 1024;

export interface SteerCommand extends CommandBase {
  kind: "steer";
  text: string;
}

export interface SpecializedCommand extends CommandBase {
  kind: Exclude<CommandKind, "start" | "transition" | "pause" | "resume" | "cancel" | "steer">;
  payload: JsonValue;
}

export type Command = TransitionCommand | StartCommand | PauseCommand | ResumeCommand | CancelCommand | SteerCommand | SpecializedCommand;

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

export interface ReleaseEvidenceCandidate {
  headOid: string;
  baseOid: string;
  fingerprint: string;
}

export interface ReleaseEvidenceCheck {
  outcome: "PASS";
  summary: string;
  evidenceRefs: string[];
}

export interface ReleaseEvidenceDossier {
  schemaVersion: "kerbsflow.release-evidence/v1";
  candidate: ReleaseEvidenceCandidate & {
    sourceBaseline: string; branch: string; clean: true;
    hashes: { source: string; contracts: string; profile: string; migrations: string; package: string; lock: string };
  };
  host: { platform: "darwin"; macOSVersion: string; macOSBuild: string; arch: string; node: string; npm: string; typescript: string; nodeTypes: string; sqlite: string; git: string };
  support: { macOS: "official"; linux: "unsupported_preview"; windows: "unsupported"; license: "Apache-2.0"; copyright: "Teyocesu 2026"; licenseNotice: ReleaseEvidenceCheck };
  adapters: { adapter: "codex" | "opencode"; version: string; provider: string; model: string; identityHash: string; capabilityHash: string; workload: "os_enforced" | "tool_policy_only"; readiness: "tested" | "unavailable" | "not_tested"; summary: string; evidenceRefs: string[] }[];
  evidence: { id: string; classification: EvidenceClassification; boundary: "actual" | "synthetic" | "physical"; origin: "fresh" | "reused"; candidateHead: string; hash: string; summary: string }[];
  acceptance: { id: string; outcome: "PASS"; summary: string; evidenceRefs: string[]; limitations: string[] }[];
  deterministicGate: ReleaseEvidenceCheck & {
    candidateHead: string;
    commands: { command: string; exitCode: 0; outputHash: string; evidenceRefs: string[] }[];
    suites: { discovered: number; executed: number; failures: 0; cancellations: 0; skips: 0; todos: 0; inventoryHash: string };
    boundaries: { sandbox: ReleaseEvidenceCheck; processes: ReleaseEvidenceCheck; worktrees: ReleaseEvidenceCheck; migrations: ReleaseEvidenceCheck; recovery: ReleaseEvidenceCheck };
    integrity: ReleaseEvidenceCheck;
  };
  scenarios: { id: string; adapter: "codex" | "opencode"; outcome: "PASS"; classification: EvidenceClassification; boundary: "actual" | "synthetic" | "physical"; evidenceRefs: string[]; limitations: string[] }[];
  dependencies: ReleaseEvidenceCheck & {
    audit: { status: "complete" | "unavailable"; advisories: number | null; evidenceRefs: string[]; riskDispositionRefs: string[] };
    licenses: ReleaseEvidenceCheck; provenance: ReleaseEvidenceCheck; packageSurface: ReleaseEvidenceCheck;
  };
  secrets: { scan: ReleaseEvidenceCheck; provenanceInspection: ReleaseEvidenceCheck };
  reviewHistory: { broad: ReleaseEvidenceCheck; remediation: ReleaseEvidenceCheck; postFix: ReleaseEvidenceCheck; knownBlockers: 0 };
  liveProvider: { status: "not_tested" | "tested" | "unavailable"; reason: string; evidenceRefs: string[] };
  limitations: string[];
  prohibitedActions: string[];
}

export const RELEASE_EVIDENCE_MAX_BYTES = 96 * 1024;
export const RELEASE_PROHIBITED_ACTIONS = ["commit", "push", "merge", "tag", "release", "publish", "deploy", "production"] as const;
export const RELEASE_REQUIRED_LIMITATIONS = [
  "Same-user filesystem path swaps remain a residual risk",
  "macOS Seatbelt is deprecated and required; unavailable enforcement fails closed",
  "OpenCode workload isolation is tool_policy_only, not OS enforcement",
  "Linux is unsupported preview; Windows is unsupported",
] as const;

// Only trusted host composition calls this parser; API/model contracts do not carry a dossier.
export function parseReleaseEvidenceDossier(value: unknown): ReleaseEvidenceDossier {
  const fail = (): never => { throw new ContractValidationError("releaseEvidence", "invalid, incomplete, unsafe or oversized release dossier"); };
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return fail(); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > RELEASE_EVIDENCE_MAX_BYTES || containsLikelySecret(value)) return fail();
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!isRecord(v) || Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) return fail();
    return v;
  };
  const text = (v: unknown, max = 1024): string => {
    if (typeof v !== "string" || !v.trim() || v !== v.trim() || Buffer.byteLength(v) > max || /[\x00-\x1f\x7f]/u.test(v)
      || /file:\/\/|(?:^|[^\p{L}\p{N}_.\/\\])(?:\/|\\\\|[A-Za-z]:[\\/])/iu.test(v) || publicFixtureIssue(v) !== undefined) return fail();
    return v;
  };
  const hash = (v: unknown, length = 64): string => { if (typeof v !== "string" || !(new RegExp(`^[a-f0-9]{${length}}$`, "u")).test(v)) return fail(); return v; };
  const choice = <T extends string>(v: unknown, allowed: readonly T[]): T => { if (typeof v !== "string" || !allowed.includes(v as T)) return fail(); return v as T; };
  const list = <T>(v: unknown, max: number, parse: (entry: unknown) => T, min = 0): T[] => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return fail();
    return Array.from(v, parse);
  };
  const unique = (values: string[]): string[] => { if (new Set(values).size !== values.length) return fail(); return values; };
  const notes = (v: unknown): string[] => list(v, 24, entry => text(entry));
  const count = (v: unknown, minimum = 0): number => { if (!Number.isSafeInteger(v) || typeof v !== "number" || v < minimum || v > 100000) return fail(); return v; };
  const zero = (v: unknown): 0 => { if (v !== 0) return fail(); return 0; };
  const pass = (v: unknown): "PASS" => choice(v, ["PASS"]);
  const id = (v: unknown): string => { const s = text(v, 80); if (!/^evidence_[A-Za-z0-9_-]+$/u.test(s)) return fail(); return s; };
  const d = object(value, ["schemaVersion", "candidate", "host", "support", "adapters", "evidence", "acceptance", "deterministicGate", "scenarios", "dependencies", "secrets", "reviewHistory", "liveProvider", "limitations", "prohibitedActions"]);
  const c = object(d.candidate, ["headOid", "baseOid", "fingerprint", "sourceBaseline", "branch", "clean", "hashes"]);
  const h = object(c.hashes, ["source", "contracts", "profile", "migrations", "package", "lock"]);
  if (c.clean !== true) return fail();
  const candidate: ReleaseEvidenceDossier["candidate"] = { headOid: hash(c.headOid, 40), baseOid: hash(c.baseOid, 40), fingerprint: hash(c.fingerprint), sourceBaseline: hash(c.sourceBaseline, 40), branch: text(c.branch, 256), clean: true,
    hashes: { source: hash(h.source), contracts: hash(h.contracts), profile: hash(h.profile), migrations: hash(h.migrations), package: hash(h.package), lock: hash(h.lock) } };
  const evidence = list(d.evidence, 256, v => {
    const e = object(v, ["id", "classification", "boundary", "origin", "candidateHead", "hash", "summary"]);
    const item = { id: id(e.id), classification: parseEvidenceClass(e.classification, "releaseEvidence.classification"), boundary: choice(e.boundary, ["actual", "synthetic", "physical"]), origin: choice(e.origin, ["fresh", "reused"]), candidateHead: hash(e.candidateHead, 40), hash: hash(e.hash), summary: text(e.summary) };
    if (item.origin === "fresh" && item.candidateHead !== candidate.headOid) return fail();
    return item;
  }, 1);
  unique(evidence.map(e => e.id));
  evidence.sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(evidence.map(e => [e.id, e]));
  const refs = (v: unknown, min = 1): string[] => {
    const result = unique(list(v, 32, id, min));
    if (result.some(ref => !byId.has(ref))) return fail();
    return result.sort();
  };
  const provenRefs = (v: unknown): string[] => {
    const result = refs(v);
    if (result.some(ref => byId.get(ref)!.classification === "not_tested") || result.every(ref => byId.get(ref)!.classification === "inferred")) return fail();
    return result;
  };
  const check = (v: unknown): ReleaseEvidenceCheck => {
    const o = object(v, ["outcome", "summary", "evidenceRefs"]);
    return { outcome: pass(o.outcome), summary: text(o.summary), evidenceRefs: provenRefs(o.evidenceRefs) };
  };
  const hostObject = object(d.host, ["platform", "macOSVersion", "macOSBuild", "arch", "node", "npm", "typescript", "nodeTypes", "sqlite", "git"]);
  const host: ReleaseEvidenceDossier["host"] = { platform: choice(hostObject.platform, ["darwin"]), macOSVersion: text(hostObject.macOSVersion, 80), macOSBuild: text(hostObject.macOSBuild, 80), arch: text(hostObject.arch, 80), node: text(hostObject.node, 80), npm: text(hostObject.npm, 80), typescript: text(hostObject.typescript, 80), nodeTypes: text(hostObject.nodeTypes, 80), sqlite: text(hostObject.sqlite, 80), git: text(hostObject.git, 128) };
  const s = object(d.support, ["macOS", "linux", "windows", "license", "copyright", "licenseNotice"]);
  const support: ReleaseEvidenceDossier["support"] = { macOS: choice(s.macOS, ["official"]), linux: choice(s.linux, ["unsupported_preview"]), windows: choice(s.windows, ["unsupported"]), license: choice(s.license, ["Apache-2.0"]), copyright: choice(s.copyright, ["Teyocesu 2026"]), licenseNotice: check(s.licenseNotice) };
  const adapters = list(d.adapters, 2, v => {
    const a = object(v, ["adapter", "version", "provider", "model", "identityHash", "capabilityHash", "workload", "readiness", "summary", "evidenceRefs"]);
    const result = { adapter: choice(a.adapter, ["codex", "opencode"]), version: text(a.version, 128), provider: text(a.provider, 128), model: text(a.model, 128), identityHash: hash(a.identityHash), capabilityHash: hash(a.capabilityHash), workload: choice(a.workload, ["os_enforced", "tool_policy_only"]), readiness: choice(a.readiness, ["tested", "unavailable", "not_tested"]), summary: text(a.summary), evidenceRefs: refs(a.evidenceRefs) };
    if (result.adapter === "opencode" && result.workload !== "tool_policy_only") return fail();
    if (result.readiness === "tested") provenRefs(result.evidenceRefs);
    return result;
  }, 2);
  unique(adapters.map(a => a.adapter));
  adapters.sort((a, b) => a.adapter.localeCompare(b.adapter));
  const acceptance = list(d.acceptance, 15, v => {
    const a = object(v, ["id", "outcome", "summary", "evidenceRefs", "limitations"]);
    return { id: choice(a.id, Array.from({ length: 15 }, (_, i) => `AC${i + 1}`)), outcome: pass(a.outcome), summary: text(a.summary), evidenceRefs: provenRefs(a.evidenceRefs), limitations: notes(a.limitations) };
  }, 15);
  unique(acceptance.map(a => a.id));
  acceptance.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  const g = object(d.deterministicGate, ["outcome", "summary", "evidenceRefs", "candidateHead", "commands", "suites", "boundaries", "integrity"]);
  const suite = object(g.suites, ["discovered", "executed", "failures", "cancellations", "skips", "todos", "inventoryHash"]);
  const boundaries = object(g.boundaries, ["sandbox", "processes", "worktrees", "migrations", "recovery"]);
  const deterministicGate: ReleaseEvidenceDossier["deterministicGate"] = {
    outcome: pass(g.outcome), summary: text(g.summary), evidenceRefs: provenRefs(g.evidenceRefs), candidateHead: hash(g.candidateHead, 40),
    commands: list(g.commands, 16, v => { const o = object(v, ["command", "exitCode", "outputHash", "evidenceRefs"]); return { command: text(o.command, 256), exitCode: zero(o.exitCode), outputHash: hash(o.outputHash), evidenceRefs: provenRefs(o.evidenceRefs) }; }, 1),
    suites: { discovered: count(suite.discovered, 1), executed: count(suite.executed, 1), failures: zero(suite.failures), cancellations: zero(suite.cancellations), skips: zero(suite.skips), todos: zero(suite.todos), inventoryHash: hash(suite.inventoryHash) },
    boundaries: { sandbox: check(boundaries.sandbox), processes: check(boundaries.processes), worktrees: check(boundaries.worktrees), migrations: check(boundaries.migrations), recovery: check(boundaries.recovery) }, integrity: check(g.integrity),
  };
  const actualFresh = (ref: string): boolean => { const item = byId.get(ref)!; return item.classification === "automatically_tested" && item.boundary === "actual" && item.origin === "fresh" && item.candidateHead === candidate.headOid; };
  if (deterministicGate.candidateHead !== candidate.headOid || deterministicGate.suites.discovered !== deterministicGate.suites.executed
    || !deterministicGate.commands.some(cmd => cmd.command === "npm test") || !deterministicGate.commands.some(cmd => cmd.command === "npm run typecheck")
    || Object.values(deterministicGate.boundaries).some(boundary => !boundary.evidenceRefs.some(actualFresh))
    || !deterministicGate.integrity.evidenceRefs.some(actualFresh)
    || deterministicGate.commands.some(cmd => !cmd.evidenceRefs.some(ref => actualFresh(ref) && byId.get(ref)!.hash === cmd.outputHash))
    || !deterministicGate.evidenceRefs.some(actualFresh)
    || !deterministicGate.commands.some(cmd => cmd.command === "npm test" && cmd.evidenceRefs.some(ref =>
      acceptance[14]!.evidenceRefs.includes(ref) && actualFresh(ref) && byId.get(ref)!.hash === cmd.outputHash))) return fail();
  const scenarios = list(d.scenarios, 26, v => {
    const x = object(v, ["id", "adapter", "outcome", "classification", "boundary", "evidenceRefs", "limitations"]);
    const result = { id: choice(x.id, Array.from({ length: 13 }, (_, i) => `X${i + 1}`)), adapter: choice(x.adapter, ["codex", "opencode"]), outcome: pass(x.outcome), classification: parseEvidenceClass(x.classification, "releaseEvidence.classification"), boundary: choice(x.boundary, ["actual", "synthetic", "physical"]), evidenceRefs: provenRefs(x.evidenceRefs), limitations: notes(x.limitations) };
    if (result.classification === "not_tested" || result.classification === "inferred" || !result.evidenceRefs.some(ref => byId.get(ref)!.classification === result.classification && byId.get(ref)!.boundary === result.boundary)) return fail();
    return result;
  }, 26);
  unique(scenarios.map(x => `${x.id}:${x.adapter}`));
  scenarios.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.adapter.localeCompare(b.adapter));
  const dep = object(d.dependencies, ["outcome", "summary", "evidenceRefs", "audit", "licenses", "provenance", "packageSurface"]);
  const au = object(dep.audit, ["status", "advisories", "evidenceRefs", "riskDispositionRefs"]);
  const audit: ReleaseEvidenceDossier["dependencies"]["audit"] = { status: choice(au.status, ["complete", "unavailable"]), advisories: au.advisories === null ? null : count(au.advisories), evidenceRefs: refs(au.evidenceRefs), riskDispositionRefs: refs(au.riskDispositionRefs, 0) };
  if ((audit.status === "unavailable" && audit.advisories !== null) || (audit.status === "complete" && audit.advisories === null)
    || ((audit.status === "unavailable" || audit.advisories !== 0) && !audit.riskDispositionRefs.some(ref => byId.get(ref)!.classification === "manually_validated"))) return fail();
  if (audit.status === "complete") provenRefs(audit.evidenceRefs);
  const secret = object(d.secrets, ["scan", "provenanceInspection"]);
  const review = object(d.reviewHistory, ["broad", "remediation", "postFix", "knownBlockers"]);
  const live = object(d.liveProvider, ["status", "reason", "evidenceRefs"]);
  const limitations = notes(d.limitations);
  if (RELEASE_REQUIRED_LIMITATIONS.some(note => !limitations.includes(note))) return fail();
  const prohibitedActions = unique(list(d.prohibitedActions, 8, v => choice(v, RELEASE_PROHIBITED_ACTIONS), 8)).sort();
  const parsed: ReleaseEvidenceDossier = {
    schemaVersion: choice(d.schemaVersion, ["kerbsflow.release-evidence/v1"]), candidate, host, support, adapters, evidence, acceptance, deterministicGate, scenarios,
    dependencies: { outcome: pass(dep.outcome), summary: text(dep.summary), evidenceRefs: provenRefs(dep.evidenceRefs), audit, licenses: check(dep.licenses), provenance: check(dep.provenance), packageSurface: check(dep.packageSurface) },
    secrets: { scan: check(secret.scan), provenanceInspection: check(secret.provenanceInspection) },
    reviewHistory: { broad: check(review.broad), remediation: check(review.remediation), postFix: check(review.postFix), knownBlockers: zero(review.knownBlockers) },
    liveProvider: { status: choice(live.status, ["not_tested", "tested", "unavailable"]), reason: text(live.reason), evidenceRefs: live.status === "tested" ? provenRefs(live.evidenceRefs) : refs(live.evidenceRefs, 0) }, limitations, prohibitedActions,
  };
  return freezeReleaseEvidence(parsed);
}

function freezeReleaseEvidence<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeReleaseEvidence(nested);
    Object.freeze(value);
  }
  return value;
}

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
  evidenceIds?: ValidationId[];
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

  const allowedAdapters = [...layers.projectPolicy.allowedAdapters];
  Object.freeze(allowedAdapters);
  return Object.freeze({
    hardInvariants: Object.freeze({ ...layers.hardInvariants }),
    projectPolicy: Object.freeze({ ...layers.projectPolicy, allowedAdapters }),
    userPreferences: Object.freeze({ ...layers.userPreferences }),
    runOverride: Object.freeze({ ...layers.runOverride }),
    effectiveAdapter: requestedAdapter ?? layers.projectPolicy.allowedAdapters[0]!,
    effectiveMaxImplementationAttempts: maxAttempts,
    effectiveValidationLevel: validationLevel,
  });
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
      return { ...base, kind, reason: parseCancelReason(object.reason, `${path}.reason`) };
    case "steer":
      assertKeys(object, ["schemaVersion", "commandId", "idempotencyKey", "runId", "expectedStateVersion", "kind", "text"], path);
      return { ...base, kind, text: parseSteerText(object.text, `${path}.text`) };
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
    assertKeys(object, ["name", "outcome", "evidenceClass", "evidenceRefs", "evidenceIds"], `${path}[${index}]`);
    const outcome = object.outcome;
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped" && outcome !== "not_run" && outcome !== "unknown") {
      throw new ContractValidationError(`${path}[${index}].outcome`, "unknown check outcome");
    }
    return {
      name: boundedString(object.name, `${path}[${index}].name`, 300),
      outcome,
      evidenceClass: parseEvidenceClass(object.evidenceClass, `${path}[${index}].evidenceClass`),
      evidenceRefs: parseIdArray(object.evidenceRefs, `${path}[${index}].evidenceRefs`, asArtifactId),
      ...(object.evidenceIds === undefined ? {} : { evidenceIds: parseIdArray(object.evidenceIds, `${path}[${index}].evidenceIds`, asValidationId) }),
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

export function parseSteerText(value: unknown, path = "text"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError(path, "must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > STEER_TEXT_MAX_UTF8_BYTES) {
    throw new ContractValidationError(path, `must be at most ${STEER_TEXT_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  return value;
}

export function parseCancelReason(value: unknown, path = "reason"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError(path, "must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > CANCEL_REASON_MAX_UTF8_BYTES) {
    throw new ContractValidationError(path, `must be at most ${CANCEL_REASON_MAX_UTF8_BYTES} UTF-8 bytes`);
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
