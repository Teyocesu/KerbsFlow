import { createHash } from "node:crypto";

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
import type { AdapterRoutingReadiness, ExecutorAdapter } from "./adapter.js";
import { KerbsFlowError } from "./errors.js";

export const ROUTING_DECISION_VERSION = "kerbsflow.routing-decision/v1" as const;
export const ATTEMPT_ROUTING_VERSION = "kerbsflow.attempt-routing/v1" as const;
export const PHASE4_ROUTING_POLICY = "kerbsflow.phase4-routing/v1";

export type WorkClassification = "normal" | "difficult" | "high_impact";
export type RouteFamily = "muse" | "luna" | "sol";

export interface RouteModelPolicy {
  adapter: "opencode" | "codex";
  provider: string;
  model: string;
  family: RouteFamily;
  reasoning?: string;
}

export interface RegisteredRouteAdapter {
  adapter: RouteModelPolicy["adapter"];
  implementation: ExecutorAdapter;
}

interface RouteCandidate extends RouteModelPolicy {
  available: boolean;
  descriptor?: AdapterDescriptor;
  capabilityHash?: string;
  readinessReason: string;
  discoveryIssues: string[];
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
  adapterVersion?: string;
  capabilityHash?: string;
  readinessReason: string;
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
  capabilitySnapshotHash: string;
  discoveredAt: string;
}

const ROUTING_DISCOVERY_AUTHORITY = Symbol("kerbsflow.routing-discovery-authority");
const DISCOVERED_ROUTES = new WeakSet<object>();

export type RoutingDiscoveryAuthority = {
  candidates: readonly RouteCandidate[];
  capabilitySnapshotHash: string;
  discoveredAt: string;
  readonly [ROUTING_DISCOVERY_AUTHORITY]: true;
};

const ROUTING_DECISION_AUTHORITY = Symbol("kerbsflow.routing-decision-authority");
const TRUSTED_ROUTING_DECISIONS = new WeakSet<object>();

export type TrustedRoutingDecision = RoutingDecision & {
  readonly [ROUTING_DECISION_AUTHORITY]: true;
};

export interface RoutingRequest {
  planningDecision: PlanningDecision;
  classification: WorkClassification;
  discovery: RoutingDiscoveryAuthority;
  requiresShell?: boolean;
}

export interface RoutedPlanning {
  planningDecision: PlanningDecision;
  routingDecision: TrustedRoutingDecision;
}

const ATTEMPT_ROUTING_AUTHORITY = Symbol("kerbsflow.attempt-routing-authority");
const TRUSTED_ATTEMPT_ROUTES = new WeakSet<object>();

export interface AttemptRoutingProvenance {
  schemaVersion: typeof ATTEMPT_ROUTING_VERSION;
  attemptId: AttemptId;
  planningDecisionId: string;
  runId: RunId;
  taskId: TaskId;
  classification: WorkClassification;
  selected: RoutingDecision["selected"];
  selectionReason: string;
  fallbackReason?: string;
  escalationReason?: string;
  capabilitySnapshotHash: string;
  capabilityHash: string;
  discoveredAt: string;
}

export type TrustedAttemptRoutingProvenance = AttemptRoutingProvenance & {
  readonly [ATTEMPT_ROUTING_AUTHORITY]: true;
};

export interface AttemptRoutingBinding {
  provenance: AttemptRoutingProvenance;
  routingDecision: RoutingDecision;
  planningDecision: PlanningDecision;
  preparedDescriptor: AdapterDescriptor;
  attemptId: AttemptId;
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

export class RoutingDiscovery {
  private readonly registrations: readonly RegisteredRouteAdapter[];
  private readonly now: () => string;

  constructor(registrations: readonly RegisteredRouteAdapter[], options: { now?: () => string } = {}) {
    if (registrations.length === 0) throw new KerbsFlowError("ROUTE_DISCOVERY_REQUIRED", "at least one route adapter must be registered for discovery");
    const names = new Set<string>();
    for (const registration of registrations) {
      if (names.has(registration.adapter)) throw new KerbsFlowError("ADAPTER_DUPLICATE", `multiple route adapters are registered as ${registration.adapter}`);
      names.add(registration.adapter);
    }
    this.registrations = [...registrations];
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: { workingDirectory: string; models: readonly RouteModelPolicy[] }): Promise<RoutingDiscoveryAuthority> {
    assertModelPolicy(input.models);
    const discoveredAt = this.now();
    const discovered = new Map<RouteModelPolicy["adapter"], { descriptor?: AdapterDescriptor; readiness?: AdapterRoutingReadiness; issue?: string }>();
    for (const registration of this.registrations) {
      try {
        const descriptor = parseAdapterDescriptor(registration.implementation.probe());
        if (descriptor.adapter !== registration.adapter) {
          throw new KerbsFlowError("ADAPTER_IDENTITY_MISMATCH", `registered ${registration.adapter} adapter reported itself as ${descriptor.adapter}`);
        }
        let readiness: AdapterRoutingReadiness | undefined;
        if (registration.adapter === "opencode") {
          if (registration.implementation.routingReadiness === undefined) {
            discovered.set(registration.adapter, { descriptor, issue: "OpenCode adapter does not expose authoritative routing readiness" });
            continue;
          }
          readiness = await registration.implementation.routingReadiness(input.workingDirectory);
        }
        discovered.set(registration.adapter, { descriptor, ...(readiness === undefined ? {} : { readiness }) });
      } catch (error) {
        if (error instanceof KerbsFlowError && error.code === "ADAPTER_IDENTITY_MISMATCH") throw error;
        discovered.set(registration.adapter, { issue: `capability/readiness probe failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    const candidates = input.models.map((model): RouteCandidate => {
      const actual = discovered.get(model.adapter);
      const issues: string[] = [];
      if (actual === undefined) issues.push(`no ${model.adapter} adapter is registered`);
      if (actual?.issue !== undefined) issues.push(actual.issue);
      if (actual?.descriptor !== undefined && model.adapter === "codex" && actual.descriptor.provider !== model.provider) {
        issues.push(`Codex provider ${model.provider} does not match probed provider ${actual.descriptor.provider}`);
      }
      if (actual?.descriptor !== undefined && model.adapter === "codex" && model.reasoning !== undefined && !actual.descriptor.capabilities.reasoningEffort.includes(model.reasoning)) {
        issues.push(`Codex reasoning ${model.reasoning} is not reported by the probed adapter`);
      }
      let readinessReason = actual?.issue ?? "adapter probe succeeded";
      if (model.adapter === "opencode" && actual?.readiness !== undefined) {
        const match = actual.readiness.models.find((entry) => entry.provider === model.provider && (entry.model === model.model || entry.aliases.includes(model.model)));
        if (!actual.readiness.ready) issues.push(actual.readiness.reason || "OpenCode readiness probe reported unavailable");
        if (match === undefined) issues.push(`configured OpenCode model ${model.provider}/${model.model} was not discovered`);
        if (match !== undefined && model.reasoning !== undefined && !match.reasoning.includes(model.reasoning)) {
          issues.push(`configured reasoning ${model.reasoning} was not reported for ${model.provider}/${model.model}`);
        }
        readinessReason = actual.readiness.reason;
      }
      const capabilityHash = actual?.descriptor === undefined ? undefined : adapterCapabilityHash(actual.descriptor);
      return deepFreeze({
        ...model,
        available: issues.length === 0 && actual?.descriptor !== undefined,
        ...(actual?.descriptor === undefined ? {} : { descriptor: actual.descriptor }),
        ...(capabilityHash === undefined ? {} : { capabilityHash }),
        readinessReason,
        discoveryIssues: issues,
      });
    });
    const capabilitySnapshotHash = sha256(stableJson(candidates.map(({ descriptor, ...candidate }) => ({ ...candidate, descriptor }))));
    const authority = deepFreeze({
      candidates,
      capabilitySnapshotHash,
      discoveredAt,
      [ROUTING_DISCOVERY_AUTHORITY]: true as const,
    });
    DISCOVERED_ROUTES.add(authority);
    return authority;
  }
}

export class PolicyRouter {
  route(request: RoutingRequest): RoutedPlanning {
    const decision = parsePlanningDecision(request.planningDecision);
    const discovery = assertRoutingDiscoveryAuthority(request.discovery);
    const candidates = [...discovery.candidates];
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
      routingDecision: createTrustedRoutingDecision({
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
        capabilitySnapshotHash: discovery.capabilitySnapshotHash,
        discoveredAt: discovery.discoveredAt,
      }),
    };
  }

  private consider(candidate: RouteCandidate, classification: WorkClassification, requiresShell: boolean): ConsideredRoute {
    const reasons: string[] = [];
    let suitable = true;
    if (!candidate.available) {
      suitable = false;
      reasons.push(...(candidate.discoveryIssues.length === 0 ? ["candidate capability/readiness probe reports unavailable"] : candidate.discoveryIssues));
    }
    const descriptor = candidate.descriptor;
    if (descriptor === undefined) {
      suitable = false;
      reasons.push("no validated adapter capability descriptor is available");
    } else {
      const issues = capabilityIssues(candidate.adapter, descriptor);
      reasons.push(...issues);
      if (issues.length > 0) suitable = false;
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
      ...(descriptor === undefined ? {} : { adapterVersion: descriptor.adapterVersion }),
      ...(candidate.capabilityHash === undefined ? {} : { capabilityHash: candidate.capabilityHash }),
      readinessReason: candidate.readinessReason,
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

}

export function assertRoutingDecision(value: RoutingDecision): RoutingDecision {
  if (value.schemaVersion !== ROUTING_DECISION_VERSION) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision version is unsupported");
  if (value.runId.length === 0 || value.taskId.length === 0 || value.planningDecisionId.length === 0) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision identity is incomplete");
  if (value.capabilitySnapshotHash.length === 0 || value.discoveredAt.length === 0) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing discovery provenance is incomplete");
  if (value.consideredRoutes.length === 0) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "routing decision must record considered routes");
  if (value.selected.family === "luna" && value.selected.reasoning?.toLowerCase() === "medium") throw new KerbsFlowError("ROUTE_PROHIBITED", "Luna Medium cannot be persisted");
  const selected = value.consideredRoutes.find((route) => route.adapter === value.selected.adapter && route.provider === value.selected.provider && route.model === value.selected.model && route.reasoning === value.selected.reasoning);
  if (selected === undefined || !selected.available || !selected.suitable) throw new KerbsFlowError("ROUTING_DECISION_INVALID", "selected route was not recorded as available and suitable");
  return value;
}

export function assertTrustedRoutingDecision(value: RoutingDecision): TrustedRoutingDecision {
  assertRoutingDecision(value);
  if (!TRUSTED_ROUTING_DECISIONS.has(value)) throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "routing decisions must originate from authoritative live discovery and policy routing");
  return value as TrustedRoutingDecision;
}

export function createAttemptRoutingProvenance(input: {
  routingDecision: TrustedRoutingDecision;
  planningDecision: PlanningDecision;
  attemptId: AttemptId;
  selectionReason: string;
  escalationReason?: string;
}): TrustedAttemptRoutingProvenance {
  const routing = assertTrustedRoutingDecision(input.routingDecision);
  const planning = parsePlanningDecision(input.planningDecision);
  if (planning.decisionId !== routing.planningDecisionId || planning.runId !== routing.runId || planning.taskId !== routing.taskId) {
    throw new KerbsFlowError("ATTEMPT_ROUTING_INVALID", "attempt routing identity does not match the trusted routing decision");
  }
  const selected = routing.consideredRoutes.find((candidate) => candidate.adapter === planning.route.adapter && candidate.model === planning.route.model && candidate.reasoning === planning.route.reasoning);
  if (selected === undefined || !selected.available || !selected.suitable || selected.capabilityHash === undefined) {
    throw new KerbsFlowError("ATTEMPT_ROUTING_INVALID", "the attempt route is not an available and suitable route in the trusted discovery snapshot");
  }
  const provenance = deepFreeze({
    schemaVersion: ATTEMPT_ROUTING_VERSION,
    attemptId: input.attemptId,
    planningDecisionId: routing.planningDecisionId,
    runId: routing.runId,
    taskId: routing.taskId,
    classification: routing.classification,
    selected: {
      adapter: selected.adapter,
      provider: selected.provider,
      model: selected.model,
      family: selected.family,
      ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
    },
    selectionReason: input.selectionReason,
    ...(routing.fallbackReason === undefined ? {} : { fallbackReason: routing.fallbackReason }),
    ...(input.escalationReason === undefined ? {} : { escalationReason: input.escalationReason }),
    capabilitySnapshotHash: routing.capabilitySnapshotHash,
    capabilityHash: selected.capabilityHash,
    discoveredAt: routing.discoveredAt,
    [ATTEMPT_ROUTING_AUTHORITY]: true as const,
  });
  assertAttemptRoutingProvenance(provenance);
  TRUSTED_ATTEMPT_ROUTES.add(provenance);
  return provenance;
}

export function assertAttemptRoutingProvenance(value: AttemptRoutingProvenance): AttemptRoutingProvenance {
  if (value.schemaVersion !== ATTEMPT_ROUTING_VERSION) throw new KerbsFlowError("ATTEMPT_ROUTING_INVALID", "attempt routing provenance version is unsupported");
  if ([value.attemptId, value.planningDecisionId, value.runId, value.taskId, value.selectionReason, value.capabilitySnapshotHash, value.capabilityHash, value.discoveredAt].some((part) => part.length === 0)) {
    throw new KerbsFlowError("ATTEMPT_ROUTING_INVALID", "attempt routing provenance is incomplete");
  }
  if (value.selected.family === "luna" && value.selected.reasoning?.toLowerCase() === "medium") throw new KerbsFlowError("ROUTE_PROHIBITED", "Luna Medium cannot be persisted");
  return value;
}

export function assertTrustedAttemptRoutingProvenance(value: AttemptRoutingProvenance): TrustedAttemptRoutingProvenance {
  assertAttemptRoutingProvenance(value);
  if (!TRUSTED_ATTEMPT_ROUTES.has(value)) throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "attempt routing provenance must originate from a trusted routing decision");
  return value as TrustedAttemptRoutingProvenance;
}

export function adapterCapabilityHash(value: AdapterDescriptor): string {
  return sha256(stableJson(parseAdapterDescriptor(value)));
}

export function assertAttemptRoutingBinding(input: AttemptRoutingBinding): AttemptRoutingProvenance {
  const provenance = assertAttemptRoutingProvenance(input.provenance);
  const routing = assertRoutingDecision(input.routingDecision);
  const planning = parsePlanningDecision(input.planningDecision);
  const descriptor = parseAdapterDescriptor(input.preparedDescriptor);
  if (
    provenance.attemptId !== input.attemptId
    || provenance.runId !== planning.runId
    || provenance.taskId !== planning.taskId
    || provenance.planningDecisionId !== planning.decisionId
    || routing.runId !== planning.runId
    || routing.taskId !== planning.taskId
    || routing.planningDecisionId !== planning.decisionId
  ) {
    throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "attempt routing authority does not match the prepared attempt and persisted planning scope");
  }
  if (
    provenance.selected.adapter !== planning.route.adapter
    || provenance.selected.model !== planning.route.model
    || provenance.selected.reasoning !== planning.route.reasoning
  ) {
    throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "attempt routing authority does not match the persisted planning route");
  }
  if (provenance.capabilitySnapshotHash !== routing.capabilitySnapshotHash || provenance.discoveredAt !== routing.discoveredAt) {
    throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "attempt routing authority does not match the persisted discovery snapshot");
  }
  const candidate = routing.consideredRoutes.find((route) => (
    route.adapter === provenance.selected.adapter
    && route.provider === provenance.selected.provider
    && route.model === provenance.selected.model
    && route.family === provenance.selected.family
    && route.reasoning === provenance.selected.reasoning
  ));
  if (candidate === undefined || !candidate.available || !candidate.suitable || candidate.capabilityHash !== provenance.capabilityHash) {
    throw new KerbsFlowError("ROUTING_CAPABILITY_MISMATCH", "attempt route is not backed by the authoritative capability snapshot");
  }
  if (descriptor.adapter !== provenance.selected.adapter || adapterCapabilityHash(descriptor) !== provenance.capabilityHash) {
    throw new KerbsFlowError("ROUTING_CAPABILITY_MISMATCH", "prepared adapter descriptor does not match the authoritative capability snapshot");
  }
  return provenance;
}

export function assertRoutingDiscoveryAuthority(value: RoutingDiscoveryAuthority): RoutingDiscoveryAuthority {
  if (!DISCOVERED_ROUTES.has(value)) throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "route candidates must originate from authoritative live adapter discovery");
  return value;
}

function selectionReason(classification: WorkClassification, selected: ConsideredRoute): string {
  if (classification === "normal" && selected.adapter === "opencode") return "normal eligible work prefers the available Muse/OpenCode route";
  if (classification === "normal") return "Muse/OpenCode was unavailable or unsuitable, so the allowed Luna Max fallback was selected";
  if (classification === "difficult") return `difficult integration/debugging selected Codex Sol ${selected.reasoning ?? "configured"}`;
  return "high-impact work requires the Codex Sol High route";
}

function createTrustedRoutingDecision(value: RoutingDecision): TrustedRoutingDecision {
  const decision = deepFreeze({ ...assertRoutingDecision(value), [ROUTING_DECISION_AUTHORITY]: true as const });
  TRUSTED_ROUTING_DECISIONS.add(decision);
  return decision;
}

function assertModelPolicy(models: readonly RouteModelPolicy[]): void {
  if (models.length === 0) throw new KerbsFlowError("ROUTE_INVALID", "at least one configured route model is required");
  const identities = new Set<string>();
  for (const model of models) {
    if (model.family === "luna" && model.reasoning?.toLowerCase() === "medium") throw new KerbsFlowError("ROUTE_PROHIBITED", "Luna Medium is prohibited by the frozen routing policy");
    if (model.model.trim().length === 0 || model.provider.trim().length === 0) throw new KerbsFlowError("ROUTE_INVALID", "route models require provider and model identifiers");
    const identity = `${model.adapter}\0${model.provider}\0${model.model}\0${model.reasoning ?? ""}`;
    if (identities.has(identity)) throw new KerbsFlowError("ROUTE_INVALID", `duplicate route model ${model.adapter}/${model.model}/${model.reasoning ?? "default"}`);
    identities.add(identity);
  }
}

function capabilityIssues(adapter: RouteModelPolicy["adapter"], descriptor: AdapterDescriptor): string[] {
  const issues: string[] = [];
  if (!descriptor.capabilities.modelSelection) issues.push("adapter lacks authoritative model selection");
  if (!descriptor.capabilities.resumableSession) issues.push("adapter lacks resumable-session support");
  if (!descriptor.capabilities.healthProbe) issues.push("adapter lacks a health probe");
  if (descriptor.capabilities.network.providerControlPlane !== "provider_owned") issues.push("provider control-plane network is not provider-owned");
  if (adapter === "opencode") {
    if (descriptor.capabilities.eventTransport !== "async_iterable") issues.push("OpenCode event transport is not async_iterable");
    if (descriptor.capabilities.cancellation !== "native") issues.push("OpenCode cancellation is not native");
    if (!descriptor.capabilities.agentSelection) issues.push("OpenCode lacks agent selection");
    if (descriptor.capabilities.filesystemEnforcement === "unavailable") issues.push("OpenCode cannot prove the required tool-policy filesystem boundary");
    if (descriptor.capabilities.network.workload === "unavailable") issues.push("OpenCode cannot prove the required tool-policy network boundary");
  } else {
    if (descriptor.capabilities.eventTransport !== "jsonl") issues.push("Codex event transport is not jsonl");
    if (!descriptor.capabilities.finalJsonSchema) issues.push("Codex lacks final JSON schema enforcement");
    if (descriptor.capabilities.cancellation !== "process_only") issues.push("Codex cancellation is not process_only");
    if (descriptor.capabilities.filesystemEnforcement !== "enforced") issues.push("Codex fallback lacks enforced filesystem isolation");
    if (descriptor.capabilities.network.workload !== "enforced") issues.push("Codex fallback lacks enforced workload-network isolation");
  }
  return issues;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
