# KerbsFlow v0.1.0 product and architecture specification

Status: **Phase 0 approved and frozen for implementation**

Date: 2026-09-21

Audience: implementers, reviewers, and the human operator

This document is the canonical product and architecture contract for KerbsFlow v0.1. It defines what may be implemented; it does not authorize a material product, architecture, security, compatibility, or scope change. Such a change requires this SPEC to be updated and approved through a human gate.

## 1. Product definition

### 1.1 Name and problem

KerbsFlow is a local control plane for planning, orchestrating, verifying, reviewing, and supervising AI coding agents.

Today, a human repeatedly transports a plan between a planning model and a coding agent, copies results back for review, chooses the next prompt, watches for loops, and decides when validation is sufficient. KerbsFlow automates the unambiguous parts of that loop while preserving human authority over product intent, architecture, security, compatibility, scope, credentials, destructive operations, merge, release, and production.

KerbsFlow is not a foundation model, autonomous software company, multi-agent swarm, or generic workflow engine. It coordinates one implementation executor at a time and optimizes for correct work per unit of compute and quota, not maximum concurrency or minimum tokens at any cost.

### 1.2 Target user

The v0.1 user is a single developer operating on repositories available on one local machine. The user understands Git and can review a diff and a structured human gate, but should not need to copy prompts or babysit routine execution.

### 1.3 Minimum user experience

A user can:

1. register a local Git repository and submit a development objective;
2. see the canonical AGENTS, SPEC, PLAN, and HANDOFF context that will govern the run;
3. let the Planning Master choose one next action within approved scope;
4. route that action to one capable executor;
5. observe normalized progress and a structured terminal result;
6. receive independent evidence about the diff, scope, invariants, and validation;
7. have KerbsFlow continue, rework, escalate, request a meaningful human decision, or close a phase;
8. restart KerbsFlow without losing the run or accidentally repeating an ambiguous action; and
9. pause, resume, inspect, steer, or cancel through a thin local interface.

Routine reads, worktree edits, focused checks, diff/status inspection, one clearly diagnosed rework, canonical PLAN/HANDOFF maintenance, and movement to an already-approved next phase do not require approval.

## 2. Goals, non-goals, and scope

### 2.1 v0.1 goals

- Prove one reliable local plan -> execute -> verify -> review -> continue/gate/done loop.
- Keep the Planning Master in control of legal transitions, scope, routing, and validation level.
- Integrate Codex and OpenCode behind capability-aware adapter boundaries.
- Persist sufficient operational state for inspection and conservative crash recovery.
- Isolate implementation work in KerbsFlow-owned Git worktrees.
- Independently verify executor claims with local evidence and anti-greenwashing checks.
- Expose current state and meaningful decisions through a headless core and thin local UI.
- Be safe to develop in a public open-source repository.

### 2.2 Non-goals and explicit out-of-scope

The following are not in v0.1:

- multiple users, multiple concurrent implementation executors, distributed workers, cloud backend, microservices, or a message broker;
- agent swarms, autonomous software-company behavior, or maximizing parallel agents;
- vector databases, embeddings, RAG, custom model training, or long-term prompt archives;
- a generic workflow/policy DSL, generic agent framework, or general plugin system;
- Jev, Laya, Kev, or any learned/local System-One router;
- autonomous commit, push, merge, tag, release, deployment, or production access;
- remote GitHub/CI orchestration as a prerequisite for the core loop;
- copied executor credentials, a KerbsFlow credential vault, or secret persistence;
- automatic architectural, licensing, product, compatibility, or security-boundary decisions;
- a frontend framework decision beyond the minimal UI protocol;
- event sourcing; the transition journal is an audit/recovery aid, not the source of all reconstructed state;
- guaranteed OS-level filesystem or network isolation on platforms/providers that cannot enforce it;
- indefinitely retained raw prompts, transcripts, source snapshots, or unredacted logs.

### 2.3 v0.1 operating constraints

- Local-only and single-user.
- One active repository implementation task and one active implementation executor at a time.
- TypeScript control plane on the approved Node.js 24 LTS runtime baseline.
- SQLite operational state, canonical Markdown repository state, and per-run filesystem artifacts.
- KerbsFlow-owned worktree per run.
- Headless orchestration core; UI is a client.
- No ORM unless Phase 1 supplies measured evidence that direct SQL and a small repository layer are inadequate.

## 3. Architecture decisions

| Concern | Direction | Reason | Rejected alternative / residual risk |
| --- | --- | --- | --- |
| Runtime | TypeScript on Node.js 24 LTS | Shared language with the OpenCode SDK, strong process/stream support, broad contributor familiarity, and a thin type-safe core. Node 20 is EOL and Node 26 was still Current rather than LTS on the Phase 0 date. | Python/Rust add no demonstrated v0.1 advantage. Supporting every Node line is out of scope. TypeScript types do not replace runtime validation. |
| Topology | One local process owns orchestration and SQLite; embedded executor resources and external child processes are explicitly owned/supervised | Matches the single-user/single-executor constraint and minimizes coordination failure modes. | No distributed workers or microservices. A process crash remains a recovery event. |
| State | Current rows plus append-only transition records in SQLite | Atomic current state plus audit/reconciliation evidence without full event sourcing. | Full event sourcing is unnecessary ceremony. Filesystem/DB atomicity still needs conservative reconciliation. |
| SQLite mode | One writer/connection owner; default rollback journal initially; explicit transactions and durable settings | UI and core share one process, so WAL concurrency is unnecessary initially. SQLite's default rollback journal is atomic; WAL adds checkpoint and sidecar-file lifecycle. | Re-evaluate WAL only if measured concurrent readers justify it. WAL still permits only one writer and requires same-host shared memory. |
| Executor strategy | Hybrid: Codex CLI subprocess; preferred OpenCode V2 embedded host through `@opencode/sdk` | Uses the smallest mature programmable interface each provider offers. OpenCode calls route in memory without a listener/network hop. | A KerbsFlow-owned loopback server/client or `opencode run` is capability/version fallback only. Provider version drift is handled by probing and contract tests. |
| Progress | Event-driven streams where supported; bounded polling only for health/recovery/fallback | JSONL, `AsyncIterable`, SSE fallback, and stdout/stderr provide progress without making transport a core lifecycle concern. | Polling as the primary mechanism is noisier and slower; dropped events require snapshot reconciliation. |
| Worktrees | KerbsFlow creates, locks, owns, reconciles, and removes linked worktrees | Gives deterministic base/diff scope independent of executor behavior. | Executor-owned worktrees couple isolation to provider semantics. A worktree is not itself a security sandbox. |
| UI boundary | Versioned loopback HTTP/JSON commands plus server-sent state events | Simple, inspectable, headless-friendly, and adequate for one-way progress plus request/response actions. | WebSockets and frontend-framework coupling add no v0.1 value. |
| Contracts | Version discriminator on every persisted/interchange contract; additive-compatible within v1 | Allows migration and adapter evolution without modeling hypothetical providers. | Unversioned free-form output is too fragile. |
| Authority | Model output proposes; deterministic core validates policy and changes state | Protects SPEC, gates, and legal transitions from prompt/model drift. | An LLM is not the final authorization mechanism. |
| Review | Deterministic local evidence plus an edit-disabled independent review session where judgment is needed | Executor self-report is evidence, not proof. | Reusing the implementation session as sole reviewer violates independence. Different model/vendor is desirable for high risk, not mandatory for every task. |
| Configuration | Typed layered objects, not a DSL | Separates invariants from policy while remaining inspectable. | Generic policy languages are deferred. |

The Node.js 24 LTS baseline is an approved Phase 0 decision. Official release status on 2026-09-21 lists Node 24 as LTS, Node 20 as EOL, and Node 26 as Current ([Node.js releases](https://nodejs.org/en/about/previous-releases)).

SQLite supports atomic transactions through crashes; WAL mainly improves reader/writer concurrency and introduces checkpointing and `-wal`/`-shm` artifacts. The v0.1 single-process owner therefore starts with rollback journaling and revisits WAL only with evidence ([SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), [SQLite WAL](https://www.sqlite.org/wal.html)).

## 4. Major components and responsibilities

### 4.1 Headless orchestration core

The core is an application service that contains no UI code and can run deterministically with fake adapters and temporary repositories. It owns command validation, state transitions, idempotency keys, sequencing, and read models for the UI.

Only the core may commit a run-state transition. Adapters, model responses, verifier output, and UI actions are inputs to the core, not direct state writers.

### 4.2 Planning Master

The Planning Master is the control authority for a run. It:

- loads the canonical context and verifies its identity/hash;
- protects SPEC, scope, invariants, acceptance criteria, and security gates;
- chooses one next action and required validation level;
- selects a route from policy and observed adapter capabilities;
- selects only relevant skills;
- validates structured executor/verifier results;
- classifies failures, retries, rework, and escalation;
- decides when a phase can close or final verification may begin; and
- creates a structured human gate when safe continuation is not unambiguous.

A capable model may produce a typed `PlanningDecision`, especially for difficult work, but that output is advisory. The deterministic core rejects illegal transitions, unsupported capabilities, out-of-policy permissions, stale canonical hashes, or attempts to bypass a gate. The Planning Master does not implement production changes in v0.1.

### 4.3 Adapter registry and executor adapters

The registry probes installed versions and capabilities, resolves a policy route to an available adapter, and refuses unsupported combinations. It contains only Codex and OpenCode in v0.1.

Adapters own provider-specific launch, normalized events, final-result extraction, cancellation, session identifiers, and recovery probes. They do not decide product scope, mark phases complete, or declare verified success.

### 4.4 Process supervisor

The supervisor starts child processes without a shell, records their identity, captures bounded/redacted streams, manages process groups, enforces timeouts, and performs graceful-then-forced cancellation. It never treats exit code zero as proof of correctness.

### 4.5 Worktree manager

The worktree manager captures the exact base OID, creates and locks a linked worktree and KerbsFlow-owned branch, records its path/branch, computes diffs, reconciles abandoned worktrees, and removes only clean/disposable worktrees under the cleanup policy.

### 4.6 Verifier/reviewer

The verifier is edit-disabled by default. It gathers authoritative local facts and labels evidence. It:

- obtains `git status`, base/head, changed paths, diff, and untracked files directly;
- compares changes with approved scope and negative scope;
- runs Planning-Master-selected focused, phase, or full checks through a controlled command runner;
- checks exit status and meaningful expected output/artifacts;
- detects weakened tests/checks and suspicious success paths;
- records disagreements with executor claims; and
- requests independent model review in a fresh session when semantic judgment is warranted.

It may not weaken or rewrite the validation plan to obtain green. Review sessions receive read-only permissions unless a distinct, approved rework attempt is created.

Verification commands run through a KerbsFlow-owned `VerificationSandbox` boundary. For officially supported v0.1 on macOS, `/usr/bin/sandbox-exec` (Seatbelt) is the required, release-critical backend. Its adversarial capability probe must establish that the assigned worktree is read-only, only a private KerbsFlow scratch root is writable, credentials and protected environment files cannot be read, unauthorized host writes are denied or confined, workload network access is denied, descendants remain restricted, and cleanup fails closed. Missing, insecure, or adversarially unproven enforcement makes verification unavailable and requires a human gate, with no unrestricted fallback.

Linux Bubblewrap may remain implemented as unsupported preview/best-effort behavior. Linux has no v0.1 compatibility guarantee, is outside the official v0.1 support matrix, and is not a Phase 5 or Phase 7 exit requirement. Whenever the Linux path is invoked, its existing capability checks and fail-closed behavior still apply; it must not fall back to unrestricted execution. Bubblewrap must be upstream 0.12.0 or newer, or have explicit trusted evidence of the CVE-2026-87766 fix in a backport; version presence alone is insufficient. Linux may be promoted in a future release after its own real-host validation. The sandbox capability record contains only backend/platform/version and probe evidence, never credentials. This does not add a sandbox framework or container/VM product architecture.

### 4.7 State and artifact stores

The state store owns SQL transactions, migrations, and current state. The artifact store owns immutable or append-only per-attempt evidence files outside the managed repository. SQLite stores metadata and references, not large logs or repository copies.

### 4.8 Local API and UI

The API projects persisted state and accepts idempotent commands. The UI renders that projection and cannot bypass the core. The UI shows project, run/state/phase, current task, executor/model, SPEC/scope/invariant status, validation levels, retries/escalations, recent activity, and any human gate. Actions are Pause, Resume, Inspect, Steer, and Cancel.

## 5. Trust and authority boundaries

1. **Human -> KerbsFlow:** The human supplies intent and approvals. UI input is untrusted and schema/size validated. The human retains authority over material decisions and release actions.
2. **Canonical repository -> Planning Master:** Markdown may contain stale or malicious text. Only the designated canonical files have authority, and user/repository rules cannot override hard product safety invariants. Content hashes detect mid-run changes.
3. **Planning model -> core:** A planning model proposes typed actions. It cannot authorize itself, edit state directly, or relax gates.
4. **Core -> executor:** Prompts, scope, permissions, model, and worktree are bounded. The executor may be an embedded owned host or a supervised child; transport does not change core authority. Executor output and files are untrusted until independently inspected.
5. **Executor -> host/providers:** The executor may invoke tools, process untrusted repository content, and use provider-owned inference/auth connections. Provider sandbox plus OS controls enforce what the workload can actually do; a worktree alone only isolates Git changes.
6. **Verifier -> run:** The verifier is independent of the implementation session and edit-disabled. It can fail or gate a run but cannot silently change the SPEC.
7. **UI transport -> loopback:** A malicious local webpage can target the KerbsFlow UI API. Bind it to loopback, reject unexpected `Origin`, disable permissive CORS, and require a per-launch high-entropy bearer/capability token for mutation and event access. The preferred embedded OpenCode adapter opens no local listener; any loopback fallback is a separately capability-gated surface.
8. **Artifacts/logs -> disk:** Repository text and tool output can contain secrets. Redaction, permissions, retention, and out-of-repo storage apply before persistence.

## 6. Run state machine

### 6.1 States

| State | Meaning |
| --- | --- |
| `IDLE` | No active run; repository may be registered. |
| `INTAKE` | Objective, repository identity, canonical files, base ref, and policy are being validated. |
| `PLAN` | Planning Master is producing/validating the next bounded action. |
| `READY` | A valid action, route, permissions, and validation intent are persisted and may be dispatched. |
| `EXECUTE` | One implementation attempt is prepared or running. |
| `VERIFY_FOCUSED` | Smallest meaningful independent validation and diff inspection are running. |
| `REVIEW` | Evidence is classified and the next state is decided. |
| `REWORK` | A bounded correction prompt/route is being prepared from a diagnosed failure. |
| `VERIFY_PHASE` | Phase/subsystem acceptance is being validated. |
| `NEXT_PHASE` | Completed phase is recorded and canonical PLAN/HANDOFF update is prepared. |
| `FINAL_VERIFY` | Full v0.1/release-readiness gate is running. |
| `HUMAN_GATE` | Safe continuation requires an explicit human decision. |
| `HUMAN_RELEASE_GATE` | Implementation is verified enough for a human merge/release decision; KerbsFlow does not perform it. |
| `PAUSED` | No new work may start; the core has persisted the originating boundary and one policy-valid actual-state `resumeTarget`. |
| `RECOVERY` | Startup or crash reconciliation is determining what actually happened. |
| `FAILED` | Terminal failure with no safe automatic next action. |
| `CANCELLED` | Terminal user/policy cancellation after adapter operation/resource reconciliation. |
| `DONE` | Terminal run completion after the human release/closure decision is recorded. |

### 6.2 Legal transitions

| From | To | Trigger / authority |
| --- | --- | --- |
| `IDLE` | `INTAKE` | Human starts a run; core creates it atomically. |
| `INTAKE` | `PLAN` | Core validates repo, base, canonical context, and policy. |
| `INTAKE` | `HUMAN_GATE`, `FAILED` | Ambiguous/unsafe input or unrecoverable environment failure. |
| `PLAN` | `READY` | Planning decision passes deterministic policy and capability checks. |
| `PLAN` | `HUMAN_GATE`, `FAILED` | Material ambiguity/gate or terminal planning/tool failure. |
| `READY` | `EXECUTE` | Dispatcher claims the single executor slot using a unique attempt ID. |
| `READY` | `PLAN`, `HUMAN_GATE` | Route becomes unavailable or policy/canonical context changes. |
| `EXECUTE` | `VERIFY_FOCUSED` | Attempt is terminal and has evidence/claims to assess. |
| `EXECUTE` | `HUMAN_GATE` | Executor requests a material permission or a prohibited action is required. |
| `EXECUTE` | `RECOVERY` | Process/adapter/orchestrator outcome is uncertain. |
| `VERIFY_FOCUSED` | `REVIEW` | Focused evidence bundle is persisted, including failures. |
| `VERIFY_FOCUSED` | `HUMAN_GATE` | Required verification sandbox is unavailable or fails its adversarial probe. |
| `VERIFY_FOCUSED` | `RECOVERY` | Verifier process outcome is uncertain. |
| `REVIEW` | `REWORK` | Failure is clear, within scope, retry budget remains, and rework is safe. |
| `REVIEW` | `VERIFY_PHASE` | Action passes and phase-level acceptance is required. |
| `REVIEW` | `NEXT_PHASE` | Action/phase passes and no additional phase check is required. |
| `REVIEW` | `FINAL_VERIFY` | All implementation phases are complete. |
| `REVIEW` | `HUMAN_GATE`, `FAILED` | Ambiguity/high impact/repeated failure or unrecoverable result. |
| `REWORK` | `READY` | Corrected action and route pass policy checks. |
| `REWORK` | `HUMAN_GATE`, `FAILED` | Rework cannot remain bounded or budget is exhausted. |
| `VERIFY_PHASE` | `NEXT_PHASE`, `REWORK`, `HUMAN_GATE`, `FAILED` | Verifier result and retry policy. |
| `NEXT_PHASE` | `PLAN`, `FINAL_VERIFY` | Persisted phase update shows another phase or all phases complete. |
| `FINAL_VERIFY` | `HUMAN_RELEASE_GATE`, `REWORK`, `HUMAN_GATE`, `FAILED` | Full-gate result and policy. |
| `HUMAN_RELEASE_GATE` | `DONE` | Human records closure/merge/release decision. No Git remote action is implied. |
| `HUMAN_RELEASE_GATE` | `REWORK`, `CANCELLED` | Human requests changes or cancels. |
| `HUMAN_GATE` | `PLAN`, `READY`, `REWORK`, `FINAL_VERIFY`, `FAILED`, `CANCELLED` | Human chooses an offered, policy-valid resolution. |
| `RECOVERY` | `EXECUTE`, `VERIFY_FOCUSED`, `REVIEW`, `READY`, `HUMAN_GATE`, `FAILED`, `CANCELLED` | Reconciler proves the correct outcome; ambiguous non-idempotent work goes to a gate. |
| `PAUSED` | `INTAKE`, `PLAN`, `READY`, `VERIFY_FOCUSED`, `REVIEW`, `REWORK`, `VERIFY_PHASE`, `NEXT_PHASE`, `FINAL_VERIFY`, `HUMAN_GATE`, `HUMAN_RELEASE_GATE`, `RECOVERY` | Human resumes only to the persisted `resumeTarget`; the core rejects any stale, different, or currently invalid target without changing state. Direct resume to `EXECUTE` is prohibited in v0.1. |
| any active nonterminal state except `IDLE` and `PAUSED` | `PAUSED` | Human requests pause; core reaches a quiescent point and persists the validated resume contract first. |
| any active nonterminal state except `IDLE` | `CANCELLED` | Human cancels; active adapter operations/resources and any children are stopped/reconciled before terminal commit. |

There are no other legal transitions. Terminal states do not transition. An invalid or stale command is rejected with a typed conflict, recorded as an operational diagnostic, and leaves current state unchanged.

### 6.3 Transition record

Every accepted transition persists in one SQLite transaction:

- transition ID and run ID;
- `from`, `to`, and reason code;
- actor (`human`, `core`, `planner`, `adapter`, `verifier`, `recovery`);
- causation/command ID and idempotency key;
- related phase/task/attempt/gate IDs when present;
- canonical context hash and policy version used for the decision;
- timestamp; and
- a small versioned payload or artifact reference.

The transaction updates the run's current state/version and inserts the transition. Commands use optimistic state-version comparison so duplicate or out-of-order requests cannot double-transition.

### 6.4 Pause, resume, and cancellation semantics

Pause means “start nothing new and quiesce current work,” not suspend an arbitrary process image. Before committing `PAUSED`, the core persists `originState`, the last durable workflow/check boundary, and exactly one `resumeTarget` selected by policy. The user/UI cannot provide or override that target.

The core may set `resumeTarget` to the originating workflow state only when no executor/provider/verifier/process operation is in flight, the boundary is fully persisted, and continuing that state is directly safe. If any outcome or side effect may be uncertain, `resumeTarget` must be `RECOVERY`. Pausing from `EXECUTE` always targets `RECOVERY` in v0.1 because arbitrary process suspension/resumption is unsupported. The core validates that the target is one of the actual states listed in the `PAUSED` transition row before atomically committing the pause.

Resume accepts the pause command/idempotency identity and expected state version, never a target. It transitions only to the persisted target after re-validating current policy and context. Duplicate, stale, missing-target, mismatched-target, or no-longer-legal resume attempts return a typed conflict and leave `PAUSED` unchanged.

Cancel is terminal and idempotent, including from `PAUSED`. The core first persists `cancel_requested` and invokes provider-native/request abort where available. For an embedded owned host it then closes the host resource; for an owned child it sends a graceful process signal, waits a configurable bounded grace period, terminates, and finally force-kills the owned process group if necessary. It drains streams, records the adapter-specific terminal evidence and remaining worktree state, and only then commits `CANCELLED`. Cancellation never deletes a dirty worktree automatically.

## 7. Executor adapter contract

### 7.1 Required common surface

The v0.1 adapter surface is intentionally small:

```text
probe() -> AdapterDescriptor
start(ExecutionRequest) -> AttemptHandle
events(AttemptHandle) -> AsyncIterable<NormalizedEvent>
wait(AttemptHandle) -> ProviderOutcome
cancel(AttemptHandle, reason) -> CancelOutcome
reconcile(PersistedAttemptIdentity) -> ReconcileOutcome
```

`ExecutionRequest` contains contract version, IDs, role, working directory, bounded prompt/input artifact, model/effort request, permission/network policy, timeout, environment allowlist, expected result schema, and optional provider session ID. Arguments are passed as an argv array or typed SDK request, never shell-concatenated.

`AttemptHandle` contains only opaque provider/session/process identities needed for observation and recovery. It is serializable except live stream/process handles, whose persisted identifiers are separate.

`NormalizedEvent` is a small envelope: schema version, run/attempt IDs, monotonically assigned KerbsFlow sequence, provider timestamp if supplied, kind (`started`, `progress`, `tool`, `permission`, `warning`, `completed`, `failed`), redacted summary, and optional artifact reference. Raw provider events are artifacts subject to redaction/retention, not core domain events.

### 7.2 Capability model

`AdapterDescriptor` reports adapter/provider version and explicit capabilities rather than fake uniformity:

- event transport: `jsonl`, `async_iterable`, `sse`, `text`, or none;
- native final JSON Schema support;
- model selection and provider-specific model identifiers;
- reasoning-effort selection and supported values when discoverable;
- agent/role selection;
- permission/sandbox modes and whether filesystem limits are enforced, policy-only, or unavailable;
- provider/control-plane network requirement/ownership separately from agent/tool/workload network enforcement (`enforced`, `tool_policy_only`, or `unavailable`);
- provider-native cancellation versus process-only cancellation;
- resumable session support and required identity;
- authentication owner/mode without credential material; and
- health/version probing.

Routing fails closed when a required capability is absent. Optional operations such as provider session continuation are exposed only when the descriptor declares them. Core behavior never infers a capability from provider name alone.

### 7.3 Codex adapter decision

Use a supervised `codex exec` subprocess for v0.1. The supported command is non-interactive, can emit newline-delimited JSON, accepts a final output JSON Schema, selects model and sandbox, and can resume a session. The installed Phase 0 CLI (`0.154.0-alpha.6.2`) additionally exposes approval/config flags; implementation must probe its actual tested version rather than rely on that local pre-release string. Official command documentation describes `codex exec` as stable and documents `--json`, `--output-schema`, `--model`, `--sandbox`, and `exec resume` ([Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)). Reasoning effort is a versioned config capability (`model_reasoning_effort`) and must be set only when supported ([Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

The adapter:

- runs with `-C` set to the assigned worktree;
- uses `--json` and a KerbsFlow-owned schema file in the run artifact directory;
- passes model and supported reasoning as explicit per-call overrides;
- supplies sandbox/approval policy explicitly and uses strict config checking when compatible;
- records the session ID from events for possible `codex exec resume`;
- treats malformed JSONL, schema failure, missing terminal event, and unexpected EOF as protocol/executor failures;
- cancels the owned child/process group; v0.1 does not assume a separate stable Codex cancellation API;
- leaves authentication in Codex's own store. `--ignore-user-config` does not remove auth, but whether user configuration should be inherited is project policy; and
- does not adopt the experimental app-server in v0.1 because the stable CLI already satisfies the minimum contract.

ChatGPT account sign-in and API-key login are provider-owned options with different billing/governance implications; KerbsFlow detects authenticated readiness/mode but never reads or stores the credential ([Codex authentication](https://learn.chatgpt.com/docs/auth)).

### 7.4 OpenCode adapter decision

Prefer an explicitly owned embedded OpenCode V2 host through `@opencode/sdk` when the pinned and tested V2 version exposes every capability required by the KerbsFlow adapter contract. Authoritative V2 documentation states that `OpenCode.create()` hosts OpenCode directly in the application, routes its HTTP contract in memory, opens no HTTP listener, adds no client/server network hop, exposes sessions and the generated client surface, streams events as `AsyncIterable`, and accepts `AbortSignal` request cancellation ([OpenCode V2 embedded SDK](https://opencode.ai/v2/docs/build/sdk)).

The adapter:

- pins and contract-tests the actual supported `@opencode/sdk` V2 version before relying on any capability;
- creates and explicitly closes one owned embedded host at the adapter-defined lifecycle boundary, recording the SDK/host version and probed capabilities without leaking embedded details into core state semantics;
- creates a session rooted at the assigned worktree, subscribes to its asynchronous event stream before dispatch, sends a schema-constrained prompt when the pinned version supports it, and reconciles completion with session/status/message snapshots;
- selects OpenCode model in `provider/model` form and an explicit agent when policy requires it;
- applies an explicit deny-by-default permission object instead of OpenCode's permissive defaults, allowing only approved worktree operations and commands;
- uses request `AbortSignal` and any probed session-abort capability; host closure is the final owned-resource stop, while uncertain remote/provider effects enter `RECOVERY` rather than being replayed;
- reuses OpenCode-owned provider credentials. It never calls the auth-setting API with copied credentials;
- records that an embedded host shares the KerbsFlow process/environment trust boundary; it must not enumerate, copy, or persist ambient credentials, and an inadequate secret boundary selects an isolated supported fallback or human gate;
- treats event-stream termination or gaps as a reconciliation trigger rather than assuming success or failure; and
- fails closed or selects an explicit fallback when the pinned V2 SDK lacks a required KerbsFlow capability.

A KerbsFlow-owned loopback OpenCode server/client may be implemented only if Phase 4 evidence shows that the pinned embedded V2 host cannot provide a required capability. Such a fallback must be loopback-only, explicitly owned/authenticated, capability-described, and independently tested. `opencode run` remains a diagnostic/fallback transport. v0.1 does not add speculative V1 compatibility or make lifecycle/state semantics depend on embedded, loopback, or CLI transport.

OpenCode permissions remain explicit and deny-by-default from KerbsFlow's perspective; provider defaults are not trusted. The actual permission surface is pinned and contract-tested with the selected V2 SDK rather than inferred from older SDK/server behavior.

## 8. Structured executor result v1

Every adapter must return a runtime-validated result conforming to `kerbsflow.executor-result/v1`. Unknown fields are retained only in provider artifacts; the normalized contract stays small.

```json
{
  "schemaVersion": "kerbsflow.executor-result/v1",
  "runId": "run_...",
  "taskId": "task_...",
  "attemptId": "attempt_...",
  "executor": {
    "adapter": "codex",
    "adapterVersion": "...",
    "provider": "openai",
    "model": "...",
    "reasoning": "high"
  },
  "outcome": "succeeded",
  "failureClass": null,
  "scopeClaim": "within_scope",
  "summary": "...",
  "filesChanged": [
    { "path": "src/example.ts", "change": "modified" }
  ],
  "checks": [
    {
      "name": "focused test",
      "outcome": "passed",
      "evidenceClass": "automatically_tested",
      "evidenceRefs": ["artifact_..."]
    }
  ],
  "evidence": [
    {
      "id": "evidence_...",
      "kind": "command",
      "classification": "automatically_tested",
      "summary": "...",
      "artifactRef": "artifact_..."
    }
  ],
  "invariantViolations": [],
  "risks": [],
  "warnings": [],
  "artifacts": ["artifact_..."],
  "humanGate": null,
  "recommendedNext": "verify_focused",
  "exit": { "kind": "normal", "code": 0 }
}
```

Required semantics:

- `outcome`: `succeeded | failed | blocked | partial | cancelled`.
- `failureClass`: null only for an apparently successful result; otherwise one value from section 11.
- `scopeClaim`: `within_scope | questionable | violated | unknown`.
- `filesChanged.change`: `added | modified | deleted | renamed | unknown`.
- check outcome: `passed | failed | skipped | not_run | unknown`.
- evidence classification: `automatically_tested | manually_validated | inspected | inferred | simulated | not_tested`.
- `recommendedNext`: `verify_focused | rework | escalate | human_gate | fail`.
- exit kind: `normal | signal | spawn_error | timeout | protocol_error | unknown`, with code/signal/detail only when applicable.

`humanGate`, when present, contains reason code, concise summary, evidence references, two or more valid options with consequences, and an optional recommendation. It must not invent a recommendation under material uncertainty.

The result is an executor claim. KerbsFlow independently derives authoritative changed files and validation records. Disagreement is preserved and may become a gate; it is never silently overwritten.

## 9. Evidence and verification

### 9.1 Evidence classes

- `automatically_tested`: a command/check was run by KerbsFlow and produced captured, interpretable output.
- `manually_validated`: a human explicitly recorded an observation or action.
- `inspected`: a file/diff/config/artifact was directly examined without executing behavior.
- `inferred`: a conclusion follows from other evidence but was not directly exercised.
- `simulated`: behavior was exercised with a fake/stub/model rather than the real boundary.
- `not_tested`: no supporting execution or inspection exists.

No class may be upgraded merely because an executor says it ran a check. Executor-reported checks remain claims until command/artifact evidence is independently attributable.

### 9.2 Progressive validation

- **Focused:** smallest check protecting the changed behavior/invariant after each attempt.
- **Phase/subsystem:** affected boundary and its interactions before phase closure.
- **Full gate:** deterministic repository release gate plus cross-cutting security/recovery checks before release readiness.

The Planning Master persists the intended level before execution. A lower level cannot substitute for a higher one. Tests are added only for distinct behavior, invariant, trust boundary, regression, security property, or failure mode—not to increase counts or percentages.

### 9.3 Anti-greenwashing inspection

Before pass, compare base and worktree for:

- deleted, skipped, newly ignored, or filtered tests;
- weakened/removed assertions or negative cases;
- new suppressions, allowlists, silent fallbacks, or empty catches;
- lowered coverage/quality thresholds or disabled lint/type/build checks;
- removed CI/check configuration when it is in scope;
- required production behavior replaced by fake/stub code;
- integration coverage replaced by insufficient unit-only coverage; and
- errors converted to successful exit codes.

Any signal is investigated, not automatically convicted. A zero exit code without expected assertions/output/artifacts is insufficient.

### 9.4 Independent review strategy

The implementer and sole verifier must not be the same reasoning session. v0.1 independence is satisfied by both:

1. deterministic facts collected by the core outside the executor; and
2. when semantic review is required, a fresh edit-disabled reviewer session with only the canonical contract, diff, and relevant evidence.

High-impact/security/architecture/final review routes to the strongest configured reviewer class (initially Codex Sol High policy). Provider diversity is beneficial but not a v0.1 invariant. Reviewer disagreement that affects correctness or scope goes to rework or a human gate.

## 10. Human gates

A human gate is required for:

- material SPEC/product intent, architecture, security boundary, scope, or compatibility change;
- ambiguous acceptance criteria that change what “done” means;
- secrets/credentials or a new sensitive environment variable;
- destructive or difficult-to-recover operation;
- licensing concern;
- network/filesystem access beyond approved policy when enforcement is weaker than required;
- repeated conceptual implementation failure, loop, or unresolved executor/reviewer disagreement;
- dirty/uncommitted source state that cannot be included deterministically;
- push, merge, tag, release, deployment, or production access; and
- ambiguous crash recovery where replay might duplicate a non-idempotent action.

Every gate persists:

- what happened and which run/task/attempt is affected;
- why safe automatic continuation is impossible;
- concise evidence references;
- valid options and consequences/tradeoffs;
- an optional evidence-backed recommendation;
- the approving human, timestamp, selected option, and optional note; and
- the legal target transition.

Rejecting or closing a gate must be idempotent. Approval applies only to the described action/scope and does not become a general permission.

## 11. Failure, retry, and escalation

### 11.1 Small failure taxonomy

| Class | Meaning | Default next action |
| --- | --- | --- |
| `executor_error` | Provider process/protocol/model failed independent of implementation correctness | One transient retry, then alternate route/gate. |
| `implementation_failure` | Code/change does not meet the task but diagnosis is clear | One bounded rework. |
| `validation_failure` | Independent check failed or evidence is insufficient | Rework if causal and bounded; otherwise escalate. |
| `scope_violation` | Change exceeds approved positive/negative scope | Stop; revert through a new controlled attempt or gate. No blind retry. |
| `invariant_violation` | Product/security/correctness invariant is violated | Stop and escalate/gate. |
| `environment_or_tool_failure` | Missing/incompatible tool, resource, auth, or host failure | One retry only if transient; otherwise alternate route/gate. |
| `requirement_or_architecture_ambiguity` | Continuing would decide intent/architecture/compatibility | Human gate. |
| `security_or_privilege_gate` | Additional secret, network, filesystem, destructive, or release authority is needed | Human gate. |
| `repeated_loop` | Same conceptual failure/action recurs without new evidence | Escalate once, then human gate/failed. |
| `cancelled` | Human/policy requested stop | Reconcile then terminal cancel. |
| `unknown` | Evidence cannot safely classify the outcome | Recovery, then human gate if still unknown. |

### 11.2 Retry policy

- Retries are keyed by failure fingerprint (class plus normalized diagnostic and affected invariant), not merely exit code.
- Transient executor/tool failure: at most one same-route retry with bounded backoff.
- Clear implementation failure: at most one same-executor rework using the diagnostic and unchanged SPEC.
- A repeated fingerprint, invariant/scope violation, ambiguous requirement, or privilege request is never blindly retried.
- Escalation may change executor/model/effort but not scope or acceptance criteria.
- v0.1 defaults to two implementation attempts per task before a gate; project policy may lower this but may not create unbounded retries.

## 12. Routing policy

Routing is versioned typed configuration evaluated against capabilities. Initial policy:

| Task class | Preferred route | Escalation |
| --- | --- | --- |
| Normal non-sensitive implementation, fixes, refactors, tests, maintenance | OpenCode / Muse Spark 1.3 Contributor Free while available and suitable | Codex / Luna Max |
| Difficult integration or complex debugging | Codex / Sol Medium | Codex / Sol High |
| Architecture, protocols, storage, concurrency, security, licensing, high-impact decisions, difficult root cause, critical final review | Codex / Sol High | Human gate if unresolved |

Luna Medium is prohibited by current policy. Model/provider names are configuration values, not core enums; availability is probed. Future cheap/local routers may advise task/executor/validation/escalation classifications but can never override SPEC, invariants, security gates, or deterministic policy.

Routing decisions persist non-sensitive metadata: classification, considered capabilities/routes, selected route, actual route, retry/escalation reason, validation result, and final outcome. They do not retain source code or large prompts for hypothetical training.

### 12.1 Skill selection in v0.1

The Planning Master may select a minimal task-specific set from known installed skills. Initial useful categories are context engineering, SPEC/PLAN/debug/verify/handoff workflows, source-driven development, code review/quality, simplification, security/hardening, and ponytail implementation/complexity review. It must not invoke every category by default.

Selected skill names and discoverable versions are persisted with the planning/routing decision and supplied to the executor as bounded input. A skill cannot broaden scope, permissions, or authority; SPEC, invariants, correctness, and security win over simplification. Ponytail review/audit remain read-only unless a separately authorized implementation task exists. v0.1 does not install/update skills, implement a plugin system, or require a provider to fake skill support. A missing required skill causes another eligible route or an explicit gate, not silent omission.

## 13. Persistence and storage boundaries

### 13.1 Canonical Markdown

Repository-owned durable intent belongs only in:

- `AGENTS.md`: permanent concise rules;
- one active release/feature SPEC: product/architecture/invariants/acceptance;
- one active PLAN: mutable implementation phases/status; and
- `docs/HANDOFF.md`: current state, blockers, exact next action.

KerbsFlow stores their relative paths, Git/base identity, and content hashes. It does not keep indefinite duplicate full copies in SQLite. If reproducibility requires the exact text, the captured base commit is authoritative; an uncommitted canonical change creates an intake gate.

### 13.2 SQLite operational state

Conceptual tables (exact SQL is Phase 1 implementation detail):

- `projects`: repository identity/path, default branch/ref, policy reference;
- `runs`: objective summary, current state/version, base OID, canonical hashes, active phase/task, timestamps;
- `tasks`: bounded action, acceptance/evidence intent, status;
- `transitions`: append-only legal state changes and causation;
- `attempts`: attempt ID, route, capability/version snapshot, lifecycle, provider/session/process identity, exit/failure;
- `routing_decisions`: classification, candidates, selection, escalation;
- `validations`: level, commands/checks, evidence classification, result;
- `human_gates`: reason, evidence/options, resolution;
- `artifacts`: type, relative runtime path, hash, size, redaction/retention state; and
- `migrations`: schema version/checksum/application time.

Large result JSON, event streams, command output, and diffs remain filesystem artifacts. SQLite stores bounded summaries and references. It never stores secrets, credential material, full repository copies, or indefinite raw prompt/history by default.

### 13.3 SQLite ownership and durability

- One KerbsFlow process owns the database and serializes writes; UI never opens it directly.
- Use short explicit transactions, foreign keys, a busy timeout, integrity checks at startup, and durability settings appropriate to a control plane.
- State transition, current-state version, related intent/attempt row, and idempotency record commit atomically when they are all database-resident.
- Use forward-only numbered migrations with checksum and backup/restore guidance. Migration failure leaves the old schema untouched or enters a human recovery gate.
- Do not put the database on a network filesystem.
- Start with SQLite rollback journal. WAL is not required for one connection owner; if later enabled, manage checkpoint and `-wal`/`-shm` files as one database unit.
- No ORM in v0.1. Use parameterized SQL behind a small state-store boundary and runtime row validation.

### 13.4 Per-run artifacts

Use the platform's application-data directory, outside managed repositories:

```text
<app-data>/KerbsFlow/
  kerbsflow.sqlite
  runs/<runId>/
    attempts/<attemptId>/
    validation/
    prompts/
    results/
    logs/
  worktrees/<projectId>/<runId>/
```

Artifacts include redacted prompts/results/events, command outputs, diffs, schema files, process metadata, and generated reports. Paths stored in SQLite are relative to the runtime root and content-hashed. Directories/files use owner-only permissions where the OS supports them. Retention is bounded and deletion is explicit/recoverable where practical.

Future `.gitignore` must defensively exclude any repository-local fallback runtime locations, at minimum `.kerbsflow/`, `.kerbsflow-worktrees/`, `kerbsflow.sqlite`, `kerbsflow.sqlite-wal`, `kerbsflow.sqlite-shm`, run logs/events, and temporary credential/redaction files. The preferred runtime is outside the repository, so ignore rules are defense-in-depth rather than the primary boundary.

## 14. Worktree lifecycle

1. Resolve repository common directory and exact base commit OID; record branch/upstream metadata.
2. Inspect the original checkout. Tracked modifications and untracked files are not silently copied, stashed, committed, or discarded. If the objective depends on them, create a human gate requiring an explicit committed/ref-based base.
3. Create `<app-data>/KerbsFlow/worktrees/<projectId>/<runId>` with branch `kerbsflow/run-<shortRunId>` from the captured OID, using argument-safe Git commands.
4. Lock the worktree with a run-specific reason and persist path, branch, OID, and Git administrative identity. Git supports locked linked worktrees, stable porcelain listing, removal, prune, and repair ([Git worktree documentation](https://git-scm.com/docs/git-worktree)).
5. All executor writes occur inside this worktree. Additional writable/tool paths require explicit policy; provider credentials remain tool-owned outside the worktree and are not exposed as general readable paths.
6. Compute scope/diff from the captured base, including untracked files. A local commit is neither required nor created automatically in v0.1.
7. On crash, reconcile `git worktree list --porcelain`, path, branch, lock, and OIDs. Missing/moved/corrupt state enters recovery; use `repair`/`prune` only after exact target validation.
8. On terminal state, retain dirty/failed worktrees for inspection. Remove only after the human/core cleanup policy confirms the run is terminal, artifacts are captured, and the worktree is clean or explicitly disposable. Never force-remove valuable unknown changes.

KerbsFlow owns the lifecycle; adapters receive only the assigned directory. Branch names are collision-checked. Reusing a worktree or branch across runs is prohibited.

## 15. Process lifecycle and recovery

### 15.1 Launch and observation

- Spawn executable plus argv directly, with `cwd` equal to the worktree and a minimal environment allowlist.
- Create a unique execution attempt ID before launch. Persist `PREPARED` intent and artifact directory before side effects.
- After adapter start, persist its version/capability snapshot, provider/session identity when known, and `RUNNING` state. For an external child also persist PID/process-group identity and start timestamp/fingerprint; for an embedded host keep live host/router resources process-local and persist only identifiers needed for conservative reconciliation.
- Stream stdout/stderr/provider events through bounded parsers. Redact before durable write; truncate with an explicit marker and original byte count.
- Never execute user/model text through an implicit shell. Shell commands requested by an executor remain under provider/tool permission policy.
- Timeouts are task-policy values with separate start, idle/progress, graceful-cancel, and absolute ceilings. Timeout becomes evidence, not automatic permission to replay.

### 15.2 Crash recovery and idempotency

On startup, if any run/attempt was nonterminal, enter `RECOVERY` before dispatching new work.

Minimal protocol:

1. Every human/core command has an idempotency key and expected run-state version.
2. Every external side-effect attempt has a unique attempt ID and persisted `PREPARED -> RUNNING -> TERMINAL` lifecycle.
3. A state transition and its database-resident intent commit atomically before dispatch.
4. Recovery compares persisted adapter/session/process identity as applicable, live child fingerprint or provider/session status when available, artifact terminal markers, and worktree diff.
5. If a provider proves the attempt is still running, reattach/observe or cancel according to policy.
6. If it proves a terminal result, ingest it exactly once and continue at verification/review.
7. If `PREPARED` or `RUNNING` is ambiguous—especially the spawn-before-PID-record window—do not start a duplicate. Replay only when the adapter proves no execution occurred and the action is classified replay-safe; otherwise create a human gate.
8. A task/result/transition unique constraint prevents double ingestion. Idempotency keys prevent duplicate UI/human commands, not arbitrary provider side effects.

An external executor crash with a known nonzero exit, or an embedded host/request failure with a declared terminal error, is `executor_error` or `environment_or_tool_failure` and follows retry policy. Child orphan detection checks only exact persisted PID plus start fingerprint/process group; PID alone is never sufficient. Provider resume/session recovery is continuation of an identified session, not proof that filesystem effects are safe to repeat.

## 16. Security and isolation model

### 16.1 Filesystem

- Default writable scope is the assigned worktree plus explicit per-run artifact/temp paths.
- Provider sandbox/permission mechanisms must be configured explicitly and their enforcement strength recorded.
- `danger-full-access`/full access is allowed only when the *host environment itself* is intentionally isolated and policy records that boundary. A worktree does not make full host access safe.
- Paths are canonicalized and checked against allowed roots; reject traversal, symlink escape where the operation can enforce it, broad deletion targets, and ambiguous globs.
- Temporary directories are unique, owner-only, outside the repository, and reconciled before cleanup.

### 16.2 Network

KerbsFlow distinguishes two network planes and never reports a single ambiguous “network allowed” flag:

1. **Provider/control-plane network:** Codex/OpenAI inference, authentication, and session traffic, and OpenCode model-provider inference/authentication traffic. A remote executor may require this traffic to function. It remains owned by the provider/tool integration, is represented separately in adapter capabilities, and is not arbitrary network permission for agent tools or repository workloads. The preferred embedded OpenCode host removes a local HTTP listener/hop but may still require outbound model-provider traffic.
2. **Agent/tool/workload network:** shell commands, `curl`/`wget`, package downloads, repository code making outbound connections, and web/browser tools. This plane is denied or unavailable by default when the selected executor/OS can enforce it. Task-specific access requires explicit policy; secret-bearing or boundary-expanding access requires the applicable human gate.

Capability records describe each plane and distinguish workload enforcement as `enforced`, `tool_policy_only`, or `unavailable`. Denying web tools does not prove shell/repository network isolation, while required provider inference traffic does not imply workload permission. If strict workload no-network execution is required but cannot be enforced, KerbsFlow chooses another route/environment or gates; it does not claim “no network.”

Codex sandbox configuration and OpenCode permissions/host capabilities are mechanisms, not the policy itself. v0.1 does not introduce a proxy, firewall, or custom network-isolation subsystem.

### 16.3 Secrets and environment

- Start children with a minimal environment. Remove known token/key/credential variables unless explicitly required. An embedded host shares the KerbsFlow process environment, so its adapter must use provider-owned credential loading, avoid enumerating/copying ambient variables, and report that weaker separation honestly.
- Prefer existing Codex/OpenCode authentication stores and provider-owned login flows. KerbsFlow records only readiness/mode, never credential values.
- Secret exposure is task-scoped, time-bounded, and human-gated. It is not written to SQLite, prompts, logs, artifacts, command lines, or UI state.
- Redaction uses exact runtime secret values when available plus conservative key/pattern detection. Redaction failures stop persistence rather than fall back silently.
- `.env*` and credential paths are denied by default; synthetic `.env.example` may be readable when in scope.

### 16.4 Git and release authority

- Local worktree/branch creation and diff inspection are routine core operations.
- Automatic commits are disabled in v0.1. Future local commits require explicit project policy.
- Push, force operations, merge, tags, release publication, deployment, and production are hard human gates and remain outside automatic v0.1 actions.
- The core never rewrites or deletes the user's original checkout state.

### 16.5 Logging, UI, and artifacts

- Logs are structured, redacted, bounded, and use opaque IDs. Do not log full environment, auth headers, URLs with credentials, or raw private source unnecessarily.
- Render repository/model text as escaped plain text; never execute or inject raw HTML/ANSI in the UI.
- Loopback API uses a per-launch token, strict origin/host validation, no wildcard CORS, and idempotent mutation commands.
- Artifacts are not served by arbitrary path; access is by validated artifact ID under the runtime root.
- Public examples/fixtures contain synthetic repositories, identities, paths, tokens, and logs only.

## 17. Configuration boundaries

Configuration is a versioned typed object with this precedence: hard invariant -> project policy -> user preference -> explicit run override. A lower layer cannot relax a higher one.

### 17.1 Hard invariants

Not user-disableable in v0.1:

- legal state transitions and one active implementation executor;
- no silent product/architecture/scope/security/compatibility change;
- independent evidence and anti-greenwashing review;
- secrets absent from persistence and public artifacts;
- high-impact human gates;
- no automatic push/merge/tag/release/deploy/production;
- no duplicate ambiguous execution after restart; and
- executor cannot mark its own work verified/done.

### 17.2 Project policy

Versioned repository policy may choose allowed executors/models, validation commands, writable paths, network posture, retry limits (within hard ceilings), skill allowlist, and retention. The implementation may introduce one small typed project config file when Phase 1 defines its schema; it must not become a workflow DSL or duplicate the SPEC.

### 17.3 User preferences and run overrides

User preferences select defaults such as UI display, preferred eligible route, and notification behavior. Run overrides are explicit, persisted decisions for one run and may narrow permissions or choose another allowed route. Overrides that expand a trust boundary trigger the applicable gate.

## 18. Local UI/headless protocol

The orchestration core must be importable/testable without a web server. A small transport layer exposes:

- snapshot reads for project/run/task/attempt/validation/gate state;
- idempotent commands for start, pause, resume, steer, cancel, and gate resolution; and
- an SSE stream of persisted state-version notifications and redacted progress summaries.

Clients first fetch a snapshot, then subscribe using the last seen state/event sequence. SSE loss is repaired by refetching the snapshot; event delivery is not the source of truth. Polling is limited to reconnect/health fallback. The protocol is `/v1` versioned but is not a promised public remote API in v0.1.

Steer queues an instruction for the next safe Planning Master boundary. It does not mutate an in-flight prompt or broaden scope without re-planning/gating. Inspect is read-only. UI disconnect never cancels a run.

No frontend framework is selected in Phase 0. Phase 6 chooses the smallest option compatible with the protocol and security boundary, recording any material dependency decision in this SPEC.

## 19. Open-source and licensing

### 19.1 Public repository constraints

Never commit operational databases, runtime worktrees, raw/unredacted logs, credential material, copied private-repository content, or provider session stores. Dependency licenses/provenance must be reviewed before addition. Public tests use synthetic repositories and fake credentials. No telemetry or remote upload exists in v0.1.

Community boilerplate, CI, release automation, issue templates, and SECURITY/CONTRIBUTING/CODE_OF_CONDUCT files are deferred until they protect a concrete release/community need.

### 19.2 License selection and status

The selected license is **Apache License 2.0**. The copyright holder is **Teyocesu**, with copyright year **2026**. The canonical, unmodified license text is in `LICENSE`; the project attribution is in `NOTICE`. Both MIT and Apache-2.0 permit commercial use, modification, and redistribution. MIT is shorter and imposes mainly notice preservation; its standard text contains no express patent grant ([SPDX MIT text](https://spdx.org/licenses/preview/MIT.html)). Apache-2.0 adds an express contributor patent license and patent-litigation termination, plus change/notice obligations ([Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0.html)).

For developer infrastructure expected to accept outside contributions and integrate with commercial tooling, the explicit patent terms outweigh Apache-2.0's additional compliance text. Material tradeoffs are the requirement to preserve notices/state changes and incompatibility concerns for some GPLv2-only combinations. This is architectural guidance, not legal advice. No source copyright headers are required for v0.1.

## 20. Deterministic validation expectations

Implementation must provide deterministic, synthetic tests for:

- every legal transition and representative invalid/stale/duplicate transition, including persisted `PAUSED` origin/boundary/`resumeTarget`, forced `RECOVERY` for paused execution uncertainty, target tampering, stale resume, duplicate resume, and idempotent cancellation from `PAUSED`;
- atomic transition/intent writes and migration rollback behavior;
- executor-result schema acceptance/rejection and forward-version refusal;
- fake-adapter event loss, malformed output, nonzero/zero-without-evidence exits, timeout, cancel, and resume capability;
- crash injection at `PREPARED`, spawn, PID/session persistence, terminal-result ingestion, and verification boundaries;
- no duplicate dispatch during ambiguous recovery;
- temporary Git repositories covering exact base OID, dirty original checkout, untracked files, branch collision, diff scope, lock/reconcile, and safe cleanup;
- process argv safety, environment allowlisting, redaction, truncation, and process-group cancellation on each supported OS;
- anti-greenwashing fixtures for deleted/skipped/weakened tests, suppressions, disabled checks, stubs, and false-zero exits;
- human gate structure/idempotent resolution and forbidden high-impact actions;
- UI/API state-version conflict, origin/token checks, artifact path confinement, SSE reconnect/snapshot recovery; and
- capability-driven routing, prohibited Luna Medium route, bounded retries, and escalation.

Provider integration contract tests run against explicitly recorded Codex/OpenCode versions with synthetic repositories and no real secrets. Offline fake adapters are the default CI path; live paid-provider smoke tests are opt-in and are not the only evidence. The full v0.1 gate includes typecheck, lint/format policy, unit/integration tests, supported-platform process/worktree tests, migration/recovery tests, dependency/license review, secret scan by deliberate release procedure, and manual inspection of public artifacts.

Validation reporting must label automatically tested, manually validated, inspected, inferred, simulated, and not tested separately.

## 21. v0.1 acceptance criteria

v0.1 is acceptable only when:

1. A user can register a Git repository, submit an objective, and see validated canonical context.
2. Planning Master produces one bounded action and the core rejects stale/illegal/out-of-policy decisions.
3. A KerbsFlow-owned worktree is created from an exact base without modifying the original checkout.
4. Codex and OpenCode adapters probe capabilities, run one task, stream normalized progress, validate a structured result, cancel, and classify terminal failures.
5. Exactly one implementation executor can be active.
6. Independent diff/scope/invariant and focused validation occur before review can pass.
7. Review can deterministically continue, rework, escalate, gate, close a phase, or begin final verification.
8. Human gates contain evidence/options/consequences and cannot be bypassed by model output.
9. Crash/restart never silently duplicates an ambiguous attempt and preserves enough state to reconcile or gate.
10. Pause/resume/cancel are observable, idempotent, and do not auto-delete dirty work.
11. Current run state is available headlessly and through a secured thin local UI.
12. No success is declared from exit code alone or through weakened validation.
13. Secrets/credentials are tool-owned by default and absent from SQLite, committed files, logs, and public fixtures.
14. Push/merge/tag/release/deploy/production remain human-controlled and unimplemented as automatic actions.
15. Full deterministic v0.1 validation passes on the officially supported macOS host with evidence classifications intact.

## 22. Phase 0 acceptance

Phase 0 is approved and frozen for implementation. Independent review confirmed that this SPEC and its PLAN define unambiguous scope, lifecycle/transitions, gates, adapter/result contracts, persistence/recovery, worktree/process ownership, verification, security, public-repository constraints, licensing status, decision record, and early vertical delivery. The final review corrections resolved the runtime baseline, selected the OpenCode V2 embedded-host preference, made pause/resume deterministic, and separated provider/control traffic from workload network permission. No production code, dependencies, scaffolding, or speculative systems were added.

## 23. Decision record

### U-02 — Open-source license and copyright holder (resolved)

- **Decision:** Apache License 2.0, copyright holder Teyocesu, copyright year 2026.
- **Artifacts:** The canonical unmodified text is in `LICENSE`; the minimal project attribution is in `NOTICE`; no source copyright headers are required.
- **Scope:** This decision authorizes publication of the Phase 1 production branch under Apache-2.0. It does not authorize merge, release, deployment, or any other automatic remote lifecycle action.

### U-03 — v0.1 support matrix (resolved)

- **Decision:** Official v0.1 host support is macOS only. This explicit product-scope decision supersedes the earlier macOS/Linux matrix. Linux is unsupported preview/best-effort, has no v0.1 compatibility guarantee, and is not a Phase 5 or Phase 7 requirement. Windows is deferred and unsupported in v0.1. Linux may be promoted in a future release after its own real-host validation.
- **Scope:** v0.1 release and phase acceptance use macOS as the only officially supported host. The Linux implementation may remain in source, but any Linux invocation must retain its existing capability checks and fail-closed behavior; unsupported status does not permit an unsafe fallback. No Windows implementation or support claim is added in v0.1.

## 24. Explicitly deferred capabilities

- concurrent repositories/executors, remote workers, collaboration, cloud sync, hosted UI, and multi-user auth;
- GitHub/CI/issue tracker integrations and automated remote lifecycle actions;
- learned/local routing model and routing-dataset export tooling;
- vector/embedding/RAG memory, semantic code index, and long-term conversation archive;
- provider/plugin marketplace, generic workflow DSL, custom agent framework, and dynamic arbitrary adapters;
- container/VM sandbox orchestration beyond documented native/provider mechanisms;
- automatic commits, pushes, merges, tags, releases, deployments, and production operations;
- advanced pause/checkpoint of arbitrary child processes; and
- community/release infrastructure not required for the first reliable local loop.

## 25. Phase 0 integration evidence summary

- Local inspection found Codex CLI `0.154.0-alpha.6.2`; its installed help confirms non-interactive exec, JSONL, output schema, model/config, sandbox/approval flags, and exec resume. OpenCode was not installed, so no local-version claim is made.
- Official Codex documentation confirms stable `codex exec` and the relevant automation surfaces ([command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
- Current authoritative OpenCode V2 documentation identifies `@opencode/sdk` and `OpenCode.create()` as an explicitly owned embedded host. It routes the generated HTTP contract in memory, opens no listener, adds no local client/server network hop, exposes sessions/generated client methods, provides `AsyncIterable` events, and supports request cancellation with `AbortSignal` ([OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk)). The V2 CLI remains evidence for the diagnostic `opencode run` fallback ([OpenCode V2 CLI](https://opencode.ai/v2/docs/cli/commands/)).
- Phase 4 must pin and test the actual supported OpenCode V2 SDK version before relying on any capability. Loopback server/client is allowed only as an evidence-backed capability/version fallback; speculative V1 compatibility is excluded.
- Authentication remains provider-owned. KerbsFlow uses readiness/capability probes and does not import credentials.
- These are version-sensitive integration facts. Implementers must pin/probe the versions actually supported and update this SPEC if upstream behavior materially conflicts with it.
