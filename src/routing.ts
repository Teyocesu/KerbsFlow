import {
  type AdapterDescriptor,
  type AttemptHandle,
  type AttemptId,
  type CancelOutcome,
  type ExecutionRequest,
  type NormalizedEvent,
  type PlanningDecision,
  type ReconcileOutcome,
  type RunId,
  type TaskId,
  parseAdapterDescriptor,
  parsePlanningDecision,
} from "./contracts.js";
import type { ExecutorAdapter } from "./adapter.js";
import { KerbsFlowError } from "./errors.js";

export const ROUTING_DECISION_VERSION = "kerbsflow.routing-decision/v1" as const;
export const PHASE4_ROUTING_POLICY = "kerbsflow.phase4-routing/v1";

export type WorkClassification = "normal" | "difficult" | "high_impact";
export type RouteFamily = "muse" | "luna" | "sol";

export interface RouteCandidate {
  adapter: "opencode" | "codex";
  provider: string;
  model: string;
  family: RouteFamily;
  reasoning?: string;
  available: boolean;
  descriptor: AdapterDescriptor;
}

export interface ConsideredRoute {
  adapter: RouteCandidate["adapter"];
  provider: string;
  model: string;
  family: RouteFamily;
  reasoning?: string;
  available: boolean;
  suitable: boolean;
  reasons: string[];
}

export interface RoutingDecision {
  schemaVersion: typeof ROUTING_DECISION_VERSION;
  planningDecisionId: string;
  runId: RunId;
  taskId: TaskId;
  classification: WorkClassification;
  consideredRoutes: ConsideredRoute[];
  selected: {
    adapter: RouteCandidate["adapter"];
    provider: string;
    model: string;
    family: RouteFamily;
    reasoning?: string;
  };
  selectionReason: string;
  fallbackReason?: string;
  attemptId?: AttemptId;
}

export interface RoutingRequest {
  planningDecision: PlanningDecision;
  classification: WorkClassification;
  candidates: RouteCandidate[];
  requiresShell?: boolean;
}

export interface RoutedPlanning {
  planningDecision: PlanningDecision;
  routingDecision: RoutingDecision;
}

export class RoutedExecutorAdapter implements ExecutorAdapter {
  private readonly adapters = new Map<string, ExecutorAdapter>();
  private readonly attempts = new Map<string, ExecutorAdapter>();
  private selected: ExecutorAdapter | undefined;

  constructor(adapters: readonly ExecutorAdapter[]) {
    for (const adapter of adapters) {
      const name = parseAdapterDescriptor(adapter.probe()).adapter;
      if (this.adapters.has(name)) throw new KerbsFlowError("ADAPTER_DUPLICATE", `multiple executor adapters are registered as ${name}`);
      this.adapters.set(name, adapter);
    }
    if (this.adapters.size === 0) throw new KerbsFlowError("ADAPTER_REQUIRED", "at least one executor adapter is required");
  }

  select(adapter: string): void {
    const selected = this.adapters.get(adapter);
    if (selected === undefined) throw new KerbsFlowError("ROUTE_UNAVAILABLE", `planned executor adapter ${adapter} is not registered`);
    this.selected = selected;
  }

  probe(): AdapterDescriptor {
    return parseAdapterDescriptor(this.requiredSelected().probe());
  }

  start(request: ExecutionRequest): AttemptHandle {
    if (this.attempts.has(request.attemptId)) throw new KerbsFlowError("DUPLICATE_ATTEMPT", `attempt ${request.attemptId} is already bound to an executor adapter`);
    const adapter = this.requiredSelected();
    const handle = adapter.start(request);
    this.attempts.set(request.attemptId, adapter);
    return handle;
  }

  events(handle: AttemptHandle): AsyncIterable<NormalizedEvent> {
    return this.requiredAttempt(handle).events(handle);
  }

  wait(handle: AttemptHandle): Promise<unknown> {
    return this.requiredAttempt(handle).wait(handle);
  }

  cancel(handle: AttemptHandle, reason: string): CancelOutcome {
    const adapter = this.attempts.get(handle.attemptId);
    return adapter === undefined
      ? { outcome: "unknown", summary: "attempt is not bound to a live routed adapter" }
      : adapter.cancel(handle, reason);
  }

  async reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    const local = this.attempts.get(identity.attemptId);
    if (local !== undefined) return local.reconcile(identity);
    const outcomes = await Promise.all([...this.adapters.entries()].map(async ([name, adapter]) => {
      try {
        return { name, result: await adapter.reconcile(identity) };
      } catch (error) {
        return { name, result: { outcome: "unknown" as const, summary: `${name} reconciliation failed: ${error instanceof Error ? error.message : String(error)}` } };
      }
    }));
    const evidence = outcomes.filter(({ result }) => result.outcome === "running" || result.outcome === "terminal");
    const uncertain = outcomes.filter(({ result }) => result.outcome === "unknown");
    if (evidence.length === 1 && uncertain.length === 0) return evidence[0]!.result;
    if (evidence.length === 0 && uncertain.length === 0) {
      return { outcome: "not_found", summary: "no registered executor adapter found the exact attempt identity" };
    }
    return {
      outcome: "unknown",
      summary: `routed reconciliation is ambiguous: ${outcomes.map(({ name, result }) => `${name}=${result.outcome}`).join(", ")}`,
    };
  }

  private requiredSelected(): ExecutorAdapter {
    if (this.selected === undefined) throw new KerbsFlowError("ADAPTER_NOT_SELECTED", "the core must select the planned executor adapter before use");
    return this.selected;
  }

  private requiredAttempt(handle: AttemptHandle): ExecutorAdapter {
    const adapter = this.attempts.get(handle.attemptId);
    if (adapter === undefined) throw new KerbsFlowError("ATTEMPT_HANDLE_MISSING", `attempt ${handle.attemptId} is not bound to a routed executor adapter`);
    return adapter;
  }
}

export class PolicyRouter {
  route(request: RoutingRequest): RoutedPlanning {
    const decision = parsePlanningDecision(request.planningDecision);
    const candidates = request.candidates.map((candidate) => ({ ...candidate, descriptor: parseAdapterDescriptor(candidate.descriptor) }));
    this.assertCandidatePolicy(candidates);
    const considered = candidates.map((candidate) => this.consider(candidate, request.classification, request.requiresShell ?? false));
    const selected = this.select(considered, request.classification);
    if (selected === undefined) {
      throw new KerbsFlowError("ROUTE_UNAVAILABLE", `no Phase 4 route satisfies ${request.classification} work and its required capabilities`);
    }
    const preferredUnavailable = request.classification === "normal"
      ? considered.find((candidate) => candidate.adapter === "opencode" && candidate.family === "muse" && (!candidate.available || !candidate.suitable))
      : undefined;
    const route = {
      adapter: selected.adapter,
      model: selected.model,
      ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
    };
    const routed = parsePlanningDecision({
      ...decision,
      route,
      policyVersion: PHASE4_ROUTING_POLICY,
    });
    return {
      planningDecision: routed,
      routingDecision: {
        schemaVersion: ROUTING_DECISION_VERSION,
        planningDecisionId: decision.decisionId,
        runId: decision.runId,
        taskId: decision.taskId,
        classification: request.classification,
        consideredRoutes: considered,
        selected: {
          adapter: selected.adapter,
          provider: selected.provider,
          model: selected.model,
          family: selected.family,
          ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
        },
        selectionReason: selectionReason(request.classification, selected),
        ...(preferredUnavailable === undefined ? {} : { fallbackReason: preferredUnavailable.reasons.join("; ") }),
      },
    };
  }

  private consider(candidate: RouteCandidate, classification: WorkClassification, requiresShell: boolean): ConsideredRoute {
    const reasons: string[] = [];
    let suitable = true;
    if (!candidate.available) {
      suitable = false;
      reasons.push("candidate capability/readiness probe reports unavailable");
    }
    if (candidate.adapter === "opencode") {
      if (classification !== "normal") {
        suitable = false;
        reasons.push(`${classification} work is not eligible for the Muse/OpenCode route`);
      }
      if (candidate.family !== "muse") {
        suitable = false;
        reasons.push("OpenCode normal route must be a discovered/configured Muse-family candidate");
      }
      if (requiresShell) {
        suitable = false;
        reasons.push("OpenCode Phase 4 denies shell rather than claiming OS sandbox enforcement");
      }
      if (candidate.descriptor.capabilities.filesystemEnforcement === "unavailable" || candidate.descriptor.capabilities.network.workload === "unavailable") {
        suitable = false;
        reasons.push("OpenCode adapter cannot prove the required tool-policy boundary");
      }
    }
    if (candidate.adapter === "codex") {
      if (candidate.descriptor.capabilities.filesystemEnforcement !== "enforced") {
        suitable = false;
        reasons.push("Codex fallback lacks enforced filesystem isolation");
      }
      if (candidate.descriptor.capabilities.network.workload !== "enforced") {
        suitable = false;
        reasons.push("Codex fallback lacks enforced workload-network isolation");
      }
    }
    if (suitable) reasons.push("route satisfies the classified Phase 4 policy and reported capabilities");
    return {
      adapter: candidate.adapter,
      provider: candidate.provider,
      model: candidate.model,
      family: candidate.family,
      ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
      available: candidate.available,
      suitable,
      reasons,
    };
  }

  private select(candidates: ConsideredRoute[], classification: WorkClassification): ConsideredRoute | undefined {
    const eligible = candidates.filter((candidate) => candidate.available && candidate.suitable);
    if (classification === "normal") {
      return eligible.find((candidate) => candidate.adapter === "opencode" && candidate.family === "muse")
        ?? eligible.find((candidate) => candidate.adapter === "codex" && candidate.family === "luna" && candidate.reasoning === "max");
    }
    if (classification === "difficult") {
      return eligible.find((candidate) => candidate.adapter === "codex" && candidate.family === "sol" && candidate.reasoning === "medium")
        ?? eligible.find((candidate) => candidate.adapter === "codex" && candidate.family === "sol" && candidate.reasoning === "high");
    }
    return eligible.find((candidate) => candidate.adapter === "codex" && candidate.family === "sol" && candidate.reasoning === "high");
  }

  private assertCandidatePolicy(candidates: RouteCandidate[]): void {
    for (const candidate of candidates) {
      if (candidate.family === "luna" && candidate.reasoning?.toLowerCase() === "medium") {
        throw new KerbsFlowError("ROUTE_PROHIBITED", "Luna Medium is prohibited by the frozen routing policy");
      }
      if (candidate.model.trim().length === 0 || candidate.provider.trim().length === 0) {
        throw new KerbsFlowError("ROUTE_INVALID", "route candidates require discovered/configured provider and model identifiers");
      }
    }
  }
}

export function assertRoutingDecision(value: RoutingDecision): RoutingDecision {
  if (value.schemaVersion !== ROUTING_DECISION_VERSION) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision version is unsupported");
  if (value.runId.length === 0 || value.taskId.length === 0 || value.planningDecisionId.length === 0) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision identity is incomplete");
  if (value.consideredRoutes.length === 0) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision must record considered routes");
  if (value.selected.family === "luna" && value.selected.reasoning?.toLowerCase() === "medium") throw new KerbsFlowError("ROUTE_PROHIBITED", "Luna Medium cannot be persisted");
  const selected = value.consideredRoutes.find((route) => route.adapter === value.selected.adapter && route.provider === value.selected.provider && route.model === value.selected.model && route.reasoning === value.selected.reasoning);
  if (selected === undefined || !selected.available || !selected.suitable) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "selected route was not recorded as available and suitable");
  return value;
}

function selectionReason(classification: WorkClassification, selected: ConsideredRoute): string {
  if (classification === "normal" && selected.adapter === "opencode") return "normal eligible work prefers the available Muse/OpenCode route";
  if (classification === "normal") return "Muse/OpenCode was unavailable or unsuitable, so the allowed Luna Max fallback was selected";
  if (classification === "difficult") return `difficult integration/debugging selected Codex Sol ${selected.reasoning ?? "configured"}`;
  return "high-impact work requires the Codex Sol High route";
}
