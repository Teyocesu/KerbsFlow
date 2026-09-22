import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSIONS,
  Command,
  CommandResult,
  IdPrefix,
  JsonValue,
  PauseContract,
  PlanningDecision,
  RunId,
  RunState,
  TaskId,
  AttemptId,
  GateId,
  TransitionId,
  ValidationBundle,
  ValidationId,
  HumanGate,
  ReviewDecision,
  ReviewId,
  SemanticReviewRequest,
  SemanticReviewResult,
  AttemptLifecycle,
  asAttemptId,
  asCommandId,
  asGateId,
  asRunId,
  asTaskId,
  asTransitionId,
  asValidationId,
  canonicalJson,
  parseHumanGate,
  parseAdapterDescriptor,
  parseCommand,
  parseCommandResult,
  parsePauseContract,
  parsePlanningDecision,
  parseReviewDecision,
  parseSemanticReviewRequest,
  parseSemanticReviewResult,
  parseRunState,
  parseValidationBundle,
  requestHash,
} from "./contracts.js";
import { Clock, IdSource, RandomIdSource, SystemClock } from "./runtime.js";
import { assertLegalTransition } from "./state-machine.js";
import { DatabaseIntegrityError, IdempotencyConflictError, KerbsFlowError, NotFoundError, StateVersionConflictError } from "./errors.js";
import { containsLikelySecret, SENSITIVE_RESULT_REJECTION } from "./secrets.js";
import { assertAuthoritativePhaseValidation, type AuthoritativePhaseValidation, type PhaseValidationBinding } from "./verifier.js";
import { assertReviewDispatchAuthority, type ReviewDispatchAuthority } from "./reviewer.js";
import {
  assertAttemptRoutingBinding,
  assertAttemptRoutingProvenance,
  assertRoutingDecision,
  assertTrustedAttemptRoutingProvenance,
  assertTrustedRoutingDecision,
  type AttemptRoutingProvenance,
  type RoutingDecision,
  type TrustedAttemptRoutingProvenance,
  type TrustedRoutingDecision,
} from "./routing.js";

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlTransaction {
  run(sql: string, ...parameters: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): T | undefined;
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): T[];
  exec(sql: string): void;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase1-foundation",
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL CHECK (state_version >= 0),
        current_task_id TEXT,
        active_attempt_id TEXT,
        current_gate_id TEXT,
        pause_contract_json TEXT,
        pause_contract_hash TEXT,
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
        recovery_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        status TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        lifecycle TEXT NOT NULL,
        adapter_descriptor_json TEXT,
        provider_identity_json TEXT,
        outcome_json TEXT,
        failure_class TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE transitions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        transition_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        actor TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        gate_id TEXT,
        state_version_before INTEGER NOT NULL,
        state_version_after INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE commands (
        idempotency_key TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        transition_id TEXT,
        state_version_before INTEGER NOT NULL,
        state_version_after INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        attempt_id TEXT,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        redaction_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE validations (
        validation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        attempt_id TEXT,
        level TEXT NOT NULL,
        outcome TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE reviews (
        review_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        outcome TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE human_gates (
        gate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT,
        attempt_id TEXT,
        status TEXT NOT NULL,
        gate_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;

      CREATE INDEX attempts_run_lifecycle_idx ON attempts(run_id, lifecycle);
      CREATE INDEX transitions_run_sequence_idx ON transitions(run_id, sequence);
      CREATE INDEX validations_run_created_idx ON validations(run_id, created_at);
      CREATE INDEX reviews_run_created_idx ON reviews(run_id, created_at);
    `,
  },
  {
    version: 2,
    name: "phase2-real-execution",
    sql: `
      CREATE TABLE worktrees (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        repository_path TEXT NOT NULL,
        git_common_directory TEXT NOT NULL,
        worktree_git_directory TEXT NOT NULL,
        base_oid TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        marker_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE cancellation_intents (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        request_command_id TEXT NOT NULL,
        adapter_outcome_json TEXT,
        reconciliation_json TEXT,
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      ) STRICT;

      CREATE INDEX cancellation_intents_run_idx ON cancellation_intents(run_id, status);
    `,
  },
  {
    version: 3,
    name: "phase3-verification-recovery",
    sql: `
      CREATE TABLE semantic_review_attempts (
        review_attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
        lifecycle TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        provider_identity_json TEXT,
        result_json TEXT,
        failure_summary TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE failure_occurrences (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        attempt_id TEXT REFERENCES attempts(attempt_id),
        fingerprint TEXT NOT NULL,
        occurrence INTEGER NOT NULL CHECK (occurrence > 0),
        failure_class TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        route_json TEXT NOT NULL,
        resulting_action TEXT NOT NULL,
        escalation_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, task_id, fingerprint, occurrence)
      ) STRICT;

      CREATE TABLE canonical_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        repository_path TEXT NOT NULL,
        base_oid TEXT NOT NULL,
        hashes_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE phase_boundaries (
        boundary_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        status TEXT NOT NULL,
        expected_hashes_json TEXT NOT NULL,
        observed_hashes_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX semantic_reviews_run_lifecycle_idx ON semantic_review_attempts(run_id, lifecycle);
      CREATE INDEX failure_occurrences_fingerprint_idx ON failure_occurrences(run_id, task_id, fingerprint, occurrence);
      CREATE UNIQUE INDEX failure_occurrences_attempt_fingerprint_idx ON failure_occurrences(run_id, task_id, attempt_id, fingerprint) WHERE attempt_id IS NOT NULL;
      CREATE INDEX phase_boundaries_run_status_idx ON phase_boundaries(run_id, status);
    `,
  },
  {
    version: 4,
    name: "phase3-review-context-redaction",
    sql: `
      ALTER TABLE semantic_review_attempts ADD COLUMN stored_request_hash TEXT;
    `,
  },
  {
    version: 5,
    name: "phase3-authoritative-validation",
    sql: `
      CREATE TABLE phase_validation_authority (
        validation_id TEXT PRIMARY KEY REFERENCES validations(validation_id),
        worktree_path TEXT NOT NULL,
        worktree_git_directory TEXT NOT NULL,
        base_oid TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        changed_paths_hash TEXT NOT NULL,
        changed_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "phase3-phase-command-authority",
    sql: `
      ALTER TABLE phase_validation_authority ADD COLUMN command_id TEXT NOT NULL DEFAULT 'legacy_unbound';
      ALTER TABLE phase_validation_authority ADD COLUMN command_hash TEXT NOT NULL DEFAULT 'legacy_unbound';
    `,
  },
  {
    version: 7,
    name: "phase4-routing-decisions",
    sql: `
      CREATE TABLE routing_decisions (
        planning_decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        attempt_id TEXT REFERENCES attempts(attempt_id),
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX routing_decisions_run_task_idx ON routing_decisions(run_id, task_id);
      CREATE UNIQUE INDEX routing_decisions_attempt_idx ON routing_decisions(attempt_id) WHERE attempt_id IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: "phase4-attempt-routing-provenance",
    sql: `
      CREATE TABLE attempt_routing_provenance (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
        planning_decision_id TEXT NOT NULL REFERENCES routing_decisions(planning_decision_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        capability_snapshot_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX attempt_routing_provenance_run_task_idx ON attempt_routing_provenance(run_id, task_id);
    `,
  },
];

export type SemanticReviewLifecycle = "PREPARED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface StoredSemanticReviewAttempt {
  reviewAttemptId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  lifecycle: SemanticReviewLifecycle;
  request: SemanticReviewRequest;
  requestHash: string;
  providerIdentityJson: string | null;
  result: SemanticReviewResult | null;
  failureSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface StoredFailureOccurrence {
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId | null;
  fingerprint: string;
  occurrence: number;
  failureClass: string;
  reasonCode: string;
  normalizedJson: string;
  routeJson: string;
  resultingAction: string;
  escalationReason: string | null;
  createdAt: string;
}

export interface StoredCanonicalSnapshot {
  runId: RunId;
  repositoryPath: string;
  baseOid: string;
  hashes: Record<string, string>;
  capturedAt: string;
}

export interface StoredPhaseBoundary {
  boundaryId: string;
  runId: RunId;
  status: "PREPARED" | "APPLIED";
  expectedHashes: Record<string, string>;
  observedHashes: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredWorktree {
  runId: RunId;
  repositoryPath: string;
  gitCommonDirectory: string;
  worktreeGitDirectory: string;
  baseOid: string;
  branch: string;
  worktreePath: string;
  markerPath: string;
  createdAt: string;
}

export interface StoredCancellationIntent {
  attemptId: AttemptId;
  runId: RunId;
  reason: string;
  status: "REQUESTED" | "SIGNAL_PENDING" | "SIGNALLED" | "CANCELLED" | "UNCERTAIN";
  requestCommandId: string;
  adapterOutcomeJson: string | null;
  reconciliationJson: string | null;
  requestedAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface StoredRoutingDecision {
  decision: RoutingDecision;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAttemptRoutingProvenance {
  provenance: AttemptRoutingProvenance;
  createdAt: string;
}

export interface StoredRun {
  runId: RunId;
  objective: string;
  state: RunState;
  stateVersion: number;
  currentTaskId: TaskId | null;
  activeAttemptId: AttemptId | null;
  currentGateId: GateId | null;
  pauseContract: PauseContract | null;
  pauseContractHash: string | null;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTask {
  taskId: TaskId;
  runId: RunId;
  status: string;
  decision: PlanningDecision;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAttempt {
  attemptId: AttemptId;
  runId: RunId;
  taskId: TaskId;
  lifecycle: AttemptLifecycle;
  adapterDescriptorJson: string | null;
  providerIdentityJson: string | null;
  outcomeJson: string | null;
  failureClass: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTransition {
  sequence: number;
  transitionId: TransitionId;
  runId: RunId;
  from: RunState;
  to: RunState;
  reasonCode: string;
  actor: string;
  commandId: string;
  idempotencyKey: string;
  taskId: TaskId | null;
  attemptId: AttemptId | null;
  gateId: GateId | null;
  stateVersionBefore: number;
  stateVersionAfter: number;
  payloadJson: string;
  createdAt: string;
}

export interface StoredValidation {
  validationId: string;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId | null;
  level: string;
  outcome: string;
  bundle: ValidationBundle;
  createdAt: string;
}

export interface StoredPhaseValidationAuthority extends PhaseValidationBinding {
  validationId: ValidationId;
  createdAt: string;
}

export interface StoredReview {
  reviewId: string;
  runId: RunId;
  taskId: TaskId;
  outcome: string;
  decision: ReviewDecision;
  createdAt: string;
}

export interface StoredGate {
  gateId: GateId;
  runId: RunId;
  taskId: TaskId | null;
  attemptId: AttemptId | null;
  status: string;
  gate: HumanGate;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReadModel {
  run: StoredRun;
  currentTask?: StoredTask;
  activeAttempt?: StoredAttempt;
  lastTransition?: StoredTransition;
  currentGate?: StoredGate;
  latestValidation?: StoredValidation;
  latestReview?: StoredReview;
}

export interface RecoveryNotice {
  runId: RunId;
  previousState: RunState;
  currentState: RunState;
  activeAttemptId: AttemptId | null;
  reason: string;
  automaticTransition: boolean;
}

export interface RunPatch {
  currentTaskId?: TaskId | null;
  activeAttemptId?: AttemptId | null;
  currentGateId?: GateId | null;
  pauseContract?: PauseContract | null;
  recoveryRequired?: boolean;
  recoveryReason?: string | null;
}

export interface TransitionDraft {
  to: RunState;
  reasonCode: string;
  actor: "human" | "core" | "planner" | "adapter" | "verifier" | "recovery";
  payload?: JsonValue;
  taskId?: TaskId | null;
  attemptId?: AttemptId | null;
  gateId?: GateId | null;
}

export interface CommandMutation {
  transition?: TransitionDraft;
  runPatch?: RunPatch;
  details?: JsonValue;
}

export interface CommandMutationContext {
  readonly tx: SqlTransaction;
  readonly run: StoredRun;
  readonly now: string;
  nextId(prefix: IdPrefix): string;
}

export interface StateStoreOptions {
  clock?: Clock;
  ids?: IdSource;
  migrations?: readonly Migration[];
  busyTimeoutMs?: number;
}

export class StateStore {
  readonly databasePath: string;
  readonly startupRecovery: readonly RecoveryNotice[];

  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private closed = false;
  private readonly recoveryNotices: RecoveryNotice[] = [];

  private constructor(databasePath: string, db: DatabaseSync, clock: Clock, ids: IdSource) {
    this.databasePath = databasePath;
    this.db = db;
    this.clock = clock;
    this.ids = ids;
    this.startupRecovery = this.recoveryNotices;
  }

  static open(databasePath: string, options: StateStoreOptions = {}): StateStore {
    const clock = options.clock ?? new SystemClock();
    const ids = options.ids ?? new RandomIdSource();
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
    try {
      configureDatabase(db, busyTimeoutMs);
      applyMigrations(db, options.migrations ?? MIGRATIONS, clock);
      sanitizePersistedSemanticReviewContext(db);
      assertIntegrity(db);
      const store = new StateStore(databasePath, db, clock, ids);
      store.detectStartupRecovery();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  getRun(runId: RunId): StoredRun | undefined {
    this.assertOpen();
    return this.readRun(this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row | undefined);
  }

  getTask(taskId: TaskId): StoredTask | undefined {
    this.assertOpen();
    return this.readTask(this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row | undefined);
  }

  getAttempt(attemptId: AttemptId): StoredAttempt | undefined {
    this.assertOpen();
    return this.readAttempt(this.db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) as Row | undefined);
  }

  getGate(gateId: GateId): StoredGate | undefined {
    this.assertOpen();
    return this.readGate(this.db.prepare("SELECT * FROM human_gates WHERE gate_id = ?").get(gateId) as Row | undefined);
  }

  getWorktree(runId: RunId): StoredWorktree | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM worktrees WHERE run_id = ?").get(runId) as Row | undefined;
    return row === undefined ? undefined : parseWorktreeRow(row);
  }

  getValidation(validationId: ValidationId): StoredValidation | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM validations WHERE validation_id = ?").get(validationId) as Row | undefined;
    return row === undefined ? undefined : parseValidationRow(row);
  }

  getPhaseValidationAuthority(validationId: ValidationId): StoredPhaseValidationAuthority | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM phase_validation_authority WHERE validation_id = ?").get(validationId) as Row | undefined;
    return row === undefined ? undefined : parsePhaseValidationAuthorityRow(row);
  }

  getRoutingDecision(planningDecisionId: string): StoredRoutingDecision | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM routing_decisions WHERE planning_decision_id = ?").get(planningDecisionId) as Row | undefined;
    return row === undefined ? undefined : parseRoutingDecisionRow(row);
  }

  recordRoutingDecision(value: TrustedRoutingDecision): StoredRoutingDecision {
    this.assertOpen();
    if (containsLikelySecret(value)) {
      throw new KerbsFlowError("ROUTING_METADATA_SECRET_REJECTED", SENSITIVE_RESULT_REJECTION);
    }
    const decision = assertTrustedRoutingDecision(value);
    return this.withTransaction((tx) => {
      const task = tx.get("SELECT run_id, decision_json FROM tasks WHERE task_id = ?", decision.taskId) as Row | undefined;
      if (task?.run_id !== decision.runId) {
        throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "routing decision does not match a persisted run/task");
      }
      const planning = parsePlanningDecision(JSON.parse(stringValue(task.decision_json, "tasks.decision_json")));
      if (planning.decisionId !== decision.planningDecisionId || planning.route.adapter !== decision.selected.adapter || planning.route.model !== decision.selected.model || planning.route.reasoning !== decision.selected.reasoning) {
        throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "routing metadata does not match the persisted planning decision route");
      }
      const existing = tx.get("SELECT * FROM routing_decisions WHERE planning_decision_id = ?", decision.planningDecisionId) as Row | undefined;
      if (existing !== undefined) {
        const stored = parseRoutingDecisionRow(existing);
        if (canonicalJson(stored.decision) !== canonicalJson(decision)) {
          throw new KerbsFlowError("ROUTING_DECISION_CONFLICT", `planning decision ${decision.planningDecisionId} already has different routing metadata`);
        }
        return stored;
      }
      const now = this.clock.now();
      tx.run(
        "INSERT INTO routing_decisions (planning_decision_id, run_id, task_id, attempt_id, decision_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        decision.planningDecisionId,
        decision.runId,
        decision.taskId,
        null,
        JSON.stringify(decision),
        now,
        now,
      );
      return parseRoutingDecisionRow(tx.get("SELECT * FROM routing_decisions WHERE planning_decision_id = ?", decision.planningDecisionId)!);
    });
  }

  getAttemptRoutingProvenance(attemptId: AttemptId): StoredAttemptRoutingProvenance | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM attempt_routing_provenance WHERE attempt_id = ?").get(attemptId) as Row | undefined;
    return row === undefined ? undefined : parseAttemptRoutingProvenanceRow(row);
  }

  listAttemptRoutingProvenance(runId: RunId, taskId: TaskId): StoredAttemptRoutingProvenance[] {
    this.assertOpen();
    return (this.db.prepare("SELECT * FROM attempt_routing_provenance WHERE run_id = ? AND task_id = ? ORDER BY rowid").all(runId, taskId) as Row[]).map(parseAttemptRoutingProvenanceRow);
  }

  recordAttemptRoutingProvenance(value: TrustedAttemptRoutingProvenance): StoredAttemptRoutingProvenance {
    this.assertOpen();
    if (containsLikelySecret(value)) throw new KerbsFlowError("ROUTING_METADATA_SECRET_REJECTED", SENSITIVE_RESULT_REJECTION);
    const provenance = assertTrustedAttemptRoutingProvenance(value);
    return this.withTransaction((tx) => {
      const attempt = tx.get("SELECT run_id, task_id, adapter_descriptor_json FROM attempts WHERE attempt_id = ?", provenance.attemptId) as Row | undefined;
      if (attempt?.run_id !== provenance.runId || attempt.task_id !== provenance.taskId) {
        throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "attempt routing provenance does not match the persisted attempt run/task");
      }
      const descriptorJson = nullableString(attempt.adapter_descriptor_json, "attempts.adapter_descriptor_json");
      if (descriptorJson === null) throw new KerbsFlowError("ROUTING_CAPABILITY_MISMATCH", "prepared attempt has no adapter descriptor");
      const descriptor = parseAdapterDescriptorForRouting(descriptorJson);
      const task = tx.get("SELECT decision_json FROM tasks WHERE task_id = ?", provenance.taskId) as Row | undefined;
      if (task === undefined) throw new NotFoundError("task", provenance.taskId);
      const planning = parsePlanningDecision(JSON.parse(stringValue(task.decision_json, "tasks.decision_json")));
      const routing = tx.get("SELECT decision_json FROM routing_decisions WHERE planning_decision_id = ?", provenance.planningDecisionId) as Row | undefined;
      if (routing === undefined) throw new NotFoundError("routing decision", provenance.planningDecisionId);
      const decision = assertRoutingDecision(JSON.parse(stringValue(routing.decision_json, "routing_decisions.decision_json")) as RoutingDecision);
      assertAttemptRoutingBinding({ provenance, routingDecision: decision, planningDecision: planning, preparedDescriptor: descriptor, attemptId: provenance.attemptId });
      const existing = tx.get("SELECT * FROM attempt_routing_provenance WHERE attempt_id = ?", provenance.attemptId) as Row | undefined;
      if (existing !== undefined) {
        const stored = parseAttemptRoutingProvenanceRow(existing);
        if (canonicalJson(stored.provenance) !== canonicalJson(provenance)) throw new KerbsFlowError("ROUTING_ATTEMPT_CONFLICT", `attempt ${provenance.attemptId} already has different routing provenance`);
        return stored;
      }
      const now = this.clock.now();
      tx.run(
        "INSERT INTO attempt_routing_provenance (attempt_id, planning_decision_id, run_id, task_id, capability_snapshot_hash, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        provenance.attemptId,
        provenance.planningDecisionId,
        provenance.runId,
        provenance.taskId,
        provenance.capabilitySnapshotHash,
        JSON.stringify(provenance),
        now,
      );
      return parseAttemptRoutingProvenanceRow(tx.get("SELECT * FROM attempt_routing_provenance WHERE attempt_id = ?", provenance.attemptId)!);
    });
  }

  recordAuthoritativePhaseValidation(value: AuthoritativePhaseValidation): StoredValidation {
    this.assertOpen();
    assertAuthoritativePhaseValidation(value);
    const bundle = parseValidationBundle(value.bundle);
    if (bundle.level !== "phase") {
      throw new KerbsFlowError("VALIDATION_LEVEL_MISMATCH", "authoritative phase recording requires phase-level evidence");
    }
    return this.withTransaction((tx) => {
      const run = tx.get("SELECT state, current_task_id, active_attempt_id FROM runs WHERE run_id = ?", bundle.runId) as Row | undefined;
      if (run?.state !== "VERIFY_PHASE" || run.current_task_id !== bundle.taskId || run.active_attempt_id !== bundle.attemptId) {
        throw new KerbsFlowError("VALIDATION_SCOPE_MISMATCH", "phase validation does not match the current VERIFY_PHASE run/task/attempt");
      }
      const worktree = tx.get("SELECT worktree_path, worktree_git_directory, base_oid FROM worktrees WHERE run_id = ?", bundle.runId) as Row | undefined;
      if (worktree?.worktree_path !== value.binding.worktreePath || worktree.worktree_git_directory !== value.binding.worktreeGitDirectory || worktree.base_oid !== value.binding.baseOid) {
        throw new KerbsFlowError("VALIDATION_WORKTREE_MISMATCH", "phase validation is not bound to the persisted owned worktree identity");
      }
      const existing = tx.get("SELECT * FROM validations WHERE validation_id = ?", bundle.validationId) as Row | undefined;
      if (existing !== undefined) {
        const parsed = parseValidationRow(existing);
        const authority = tx.get("SELECT * FROM phase_validation_authority WHERE validation_id = ?", bundle.validationId) as Row | undefined;
        if (canonicalJson(parsed.bundle) !== canonicalJson(bundle) || authority === undefined || canonicalJson(parsePhaseValidationAuthorityRow(authority)) !== canonicalJson({ validationId: bundle.validationId, ...value.binding, createdAt: parsed.createdAt })) {
          throw new KerbsFlowError("VALIDATION_RECORD_CONFLICT", `validation ${bundle.validationId} was reused with different evidence`);
        }
        return parsed;
      }
      const now = this.clock.now();
      tx.run("INSERT INTO validations (validation_id, run_id, task_id, attempt_id, level, outcome, bundle_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", bundle.validationId, bundle.runId, bundle.taskId, bundle.attemptId ?? null, bundle.level, bundle.outcome, JSON.stringify(bundle), now);
      tx.run("INSERT INTO phase_validation_authority (validation_id, worktree_path, worktree_git_directory, base_oid, diff_hash, changed_paths_hash, changed_paths_json, created_at, command_id, command_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", bundle.validationId, value.binding.worktreePath, value.binding.worktreeGitDirectory, value.binding.baseOid, value.binding.diffHash, value.binding.changedPathsHash, JSON.stringify(value.binding.changedPaths), now, value.binding.commandId, value.binding.commandHash);
      return parseValidationRow(tx.get("SELECT * FROM validations WHERE validation_id = ?", bundle.validationId)!);
    });
  }

  recordWorktree(record: StoredWorktree): StoredWorktree {
    this.assertOpen();
    return this.withTransaction((tx) => {
      if (tx.get("SELECT run_id FROM runs WHERE run_id = ?", record.runId) === undefined) {
        throw new NotFoundError("run", record.runId);
      }
      const existingRow = tx.get("SELECT * FROM worktrees WHERE run_id = ?", record.runId) as Row | undefined;
      if (existingRow !== undefined) {
        const existing = parseWorktreeRow(existingRow);
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw new KerbsFlowError("WORKTREE_RECORD_CONFLICT", `run ${record.runId} already has a different worktree`);
        }
        return existing;
      }
      tx.run(
        "INSERT INTO worktrees (run_id, repository_path, git_common_directory, worktree_git_directory, base_oid, branch, worktree_path, marker_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        record.runId,
        record.repositoryPath,
        record.gitCommonDirectory,
        record.worktreeGitDirectory,
        record.baseOid,
        record.branch,
        record.worktreePath,
        record.markerPath,
        record.createdAt,
      );
      return record;
    });
  }

  getCancellationIntent(attemptId: AttemptId): StoredCancellationIntent | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM cancellation_intents WHERE attempt_id = ?").get(attemptId) as Row | undefined;
    return row === undefined ? undefined : parseCancellationIntentRow(row);
  }

  prepareSemanticReview(requestValue: unknown): StoredSemanticReviewAttempt {
    this.assertOpen();
    const request = parseSemanticReviewRequest(requestValue);
    return this.withTransaction((tx) => {
      const existing = tx.get("SELECT * FROM semantic_review_attempts WHERE review_attempt_id = ?", request.reviewAttemptId) as Row | undefined;
      const hash = requestHash(request);
      if (existing !== undefined) {
        const parsed = parseSemanticReviewAttemptRow(existing);
        if (parsed.requestHash !== hash) {
          throw new KerbsFlowError("REVIEW_ATTEMPT_CONFLICT", `review attempt ${request.reviewAttemptId} was reused for different input`);
        }
        return parsed;
      }
      const attempt = tx.get("SELECT run_id, task_id FROM attempts WHERE attempt_id = ?", request.attemptId) as Row | undefined;
      if (attempt?.run_id !== request.runId || attempt.task_id !== request.taskId) {
        throw new KerbsFlowError("REVIEW_SCOPE_MISMATCH", "semantic review request does not match a persisted implementation attempt");
      }
      const active = tx.get("SELECT review_attempt_id FROM semantic_review_attempts WHERE run_id = ? AND lifecycle IN ('PREPARED', 'RUNNING', 'UNKNOWN') LIMIT 1", request.runId) as Row | undefined;
      if (active !== undefined) {
        throw new KerbsFlowError("ACTIVE_REVIEWER_EXISTS", `review attempt ${String(active.review_attempt_id)} is already nonterminal`);
      }
      const now = this.clock.now();
      const persistedRequest = semanticReviewPersistenceEnvelope(request);
      tx.run(
        "INSERT INTO semantic_review_attempts (review_attempt_id, run_id, task_id, attempt_id, lifecycle, request_json, request_hash, stored_request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        request.reviewAttemptId,
        request.runId,
        request.taskId,
        request.attemptId,
        "PREPARED",
        JSON.stringify(persistedRequest),
        hash,
        requestHash(persistedRequest),
        now,
        now,
      );
      return this.requiredSemanticReviewInTransaction(tx, request.reviewAttemptId);
    });
  }

  markSemanticReviewRunning(authority: ReviewDispatchAuthority): StoredSemanticReviewAttempt {
    this.assertOpen();
    assertReviewDispatchAuthority(authority);
    const { handle } = authority;
    if (!hasProviderIdentity(handle)) {
      throw new KerbsFlowError("REVIEW_PROVIDER_IDENTITY_REQUIRED", "semantic review dispatch requires a persisted provider session or process identity");
    }
    return this.withTransaction((tx) => {
      const review = this.requiredSemanticReviewInTransaction(tx, handle.reviewAttemptId);
      if (review.lifecycle !== "PREPARED") {
        throw new KerbsFlowError("REVIEW_NOT_PREPARED", `review attempt ${handle.reviewAttemptId} is ${review.lifecycle}`);
      }
      if (handle.runId !== review.runId || handle.taskId !== review.taskId || handle.attemptId !== review.attemptId) {
        throw new KerbsFlowError("REVIEW_SCOPE_MISMATCH", "review dispatch authority does not match the persisted request scope");
      }
      const now = this.clock.now();
      tx.run(
        "UPDATE semantic_review_attempts SET lifecycle = 'RUNNING', provider_identity_json = ?, started_at = ?, updated_at = ? WHERE review_attempt_id = ?",
        JSON.stringify(handle),
        now,
        now,
        handle.reviewAttemptId,
      );
      return this.requiredSemanticReviewInTransaction(tx, handle.reviewAttemptId);
    });
  }

  completeSemanticReview(reviewAttemptId: ReviewId, resultValue: unknown): StoredSemanticReviewAttempt {
    this.assertOpen();
    if (containsLikelySecret(resultValue)) {
      const current = this.getSemanticReviewAttempt(reviewAttemptId);
      if (current?.lifecycle === "PREPARED" || current?.lifecycle === "RUNNING") {
        this.failSemanticReview(reviewAttemptId, SENSITIVE_RESULT_REJECTION, false);
      }
      throw new KerbsFlowError("REVIEW_RESULT_SENSITIVE", SENSITIVE_RESULT_REJECTION);
    }
    const result = parseSemanticReviewResult(resultValue);
    return this.withTransaction((tx) => {
      const review = this.requiredSemanticReviewInTransaction(tx, reviewAttemptId);
      if (review.lifecycle !== "RUNNING") {
        throw new KerbsFlowError("REVIEW_NOT_RUNNING", `review attempt ${reviewAttemptId} is ${review.lifecycle}; only RUNNING review work can succeed`);
      }
      if (review.providerIdentityJson === null || !hasProviderIdentity(JSON.parse(review.providerIdentityJson))) {
        throw new KerbsFlowError("REVIEW_PROVIDER_IDENTITY_REQUIRED", "semantic review completion requires persisted provider session or process identity");
      }
      if (result.reviewAttemptId !== review.reviewAttemptId || result.runId !== review.runId || result.taskId !== review.taskId || result.attemptId !== review.attemptId) {
        throw new KerbsFlowError("REVIEW_SCOPE_MISMATCH", "semantic review result identity does not match its persisted request");
      }
      const now = this.clock.now();
      tx.run(
        "UPDATE semantic_review_attempts SET lifecycle = 'SUCCEEDED', result_json = ?, ended_at = ?, updated_at = ? WHERE review_attempt_id = ?",
        JSON.stringify(result),
        now,
        now,
        reviewAttemptId,
      );
      return this.requiredSemanticReviewInTransaction(tx, reviewAttemptId);
    });
  }

  failSemanticReview(reviewAttemptId: ReviewId, summary: string, uncertain = false): StoredSemanticReviewAttempt {
    this.assertOpen();
    const safeSummary = containsLikelySecret(summary) ? "semantic review failure contained likely credential material and was redacted" : summary;
    return this.withTransaction((tx) => {
      const review = this.requiredSemanticReviewInTransaction(tx, reviewAttemptId);
      if (review.lifecycle !== "PREPARED" && review.lifecycle !== "RUNNING") {
        throw new KerbsFlowError("REVIEW_NOT_ACTIVE", `review attempt ${reviewAttemptId} is ${review.lifecycle}`);
      }
      const now = this.clock.now();
      tx.run(
        "UPDATE semantic_review_attempts SET lifecycle = ?, failure_summary = ?, ended_at = ?, updated_at = ? WHERE review_attempt_id = ?",
        uncertain ? "UNKNOWN" : "FAILED",
        safeSummary.slice(0, 4000),
        now,
        now,
        reviewAttemptId,
      );
      return this.requiredSemanticReviewInTransaction(tx, reviewAttemptId);
    });
  }

  getSemanticReviewAttempt(reviewAttemptId: ReviewId): StoredSemanticReviewAttempt | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM semantic_review_attempts WHERE review_attempt_id = ?").get(reviewAttemptId) as Row | undefined;
    return row === undefined ? undefined : parseSemanticReviewAttemptRow(row);
  }

  listSemanticReviewAttempts(runId: RunId): StoredSemanticReviewAttempt[] {
    this.assertOpen();
    return (this.db.prepare("SELECT * FROM semantic_review_attempts WHERE run_id = ? ORDER BY created_at, review_attempt_id").all(runId) as Row[]).map(parseSemanticReviewAttemptRow);
  }

  recordFailureOccurrence(input: Omit<StoredFailureOccurrence, "occurrence" | "createdAt">): StoredFailureOccurrence {
    this.assertOpen();
    return this.withTransaction((tx) => {
      if (input.attemptId !== null) {
        const existing = tx.get("SELECT * FROM failure_occurrences WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND fingerprint = ?", input.runId, input.taskId, input.attemptId, input.fingerprint) as Row | undefined;
        if (existing !== undefined) {
          const parsed = parseFailureOccurrenceRow(existing);
          if (parsed.resultingAction !== input.resultingAction || parsed.failureClass !== input.failureClass || parsed.reasonCode !== input.reasonCode) {
            throw new KerbsFlowError("FAILURE_OCCURRENCE_CONFLICT", "the same attempt/fingerprint was recorded with a different policy result");
          }
          return parsed;
        }
      }
      const row = tx.get("SELECT COALESCE(MAX(occurrence), 0) AS occurrence FROM failure_occurrences WHERE run_id = ? AND task_id = ? AND fingerprint = ?", input.runId, input.taskId, input.fingerprint) as Row | undefined;
      const occurrence = numberValue(row?.occurrence ?? 0, "failure_occurrences.occurrence") + 1;
      const now = this.clock.now();
      tx.run(
        "INSERT INTO failure_occurrences (run_id, task_id, attempt_id, fingerprint, occurrence, failure_class, reason_code, normalized_json, route_json, resulting_action, escalation_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        input.runId,
        input.taskId,
        input.attemptId,
        input.fingerprint,
        occurrence,
        input.failureClass,
        input.reasonCode,
        input.normalizedJson,
        input.routeJson,
        input.resultingAction,
        input.escalationReason,
        now,
      );
      return { ...input, occurrence, createdAt: now };
    });
  }

  countFailureOccurrences(runId: RunId, taskId: TaskId, fingerprint: string): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM failure_occurrences WHERE run_id = ? AND task_id = ? AND fingerprint = ?").get(runId, taskId, fingerprint) as Row | undefined;
    return numberValue(row?.count ?? 0, "failure_occurrences.count");
  }

  countTaskAttempts(runId: RunId, taskId: TaskId): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND task_id = ?").get(runId, taskId) as Row | undefined;
    return numberValue(row?.count ?? 0, "attempts.count");
  }

  listTaskAttempts(runId: RunId, taskId: TaskId): StoredAttempt[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT * FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY created_at, attempt_id").all(runId, taskId) as Row[];
    return rows.map(parseAttemptRow);
  }

  listTransitions(runId: RunId): StoredTransition[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence").all(runId) as Row[];
    return rows.map(parseTransitionRow);
  }

  hasFailureEscalation(runId: RunId, taskId: TaskId): boolean {
    this.assertOpen();
    return this.db.prepare("SELECT 1 AS present FROM failure_occurrences WHERE run_id = ? AND task_id = ? AND escalation_reason IS NOT NULL LIMIT 1").get(runId, taskId) !== undefined;
  }

  getFailureOccurrenceForAttempt(runId: RunId, taskId: TaskId, attemptId: AttemptId, fingerprint: string): StoredFailureOccurrence | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM failure_occurrences WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND fingerprint = ?").get(runId, taskId, attemptId, fingerprint) as Row | undefined;
    return row === undefined ? undefined : parseFailureOccurrenceRow(row);
  }

  listFailureOccurrences(runId: RunId, taskId: TaskId): StoredFailureOccurrence[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT * FROM failure_occurrences WHERE run_id = ? AND task_id = ? ORDER BY sequence").all(runId, taskId) as Row[];
    return rows.map(parseFailureOccurrenceRow);
  }

  recordCanonicalSnapshot(snapshot: Omit<StoredCanonicalSnapshot, "capturedAt">): StoredCanonicalSnapshot {
    this.assertOpen();
    return this.withTransaction((tx) => {
      const existing = tx.get("SELECT * FROM canonical_snapshots WHERE run_id = ?", snapshot.runId) as Row | undefined;
      const now = this.clock.now();
      if (existing !== undefined) {
        const parsed = parseCanonicalSnapshotRow(existing);
        if (canonicalJson({ ...parsed, capturedAt: "" }) !== canonicalJson({ ...snapshot, capturedAt: "" })) {
          throw new KerbsFlowError("CANONICAL_SNAPSHOT_CONFLICT", "canonical hashes cannot be silently refreshed during a run");
        }
        return parsed;
      }
      tx.run("INSERT INTO canonical_snapshots (run_id, repository_path, base_oid, hashes_json, captured_at) VALUES (?, ?, ?, ?, ?)", snapshot.runId, snapshot.repositoryPath, snapshot.baseOid, JSON.stringify(snapshot.hashes), now);
      return { ...snapshot, capturedAt: now };
    });
  }

  getCanonicalSnapshot(runId: RunId): StoredCanonicalSnapshot | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM canonical_snapshots WHERE run_id = ?").get(runId) as Row | undefined;
    return row === undefined ? undefined : parseCanonicalSnapshotRow(row);
  }

  preparePhaseBoundary(boundary: Omit<StoredPhaseBoundary, "status" | "observedHashes" | "createdAt" | "updatedAt">): StoredPhaseBoundary {
    this.assertOpen();
    return this.withTransaction((tx) => {
      const existing = tx.get("SELECT * FROM phase_boundaries WHERE boundary_id = ?", boundary.boundaryId) as Row | undefined;
      if (existing !== undefined) {
        const parsed = parsePhaseBoundaryRow(existing);
        if (canonicalJson(parsed.expectedHashes) !== canonicalJson(boundary.expectedHashes) || parsed.runId !== boundary.runId) {
          throw new KerbsFlowError("PHASE_BOUNDARY_CONFLICT", `phase boundary ${boundary.boundaryId} was reused with different intent`);
        }
        return parsed;
      }
      const now = this.clock.now();
      tx.run("INSERT INTO phase_boundaries (boundary_id, run_id, status, expected_hashes_json, created_at, updated_at) VALUES (?, ?, 'PREPARED', ?, ?, ?)", boundary.boundaryId, boundary.runId, JSON.stringify(boundary.expectedHashes), now, now);
      return { ...boundary, status: "PREPARED", observedHashes: null, createdAt: now, updatedAt: now };
    });
  }

  completePhaseBoundary(boundaryId: string, observedHashes: Record<string, string>): StoredPhaseBoundary {
    this.assertOpen();
    return this.withTransaction((tx) => {
      const existing = tx.get("SELECT * FROM phase_boundaries WHERE boundary_id = ?", boundaryId) as Row | undefined;
      if (existing === undefined) {
        throw new NotFoundError("phase boundary", boundaryId);
      }
      const boundary = parsePhaseBoundaryRow(existing);
      if (boundary.status === "APPLIED") {
        if (canonicalJson(boundary.observedHashes ?? {}) !== canonicalJson(observedHashes)) {
          throw new KerbsFlowError("PHASE_BOUNDARY_CONFLICT", "completed phase boundary cannot be rewritten");
        }
        return boundary;
      }
      const snapshotRow = tx.get("SELECT * FROM canonical_snapshots WHERE run_id = ?", boundary.runId) as Row | undefined;
      if (snapshotRow === undefined) {
        throw new KerbsFlowError("CANONICAL_SNAPSHOT_REQUIRED", "phase boundary cannot complete without its canonical snapshot");
      }
      const snapshot = parseCanonicalSnapshotRow(snapshotRow);
      if (canonicalJson(snapshot.hashes) !== canonicalJson(boundary.expectedHashes)) {
        throw new KerbsFlowError("CANONICAL_INTENT_DRIFT", "canonical snapshot no longer matches the prepared phase boundary");
      }
      const now = this.clock.now();
      tx.run("UPDATE phase_boundaries SET status = 'APPLIED', observed_hashes_json = ?, updated_at = ? WHERE boundary_id = ?", JSON.stringify(observedHashes), now, boundaryId);
      tx.run("UPDATE canonical_snapshots SET hashes_json = ?, captured_at = ? WHERE run_id = ?", JSON.stringify(observedHashes), now, boundary.runId);
      return parsePhaseBoundaryRow(tx.get("SELECT * FROM phase_boundaries WHERE boundary_id = ?", boundaryId) as Row);
    });
  }

  getPhaseBoundary(boundaryId: string): StoredPhaseBoundary | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM phase_boundaries WHERE boundary_id = ?").get(boundaryId) as Row | undefined;
    return row === undefined ? undefined : parsePhaseBoundaryRow(row);
  }

  readModel(runId: RunId): ReadModel | undefined {
    const run = this.getRun(runId);
    if (run === undefined) {
      return undefined;
    }
    const task = run.currentTaskId === null ? undefined : this.getTask(run.currentTaskId);
    const attempt = run.activeAttemptId === null ? undefined : this.getAttempt(run.activeAttemptId);
    const transition = this.readTransition(this.db.prepare("SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId) as Row | undefined);
    const gate = run.currentGateId === null ? undefined : this.getGate(run.currentGateId);
    const validation = this.readValidation(this.db.prepare("SELECT * FROM validations WHERE run_id = ? ORDER BY rowid DESC LIMIT 1").get(runId) as Row | undefined);
    const review = this.readReview(this.db.prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY rowid DESC LIMIT 1").get(runId) as Row | undefined);
    return {
      run,
      ...(task === undefined ? {} : { currentTask: task }),
      ...(attempt === undefined ? {} : { activeAttempt: attempt }),
      ...(transition === undefined ? {} : { lastTransition: transition }),
      ...(gate === undefined ? {} : { currentGate: gate }),
      ...(validation === undefined ? {} : { latestValidation: validation }),
      ...(review === undefined ? {} : { latestReview: review }),
    };
  }

  createRun(command: Command & { kind: "start" }): CommandResult {
    this.assertOpen();
    const validated = parseCommand(command);
    if (validated.kind !== "start") {
      throw new KerbsFlowError("INVALID_COMMAND", "createRun requires a start command");
    }
    command = validated;
    const now = this.clock.now();
    const hash = semanticCommandHash(command);
    return this.withTransaction((tx) => {
      const duplicate = this.readCommand(tx, command.idempotencyKey);
      if (duplicate !== undefined) {
        return this.replayOrReject(duplicate, hash);
      }
      if (tx.get("SELECT run_id FROM runs WHERE run_id = ?", command.runId) !== undefined) {
        throw new KerbsFlowError("RUN_EXISTS", `run ${command.runId} already exists`);
      }
      tx.run(
        "INSERT INTO runs (run_id, objective, state, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        command.runId,
        command.objective,
        "IDLE",
        0,
        now,
        now,
      );
      const transitionId = asTransitionId(this.ids.next("transition"));
      const result: CommandResult = {
        schemaVersion: CONTRACT_VERSIONS.commandResult,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        runId: command.runId,
        accepted: true,
        replayed: false,
        from: "IDLE",
        to: "INTAKE",
        stateVersion: 1,
        transitionId,
      };
      tx.run(
        "UPDATE runs SET state = ?, state_version = ?, updated_at = ? WHERE run_id = ?",
        "INTAKE",
        1,
        now,
        command.runId,
      );
      insertTransition(tx, {
        transitionId,
        runId: command.runId,
        from: "IDLE",
        to: "INTAKE",
        reasonCode: "start_run",
        actor: "human",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        payloadJson: canonicalJson({ objective: command.objective }),
        createdAt: now,
      });
      insertCommand(tx, command, hash, result, 0, 1, transitionId, now);
      return result;
    });
  }

  executeCommand(command: Command, mutation: (context: CommandMutationContext) => CommandMutation): CommandResult {
    this.assertOpen();
    command = parseCommand(command);
    const now = this.clock.now();
    const hash = semanticCommandHash(command);
    return this.withTransaction((tx) => {
      const duplicate = this.readCommand(tx, command.idempotencyKey);
      if (duplicate !== undefined) {
        return this.replayOrReject(duplicate, hash);
      }
      const run = this.readRun(tx.get("SELECT * FROM runs WHERE run_id = ?", command.runId) as Row | undefined);
      if (run === undefined) {
        throw new NotFoundError("run", command.runId);
      }
      if (run.stateVersion !== command.expectedStateVersion) {
        throw new StateVersionConflictError(command.runId, command.expectedStateVersion, run.stateVersion);
      }
      const mutationResult = mutation({ tx, run, now, nextId: (prefix) => this.ids.next(prefix) });
      const transition = mutationResult.transition;
      if (transition !== undefined) {
        assertLegalTransition(run.state, transition.to);
        if (transition.to === "PAUSED" && mutationResult.runPatch?.pauseContract === undefined) {
          throw new KerbsFlowError("PAUSE_CONTRACT_REQUIRED", "PAUSED transitions require a persisted core-selected pause contract");
        }
      }
      const stateVersionAfter = transition === undefined ? run.stateVersion : run.stateVersion + 1;
      const transitionId = transition === undefined ? undefined : asTransitionId(this.ids.next("transition"));
      const nextRun = updateRun(tx, run, mutationResult.runPatch, transition?.to, stateVersionAfter, now);
      if (transition !== undefined && transitionId !== undefined) {
        insertTransition(tx, {
          transitionId,
          runId: run.runId,
          from: run.state,
          to: transition.to,
          reasonCode: transition.reasonCode,
          actor: transition.actor,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          taskId: transition.taskId ?? nextRun.currentTaskId,
          attemptId: transition.attemptId ?? nextRun.activeAttemptId,
          gateId: transition.gateId ?? nextRun.currentGateId,
          stateVersionBefore: run.stateVersion,
          stateVersionAfter,
          payloadJson: canonicalJson(transition.payload ?? {}),
          createdAt: now,
        });
      }
      const result: CommandResult = {
        schemaVersion: CONTRACT_VERSIONS.commandResult,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        runId: command.runId,
        accepted: true,
        replayed: false,
        from: run.state,
        to: transition?.to ?? run.state,
        stateVersion: stateVersionAfter,
        ...(transitionId === undefined ? {} : { transitionId }),
        ...(mutationResult.details === undefined ? {} : { details: mutationResult.details }),
      };
      insertCommand(tx, command, hash, result, run.stateVersion, stateVersionAfter, transitionId ?? null, now);
      return result;
    });
  }

  closeAndReopen(): StateStore {
    this.close();
    return StateStore.open(this.databasePath, { clock: this.clock, ids: this.ids });
  }

  private detectStartupRecovery(): void {
    this.withTransaction((tx) => {
      const rows = tx.all("SELECT * FROM runs WHERE state NOT IN ('FAILED', 'CANCELLED', 'DONE') AND state != 'IDLE' ORDER BY run_id") as Row[];
      for (const row of rows) {
        const run = this.readRun(row);
        if (run === undefined) {
          continue;
        }
        const activeAttempt = run.activeAttemptId === null
          ? undefined
          : this.readAttempt(tx.get("SELECT * FROM attempts WHERE attempt_id = ?", run.activeAttemptId) as Row | undefined);
        const activeAttemptNeedsRecovery = activeAttempt !== undefined && !isTerminalAttempt(activeAttempt.lifecycle);
        const stateNeedsRecovery = run.state === "EXECUTE" || run.state === "VERIFY_FOCUSED" || run.state === "RECOVERY";
        if (!activeAttemptNeedsRecovery && !stateNeedsRecovery) {
          continue;
        }
        const reason = activeAttemptNeedsRecovery
          ? `nonterminal attempt ${activeAttempt?.attemptId ?? "unknown"} requires conservative recovery`
          : `run reopened at ${run.state} before a durable workflow boundary`;
        if (run.state !== "PAUSED" && run.state !== "RECOVERY" && (run.state === "EXECUTE" || run.state === "VERIFY_FOCUSED")) {
          const commandId = asCommandId(this.ids.next("command"));
          const transitionId = asTransitionId(this.ids.next("transition"));
          const idempotencyKey = `startup-recovery:${run.runId}:${run.stateVersion}`;
          const command: Command = {
            schemaVersion: CONTRACT_VERSIONS.command,
            commandId,
            idempotencyKey,
            runId: run.runId,
            expectedStateVersion: run.stateVersion,
            kind: "transition",
            target: "RECOVERY",
            actor: "recovery",
            reasonCode: "startup_recovery",
            payload: { reason },
          };
          const result: CommandResult = {
            schemaVersion: CONTRACT_VERSIONS.commandResult,
            commandId,
            idempotencyKey,
            runId: run.runId,
            accepted: true,
            replayed: false,
            from: run.state,
            to: "RECOVERY",
            stateVersion: run.stateVersion + 1,
            transitionId,
            details: { startup: true },
          };
          assertLegalTransition(run.state, "RECOVERY");
          updateRun(tx, run, { recoveryRequired: true, recoveryReason: reason }, "RECOVERY", run.stateVersion + 1, this.clock.now());
          insertTransition(tx, {
            transitionId,
            runId: run.runId,
            from: run.state,
            to: "RECOVERY",
            reasonCode: "startup_recovery",
            actor: "recovery",
            commandId,
            idempotencyKey,
            taskId: run.currentTaskId,
            attemptId: run.activeAttemptId,
            gateId: run.currentGateId,
            stateVersionBefore: run.stateVersion,
            stateVersionAfter: run.stateVersion + 1,
            payloadJson: canonicalJson({ reason }),
            createdAt: this.clock.now(),
          });
          insertCommand(tx, command, semanticCommandHash(command), result, run.stateVersion, run.stateVersion + 1, transitionId, this.clock.now());
          this.recoveryNotices.push({ runId: run.runId, previousState: run.state, currentState: "RECOVERY", activeAttemptId: run.activeAttemptId, reason, automaticTransition: true });
        } else {
          updateRun(tx, run, { recoveryRequired: true, recoveryReason: reason }, undefined, run.stateVersion, this.clock.now());
          this.recoveryNotices.push({ runId: run.runId, previousState: run.state, currentState: run.state, activeAttemptId: run.activeAttemptId, reason, automaticTransition: false });
        }
      }
    });
  }

  private readCommand(tx: SqlTransaction, idempotencyKey: string): StoredCommand | undefined {
    const row = tx.get("SELECT * FROM commands WHERE idempotency_key = ?", idempotencyKey) as Row | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      idempotencyKey: stringValue(row.idempotency_key, "commands.idempotency_key"),
      requestHash: stringValue(row.request_hash, "commands.request_hash"),
      result: parseStoredCommandResult(stringValue(row.result_json, "commands.result_json")),
    };
  }

  private replayOrReject(command: StoredCommand, expectedHash: string): CommandResult {
    if (command.requestHash !== expectedHash) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return { ...command.result, replayed: true };
  }

  private readRun(row: Row | undefined): StoredRun | undefined {
    return row === undefined ? undefined : parseRunRow(row);
  }

  private readTask(row: Row | undefined): StoredTask | undefined {
    return row === undefined ? undefined : parseTaskRow(row);
  }

  private readAttempt(row: Row | undefined): StoredAttempt | undefined {
    return row === undefined ? undefined : parseAttemptRow(row);
  }

  private readGate(row: Row | undefined): StoredGate | undefined {
    return row === undefined ? undefined : parseGateRow(row);
  }

  private readTransition(row: Row | undefined): StoredTransition | undefined {
    return row === undefined ? undefined : parseTransitionRow(row);
  }

  private readValidation(row: Row | undefined): StoredValidation | undefined {
    return row === undefined ? undefined : parseValidationRow(row);
  }

  private readReview(row: Row | undefined): StoredReview | undefined {
    return row === undefined ? undefined : parseReviewRow(row);
  }

  private withTransaction<T>(operation: (tx: SqlTransaction) => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    const tx = makeTransaction(this.db);
    try {
      const result = operation(tx);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      return rollbackAndRethrow(this.db, error);
    }
  }

  private requiredSemanticReviewInTransaction(tx: SqlTransaction, reviewAttemptId: ReviewId): StoredSemanticReviewAttempt {
    const row = tx.get("SELECT * FROM semantic_review_attempts WHERE review_attempt_id = ?", reviewAttemptId) as Row | undefined;
    if (row === undefined) {
      throw new NotFoundError("semantic review attempt", reviewAttemptId);
    }
    return parseSemanticReviewAttemptRow(row);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new KerbsFlowError("STORE_CLOSED", "state store is closed");
    }
  }
}

function hasProviderIdentity(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const providerSessionId = (value as Record<string, unknown>).providerSessionId;
  return typeof providerSessionId === "string" && providerSessionId.trim().length > 0;
}

interface StoredCommand {
  idempotencyKey: string;
  requestHash: string;
  result: CommandResult;
}

type Row = Record<string, unknown>;

function configureDatabase(db: DatabaseSync, busyTimeoutMs: number): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
    throw new KerbsFlowError("INVALID_DATABASE_OPTION", "busy timeout must be a safe integer between 0 and 60000 milliseconds");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}

export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[], clock: Clock = new SystemClock()): void {
  validateMigrationList(migrations);
  const applied = readAppliedMigrations(db);
  for (const [version, checksum] of applied) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (migration === undefined || migrationChecksum(migration) !== checksum) {
      throw new KerbsFlowError("MIGRATION_CHECKSUM_MISMATCH", `migration ${version} is missing or has a different checksum`);
    }
  }
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      const result = db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), clock.now());
      if (result.changes !== 1 && result.changes !== 1n) {
        throw new KerbsFlowError("MIGRATION_FAILED", `migration ${migration.version} did not record its version`);
      }
      db.exec("COMMIT");
      applied.set(migration.version, migrationChecksum(migration));
    } catch (error) {
      rollbackAndRethrow(db, error);
    }
  }
}

function rollbackAndRethrow(db: DatabaseSync, originalError: unknown): never {
  try {
    db.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError([originalError, rollbackError], "SQLite rollback failed after an operation error");
  }
  throw originalError;
}

function validateMigrationList(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous || migration.name.length === 0 || migration.sql.trim().length === 0) {
      throw new KerbsFlowError("INVALID_MIGRATION_LIST", "migrations must be forward-only, numbered, named, and non-empty");
    }
    previous = migration.version;
  }
}

function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

function readAppliedMigrations(db: DatabaseSync): Map<number, string> {
  const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as Row | undefined;
  if (exists === undefined) {
    return new Map();
  }
  const rows = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Row[];
  return new Map(rows.map((row) => [numberValue(row.version, "schema_migrations.version"), stringValue(row.checksum, "schema_migrations.checksum")]));
}

function assertIntegrity(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA integrity_check").get() as Row | undefined;
  if (row === undefined || row.integrity_check !== "ok") {
    throw new DatabaseIntegrityError(`SQLite integrity check failed: ${String(row?.integrity_check ?? "no result")}`);
  }
}

function makeTransaction(db: DatabaseSync): SqlTransaction {
  return {
    run(sql, ...parameters) {
      const result = db.prepare(sql).run(...parameters);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): T | undefined {
      return db.prepare(sql).get(...parameters) as T | undefined;
    },
    all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): T[] {
      return db.prepare(sql).all(...parameters) as T[];
    },
    exec(sql: string): void {
      db.exec(sql);
    },
  };
}

function insertCommand(tx: SqlTransaction, command: Command, hash: string, result: CommandResult, before: number, after: number, transitionId: TransitionId | null, createdAt: string): void {
  tx.run(
    "INSERT INTO commands (idempotency_key, command_id, run_id, request_hash, request_json, result_json, transition_id, state_version_before, state_version_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    command.idempotencyKey,
    command.commandId,
    command.runId,
    hash,
    canonicalJson(command as unknown as object),
    canonicalJson(result),
    transitionId,
    before,
    after,
    createdAt,
  );
}

function semanticCommandHash(command: Command): string {
  const { commandId: _commandId, expectedStateVersion: _expectedStateVersion, ...semanticRequest } = command;
  return requestHash(semanticRequest as object);
}

function insertTransition(tx: SqlTransaction, transition: {
  transitionId: TransitionId;
  runId: RunId;
  from: RunState;
  to: RunState;
  reasonCode: string;
  actor: string;
  commandId: string;
  idempotencyKey: string;
  taskId?: TaskId | null;
  attemptId?: AttemptId | null;
  gateId?: GateId | null;
  stateVersionBefore: number;
  stateVersionAfter: number;
  payloadJson: string;
  createdAt: string;
}): void {
  tx.run(
    "INSERT INTO transitions (transition_id, run_id, from_state, to_state, reason_code, actor, command_id, idempotency_key, task_id, attempt_id, gate_id, state_version_before, state_version_after, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    transition.transitionId,
    transition.runId,
    transition.from,
    transition.to,
    transition.reasonCode,
    transition.actor,
    transition.commandId,
    transition.idempotencyKey,
    transition.taskId ?? null,
    transition.attemptId ?? null,
    transition.gateId ?? null,
    transition.stateVersionBefore,
    transition.stateVersionAfter,
    transition.payloadJson,
    transition.createdAt,
  );
}

function updateRun(tx: SqlTransaction, run: StoredRun, patch: RunPatch | undefined, nextState: RunState | undefined, nextVersion: number, updatedAt: string): StoredRun {
  const next: StoredRun = {
    ...run,
    ...(nextState === undefined ? {} : { state: nextState }),
    stateVersion: nextVersion,
    ...(patch?.currentTaskId === undefined ? {} : { currentTaskId: patch.currentTaskId }),
    ...(patch?.activeAttemptId === undefined ? {} : { activeAttemptId: patch.activeAttemptId }),
    ...(patch?.currentGateId === undefined ? {} : { currentGateId: patch.currentGateId }),
    ...(patch?.pauseContract === undefined ? {} : { pauseContract: patch.pauseContract }),
    ...(patch?.recoveryRequired === undefined ? {} : { recoveryRequired: patch.recoveryRequired }),
    ...(patch?.recoveryReason === undefined ? {} : { recoveryReason: patch.recoveryReason }),
    updatedAt,
  };
  tx.run(
    "UPDATE runs SET state = ?, state_version = ?, current_task_id = ?, active_attempt_id = ?, current_gate_id = ?, pause_contract_json = ?, pause_contract_hash = ?, recovery_required = ?, recovery_reason = ?, updated_at = ? WHERE run_id = ? AND state_version = ?",
    next.state,
    next.stateVersion,
    next.currentTaskId,
    next.activeAttemptId,
    next.currentGateId,
    next.pauseContract === null ? null : canonicalJson(next.pauseContract),
    next.pauseContract === null ? null : requestHash(next.pauseContract),
    next.recoveryRequired ? 1 : 0,
    next.recoveryReason,
    updatedAt,
    next.runId,
    run.stateVersion,
  );
  return next;
}

function parseRunRow(row: Row): StoredRun {
  const pauseJson = nullableString(row.pause_contract_json, "runs.pause_contract_json");
  const pauseHash = nullableString(row.pause_contract_hash, "runs.pause_contract_hash");
  const pauseContract = pauseJson === null ? null : parsePauseContract(JSON.parse(pauseJson), "runs.pause_contract_json");
  if ((pauseContract === null) !== (pauseHash === null) || (pauseContract !== null && requestHash(pauseContract) !== pauseHash)) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "pause contract integrity check failed");
  }
  return {
    runId: asRunId(stringValue(row.run_id, "runs.run_id")),
    objective: stringValue(row.objective, "runs.objective"),
    state: parseRunState(row.state, "runs.state"),
    stateVersion: numberValue(row.state_version, "runs.state_version"),
    currentTaskId: nullableString(row.current_task_id, "runs.current_task_id") === null ? null : asTaskId(nullableString(row.current_task_id, "runs.current_task_id")!),
    activeAttemptId: nullableString(row.active_attempt_id, "runs.active_attempt_id") === null ? null : asAttemptId(nullableString(row.active_attempt_id, "runs.active_attempt_id")!),
    currentGateId: nullableString(row.current_gate_id, "runs.current_gate_id") === null ? null : asGateId(nullableString(row.current_gate_id, "runs.current_gate_id")!),
    pauseContract,
    pauseContractHash: pauseHash,
    recoveryRequired: numberValue(row.recovery_required, "runs.recovery_required") === 1,
    recoveryReason: nullableString(row.recovery_reason, "runs.recovery_reason"),
    createdAt: stringValue(row.created_at, "runs.created_at"),
    updatedAt: stringValue(row.updated_at, "runs.updated_at"),
  };
}

function parseTaskRow(row: Row): StoredTask {
  return {
    taskId: asTaskId(stringValue(row.task_id, "tasks.task_id")),
    runId: asRunId(stringValue(row.run_id, "tasks.run_id")),
    status: stringValue(row.status, "tasks.status"),
    decision: parsePlanningDecision(JSON.parse(stringValue(row.decision_json, "tasks.decision_json")), "tasks.decision_json"),
    createdAt: stringValue(row.created_at, "tasks.created_at"),
    updatedAt: stringValue(row.updated_at, "tasks.updated_at"),
  };
}

function parseAttemptRow(row: Row): StoredAttempt {
  const lifecycle = stringValue(row.lifecycle, "attempts.lifecycle");
  if (!isAttemptLifecycle(lifecycle)) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `unknown attempt lifecycle ${lifecycle}`);
  }
  return {
    attemptId: asAttemptId(stringValue(row.attempt_id, "attempts.attempt_id")),
    runId: asRunId(stringValue(row.run_id, "attempts.run_id")),
    taskId: asTaskId(stringValue(row.task_id, "attempts.task_id")),
    lifecycle,
    adapterDescriptorJson: nullableString(row.adapter_descriptor_json, "attempts.adapter_descriptor_json"),
    providerIdentityJson: nullableString(row.provider_identity_json, "attempts.provider_identity_json"),
    outcomeJson: nullableString(row.outcome_json, "attempts.outcome_json"),
    failureClass: nullableString(row.failure_class, "attempts.failure_class"),
    startedAt: nullableString(row.started_at, "attempts.started_at"),
    endedAt: nullableString(row.ended_at, "attempts.ended_at"),
    createdAt: stringValue(row.created_at, "attempts.created_at"),
    updatedAt: stringValue(row.updated_at, "attempts.updated_at"),
  };
}

function parseTransitionRow(row: Row): StoredTransition {
  return {
    sequence: numberValue(row.sequence, "transitions.sequence"),
    transitionId: asTransitionId(stringValue(row.transition_id, "transitions.transition_id")),
    runId: asRunId(stringValue(row.run_id, "transitions.run_id")),
    from: parseRunState(row.from_state, "transitions.from_state"),
    to: parseRunState(row.to_state, "transitions.to_state"),
    reasonCode: stringValue(row.reason_code, "transitions.reason_code"),
    actor: stringValue(row.actor, "transitions.actor"),
    commandId: stringValue(row.command_id, "transitions.command_id"),
    idempotencyKey: stringValue(row.idempotency_key, "transitions.idempotency_key"),
    taskId: nullableString(row.task_id, "transitions.task_id") === null ? null : asTaskId(nullableString(row.task_id, "transitions.task_id")!),
    attemptId: nullableString(row.attempt_id, "transitions.attempt_id") === null ? null : asAttemptId(nullableString(row.attempt_id, "transitions.attempt_id")!),
    gateId: nullableString(row.gate_id, "transitions.gate_id") === null ? null : asGateId(nullableString(row.gate_id, "transitions.gate_id")!),
    stateVersionBefore: numberValue(row.state_version_before, "transitions.state_version_before"),
    stateVersionAfter: numberValue(row.state_version_after, "transitions.state_version_after"),
    payloadJson: stringValue(row.payload_json, "transitions.payload_json"),
    createdAt: stringValue(row.created_at, "transitions.created_at"),
  };
}

function parseValidationRow(row: Row): StoredValidation {
  return {
    validationId: stringValue(row.validation_id, "validations.validation_id"),
    runId: asRunId(stringValue(row.run_id, "validations.run_id")),
    taskId: asTaskId(stringValue(row.task_id, "validations.task_id")),
    attemptId: nullableString(row.attempt_id, "validations.attempt_id") === null ? null : asAttemptId(nullableString(row.attempt_id, "validations.attempt_id")!),
    level: stringValue(row.level, "validations.level"),
    outcome: stringValue(row.outcome, "validations.outcome"),
    bundle: parseValidationBundle(JSON.parse(stringValue(row.bundle_json, "validations.bundle_json")), "validations.bundle_json"),
    createdAt: stringValue(row.created_at, "validations.created_at"),
  };
}

function parsePhaseValidationAuthorityRow(row: Row): StoredPhaseValidationAuthority {
  const changedPaths = JSON.parse(stringValue(row.changed_paths_json, "phase_validation_authority.changed_paths_json")) as unknown;
  if (!Array.isArray(changedPaths) || changedPaths.some((path) => typeof path !== "string")) {
    throw new KerbsFlowError("PERSISTED_ROW_INVALID", "phase_validation_authority.changed_paths_json must be a string array");
  }
  return {
    validationId: asValidationId(stringValue(row.validation_id, "phase_validation_authority.validation_id")),
    worktreePath: stringValue(row.worktree_path, "phase_validation_authority.worktree_path"),
    worktreeGitDirectory: stringValue(row.worktree_git_directory, "phase_validation_authority.worktree_git_directory"),
    baseOid: stringValue(row.base_oid, "phase_validation_authority.base_oid"),
    diffHash: stringValue(row.diff_hash, "phase_validation_authority.diff_hash"),
    changedPathsHash: stringValue(row.changed_paths_hash, "phase_validation_authority.changed_paths_hash"),
    changedPaths,
    commandId: stringValue(row.command_id, "phase_validation_authority.command_id"),
    commandHash: stringValue(row.command_hash, "phase_validation_authority.command_hash"),
    createdAt: stringValue(row.created_at, "phase_validation_authority.created_at"),
  };
}

function parseReviewRow(row: Row): StoredReview {
  return {
    reviewId: stringValue(row.review_id, "reviews.review_id"),
    runId: asRunId(stringValue(row.run_id, "reviews.run_id")),
    taskId: asTaskId(stringValue(row.task_id, "reviews.task_id")),
    outcome: stringValue(row.outcome, "reviews.outcome"),
    decision: parseReviewDecision(JSON.parse(stringValue(row.decision_json, "reviews.decision_json")), "reviews.decision_json"),
    createdAt: stringValue(row.created_at, "reviews.created_at"),
  };
}

function parseGateRow(row: Row): StoredGate {
  return {
    gateId: asGateId(stringValue(row.gate_id, "human_gates.gate_id")),
    runId: asRunId(stringValue(row.run_id, "human_gates.run_id")),
    taskId: nullableString(row.task_id, "human_gates.task_id") === null ? null : asTaskId(nullableString(row.task_id, "human_gates.task_id")!),
    attemptId: nullableString(row.attempt_id, "human_gates.attempt_id") === null ? null : asAttemptId(nullableString(row.attempt_id, "human_gates.attempt_id")!),
    status: stringValue(row.status, "human_gates.status"),
    gate: parseHumanGate(JSON.parse(stringValue(row.gate_json, "human_gates.gate_json")), "human_gates.gate_json"),
    createdAt: stringValue(row.created_at, "human_gates.created_at"),
    resolvedAt: nullableString(row.resolved_at, "human_gates.resolved_at"),
  };
}

function parseWorktreeRow(row: Row): StoredWorktree {
  return {
    runId: asRunId(stringValue(row.run_id, "worktrees.run_id")),
    repositoryPath: stringValue(row.repository_path, "worktrees.repository_path"),
    gitCommonDirectory: stringValue(row.git_common_directory, "worktrees.git_common_directory"),
    worktreeGitDirectory: stringValue(row.worktree_git_directory, "worktrees.worktree_git_directory"),
    baseOid: stringValue(row.base_oid, "worktrees.base_oid"),
    branch: stringValue(row.branch, "worktrees.branch"),
    worktreePath: stringValue(row.worktree_path, "worktrees.worktree_path"),
    markerPath: stringValue(row.marker_path, "worktrees.marker_path"),
    createdAt: stringValue(row.created_at, "worktrees.created_at"),
  };
}

function parseRoutingDecisionRow(row: Row): StoredRoutingDecision {
  const decision = assertRoutingDecision(JSON.parse(stringValue(row.decision_json, "routing_decisions.decision_json")) as RoutingDecision);
  if (
    decision.planningDecisionId !== stringValue(row.planning_decision_id, "routing_decisions.planning_decision_id")
    || decision.runId !== asRunId(stringValue(row.run_id, "routing_decisions.run_id"))
    || decision.taskId !== asTaskId(stringValue(row.task_id, "routing_decisions.task_id"))
  ) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "routing decision identity does not match its indexed columns");
  }
  return {
    decision,
    createdAt: stringValue(row.created_at, "routing_decisions.created_at"),
    updatedAt: stringValue(row.updated_at, "routing_decisions.updated_at"),
  };
}

function parseAttemptRoutingProvenanceRow(row: Row): StoredAttemptRoutingProvenance {
  const provenance = assertAttemptRoutingProvenance(JSON.parse(stringValue(row.provenance_json, "attempt_routing_provenance.provenance_json")) as AttemptRoutingProvenance);
  if (
    provenance.attemptId !== asAttemptId(stringValue(row.attempt_id, "attempt_routing_provenance.attempt_id"))
    || provenance.planningDecisionId !== stringValue(row.planning_decision_id, "attempt_routing_provenance.planning_decision_id")
    || provenance.runId !== asRunId(stringValue(row.run_id, "attempt_routing_provenance.run_id"))
    || provenance.taskId !== asTaskId(stringValue(row.task_id, "attempt_routing_provenance.task_id"))
    || provenance.capabilitySnapshotHash !== stringValue(row.capability_snapshot_hash, "attempt_routing_provenance.capability_snapshot_hash")
  ) throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "attempt routing provenance identity does not match its indexed columns");
  return { provenance, createdAt: stringValue(row.created_at, "attempt_routing_provenance.created_at") };
}

function parseAdapterDescriptorForRouting(value: string) {
  return parseAdapterDescriptor(JSON.parse(value), "attempts.adapter_descriptor_json");
}

function parseCancellationIntentRow(row: Row): StoredCancellationIntent {
  const status = stringValue(row.status, "cancellation_intents.status");
  if (status !== "REQUESTED" && status !== "SIGNAL_PENDING" && status !== "SIGNALLED" && status !== "CANCELLED" && status !== "UNCERTAIN") {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `unknown cancellation status ${status}`);
  }
  return {
    attemptId: asAttemptId(stringValue(row.attempt_id, "cancellation_intents.attempt_id")),
    runId: asRunId(stringValue(row.run_id, "cancellation_intents.run_id")),
    reason: stringValue(row.reason, "cancellation_intents.reason"),
    status,
    requestCommandId: stringValue(row.request_command_id, "cancellation_intents.request_command_id"),
    adapterOutcomeJson: nullableString(row.adapter_outcome_json, "cancellation_intents.adapter_outcome_json"),
    reconciliationJson: nullableString(row.reconciliation_json, "cancellation_intents.reconciliation_json"),
    requestedAt: stringValue(row.requested_at, "cancellation_intents.requested_at"),
    updatedAt: stringValue(row.updated_at, "cancellation_intents.updated_at"),
    terminalAt: nullableString(row.terminal_at, "cancellation_intents.terminal_at"),
  };
}

function parseSemanticReviewAttemptRow(row: Row): StoredSemanticReviewAttempt {
  const lifecycle = stringValue(row.lifecycle, "semantic_review_attempts.lifecycle");
  if (lifecycle !== "PREPARED" && lifecycle !== "RUNNING" && lifecycle !== "SUCCEEDED" && lifecycle !== "FAILED" && lifecycle !== "UNKNOWN") {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `unknown semantic review lifecycle ${lifecycle}`);
  }
  const request = parseSemanticReviewRequest(JSON.parse(stringValue(row.request_json, "semantic_review_attempts.request_json")), "semantic_review_attempts.request_json");
  const resultJson = nullableString(row.result_json, "semantic_review_attempts.result_json");
  const result = resultJson === null ? null : parseSemanticReviewResult(JSON.parse(resultJson), "semantic_review_attempts.result_json");
  if (
    request.reviewAttemptId !== row.review_attempt_id
    || request.runId !== row.run_id
    || request.taskId !== row.task_id
    || request.attemptId !== row.attempt_id
    || requestHash(request) !== stringValue(row.stored_request_hash, "semantic_review_attempts.stored_request_hash")
    || (result !== null && (result.reviewAttemptId !== request.reviewAttemptId || result.runId !== request.runId || result.taskId !== request.taskId || result.attemptId !== request.attemptId))
  ) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "semantic review columns and contract identity do not agree");
  }
  return {
    reviewAttemptId: request.reviewAttemptId,
    runId: request.runId,
    taskId: request.taskId,
    attemptId: request.attemptId,
    lifecycle,
    request,
    requestHash: stringValue(row.request_hash, "semantic_review_attempts.request_hash"),
    providerIdentityJson: nullableString(row.provider_identity_json, "semantic_review_attempts.provider_identity_json"),
    result,
    failureSummary: nullableString(row.failure_summary, "semantic_review_attempts.failure_summary"),
    createdAt: stringValue(row.created_at, "semantic_review_attempts.created_at"),
    startedAt: nullableString(row.started_at, "semantic_review_attempts.started_at"),
    endedAt: nullableString(row.ended_at, "semantic_review_attempts.ended_at"),
    updatedAt: stringValue(row.updated_at, "semantic_review_attempts.updated_at"),
  };
}

function semanticReviewPersistenceEnvelope(request: SemanticReviewRequest): SemanticReviewRequest {
  return {
    ...request,
    promptSummary: `review context omitted from SQLite; sha256=${createHash("sha256").update(request.promptSummary).digest("hex")}`,
  };
}

function sanitizePersistedSemanticReviewContext(db: DatabaseSync): void {
  const rows = db.prepare("SELECT review_attempt_id, request_json FROM semantic_review_attempts WHERE stored_request_hash IS NULL").all() as Row[];
  if (rows.length === 0) {
    return;
  }
  db.exec("PRAGMA secure_delete = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE semantic_review_attempts SET request_json = ?, stored_request_hash = ? WHERE review_attempt_id = ? AND stored_request_hash IS NULL");
    for (const row of rows) {
      const request = parseSemanticReviewRequest(JSON.parse(stringValue(row.request_json, "semantic_review_attempts.request_json")), "semantic_review_attempts.request_json");
      const envelope = semanticReviewPersistenceEnvelope(request);
      const result = update.run(JSON.stringify(envelope), requestHash(envelope), stringValue(row.review_attempt_id, "semantic_review_attempts.review_attempt_id"));
      if (result.changes !== 1 && result.changes !== 1n) {
        throw new KerbsFlowError("REVIEW_CONTEXT_REDACTION_FAILED", "semantic review context redaction did not update exactly one row");
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackAndRethrow(db, error);
  }
}

function parseFailureOccurrenceRow(row: Row): StoredFailureOccurrence {
  return {
    runId: asRunId(stringValue(row.run_id, "failure_occurrences.run_id")),
    taskId: asTaskId(stringValue(row.task_id, "failure_occurrences.task_id")),
    attemptId: nullableString(row.attempt_id, "failure_occurrences.attempt_id") === null ? null : asAttemptId(nullableString(row.attempt_id, "failure_occurrences.attempt_id")!),
    fingerprint: stringValue(row.fingerprint, "failure_occurrences.fingerprint"),
    occurrence: numberValue(row.occurrence, "failure_occurrences.occurrence"),
    failureClass: stringValue(row.failure_class, "failure_occurrences.failure_class"),
    reasonCode: stringValue(row.reason_code, "failure_occurrences.reason_code"),
    normalizedJson: stringValue(row.normalized_json, "failure_occurrences.normalized_json"),
    routeJson: stringValue(row.route_json, "failure_occurrences.route_json"),
    resultingAction: stringValue(row.resulting_action, "failure_occurrences.resulting_action"),
    escalationReason: nullableString(row.escalation_reason, "failure_occurrences.escalation_reason"),
    createdAt: stringValue(row.created_at, "failure_occurrences.created_at"),
  };
}

function parseCanonicalSnapshotRow(row: Row): StoredCanonicalSnapshot {
  const rawHashes = JSON.parse(stringValue(row.hashes_json, "canonical_snapshots.hashes_json")) as unknown;
  if (typeof rawHashes !== "object" || rawHashes === null || Array.isArray(rawHashes) || Object.values(rawHashes).some((value) => typeof value !== "string")) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "canonical snapshot hashes are invalid");
  }
  return {
    runId: asRunId(stringValue(row.run_id, "canonical_snapshots.run_id")),
    repositoryPath: stringValue(row.repository_path, "canonical_snapshots.repository_path"),
    baseOid: stringValue(row.base_oid, "canonical_snapshots.base_oid"),
    hashes: rawHashes as Record<string, string>,
    capturedAt: stringValue(row.captured_at, "canonical_snapshots.captured_at"),
  };
}

function parsePhaseBoundaryRow(row: Row): StoredPhaseBoundary {
  const status = stringValue(row.status, "phase_boundaries.status");
  if (status !== "PREPARED" && status !== "APPLIED") {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `unknown phase boundary status ${status}`);
  }
  const parseHashes = (value: unknown, path: string): Record<string, string> => {
    const parsed = JSON.parse(stringValue(value, path)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== "string")) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `${path} is invalid`);
    }
    return parsed as Record<string, string>;
  };
  const observed = nullableString(row.observed_hashes_json, "phase_boundaries.observed_hashes_json");
  return {
    boundaryId: stringValue(row.boundary_id, "phase_boundaries.boundary_id"),
    runId: asRunId(stringValue(row.run_id, "phase_boundaries.run_id")),
    status,
    expectedHashes: parseHashes(row.expected_hashes_json, "phase_boundaries.expected_hashes_json"),
    observedHashes: observed === null ? null : parseHashes(observed, "phase_boundaries.observed_hashes_json"),
    createdAt: stringValue(row.created_at, "phase_boundaries.created_at"),
    updatedAt: stringValue(row.updated_at, "phase_boundaries.updated_at"),
  };
}

function parseStoredCommandResult(value: string): CommandResult {
  try {
    return parseCommandResult(JSON.parse(value), "commands.result_json");
  } catch (error) {
    throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", error instanceof Error ? error.message : "stored command result is invalid");
  }
}

function isAttemptLifecycle(value: string): value is AttemptLifecycle {
  return value === "PREPARED" || value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "BLOCKED" || value === "PARTIAL" || value === "CANCELLED" || value === "UNKNOWN";
}

function isTerminalAttempt(value: AttemptLifecycle): boolean {
  return value === "SUCCEEDED" || value === "FAILED" || value === "BLOCKED" || value === "PARTIAL" || value === "CANCELLED";
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new KerbsFlowError("PERSISTED_ROW_INVALID", `${path} must be a string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value, path);
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new KerbsFlowError("PERSISTED_ROW_INVALID", `${path} must be a safe integer`);
  }
  return value;
}
