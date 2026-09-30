# KerbsFlow v0.1.0 implementation plan

Status: **Phase 5 is complete and independently confirmed PASS at approved implementation baseline `16359e9a37e62bc37da8b2c480fca88fe855a2dd` on `phase5/isolation-operational-hardening`. Official v0.1 host support is macOS only; Linux is unsupported preview and does not block Phase 5 or v0.1 release readiness. Phase 6A is complete at approved HEAD `5f017cff55fbf81a137a8163fdb42e47249f2328` on `phase6/thin-local-ui`; Phase 6B is CLOSED after successful physical macOS QA at approved implementation baseline `d2c9a638c6e692ff516f4b7bf7c9fb92752207c4`; Phase 6C.1 — Steer + Planning Master integration is CLOSED / PASS at approved implementation baseline `c5a4a683af63f988b06ded852a9462e05f9e92c8`. Phase 6C.2A — RunCoordinator + control-plane core is CLOSED / PASS at approved implementation baseline `5d8e3524d69d20b2e6e2249169e88b50041d1d32`. Phase 6C.2B — local API + dashboard controls is CLOSED / PASS at approved implementation baseline `841563b72c072d4559d8bd83aec50d9643c1832a`. Phase 6C.3 — focused integration + physical macOS control QA is CLOSED / PASS at approved implementation baseline `e0f2c111ad02a280f5e3e20700923dc9550855da`. Phase 6C — Core controls is CLOSED / PASS at the same approved baseline. Phase 6 itself is NOT closed. Phase 6D — UX hardening is CLOSED / PASS at approved implementation baseline `4da62642bc10bab626c5bebbe11d2adf07a46366`. Phase 6E audit at `07d9ff5a6b58565e4734ea4ec05ffc29610318bb` found three blockers, remediated at `f07066c24683ac8ea17929f63e770a4b1714579f`. Phase 6E re-audit at `891a686b0f6151c30dbb3023e2fcbcda2abdfb7b` found an additional Human Gate contract issue, remediated at this HEAD: core-generated gates offer only executable coordinator continuations, and RECOVERY cannot enter HUMAN_GATE while the active attempt is PREPARED/RUNNING/UNKNOWN. Phase 6E re-audit at `196fdc83caa5d6d88ec0527724bd5294c3c04e64` found executor Human Gates did not always guarantee both terminal choices, remediated at this HEAD: every normalized executor-blocked gate guarantees FAILED + CANCELLED, with REWORK additionally available only when its proven continuation and attempt budget permit it. Phase 6 remains OPEN; Phase 6E remains OPEN pending full re-audit and complete physical macOS QA. Phase 7 has NOT started. Next checkpoint: full Phase 6E re-audit and complete physical macOS QA.**

Contract: [`SPEC-v0.1.0.md`](./SPEC-v0.1.0.md)

This is the single mutable implementation plan for v0.1. Complete phases sequentially. A phase may split work internally, but may not weaken its exit condition or create parallel plans. Update this file and `HANDOFF.md` at meaningful phase boundaries only.

## Routing and validation rules for all phases

- Normal scoped work uses OpenCode/Muse Spark 1.3 Contributor Free once the OpenCode route exists and is suitable; before then use Codex/Luna Max for ordinary implementation.
- Difficult integration/debugging uses Codex/Sol Medium; architecture, storage, concurrency, security, licensing, recovery, and critical review use Codex/Sol High. Do not use Luna Medium.
- Each implementation attempt receives the smallest relevant skills and a fresh independent verification step. The implementer does not approve its own work.
- Validate focused behavior during a phase, the phase boundary at exit, and the full gate only in Phase 7 unless blast radius warrants earlier expansion.
- Before green, inspect the diff for deleted/skipped/weakened tests, assertions, checks, thresholds, suppressions, empty catches, silent fallbacks, or required behavior replaced by stubs.
- A material product/architecture/security/compatibility/scope change stops at a human gate and updates the SPEC only after approval.

## Phase 0 — Product and architecture definition

**Status:** approved and frozen after independent review corrections.

**Objective:** Fix the v0.1 product contract and implementation boundaries before production code.

**Scope:** Repository inspection; authoritative Codex/OpenCode/Node/SQLite/Git/license research; canonical AGENTS, SPEC, PLAN, and HANDOFF.

**Acceptance criteria:**

- Exactly the four requested canonical files exist.
- No implementation source, manifest, dependency, framework, CI, database, or runtime directory was added.
- State machine, authority, adapters, structured result, verification, persistence, recovery, worktree/process lifecycle, security, UI boundary, license status, and the decision record are explicit.

**Focused validation:** Inspect repository file list/status and review the documents against every Phase 0 acceptance criterion in the SPEC.

**Exit condition:** Satisfied. Independent review found no blocking architectural ambiguity, Node.js 24 LTS was approved, and the required OpenCode, pause/resume, and network-boundary corrections are incorporated.

**Expected route:** Codex/Sol High for independent architecture/security review.

## Phase 1 — Headless contract and persistence foundation

**Status:** complete and independently confirmed after the targeted correctness fixes.

**Objective:** Produce a deterministic, restartable headless core that can run the lifecycle against a fake executor without touching a real repository.

**Exact scope:**

- Initialize the minimum TypeScript project on the approved Node.js 24 LTS runtime baseline.
- Define runtime-validated v1 contracts for IDs, states/transitions, planning decisions, adapter capabilities/events, executor results, validation evidence, and human gates.
- Define the persisted pause contract (`originState`, durable boundary, core-selected actual-state `resumeTarget`) and deterministic resume command; paused execution uncertainty must target `RECOVERY`.
- Implement the legal transition reducer/command handler with optimistic state version and idempotency keys.
- Implement direct-SQL SQLite migrations and state store with one process owner, explicit transactions, rollback journaling, foreign keys, integrity startup check, and artifact references.
- Implement an in-memory/fake adapter, fake artifact store, clock/ID injection, and headless read model.
- Implement startup detection that moves nonterminal attempts to `RECOVERY`; do not yet launch real processes.
- Define the small typed configuration layers and hard-invariant enforcement.

**Out of scope:** Real Codex/OpenCode calls, production worktrees, UI, remote Git, automatic commits, full process cancellation, and provider credentials.

**Acceptance criteria:**

- Every legal transition succeeds and representative illegal/stale/duplicate transitions fail without state change.
- `PAUSED` resumes only to its persisted policy-valid target; direct resume to `EXECUTE`, UI-supplied target changes, stale/missing targets, and duplicate effects are rejected deterministically, while cancellation from `PAUSED` is terminal/idempotent.
- Transition, current-state version, intent, and idempotency record are atomic.
- Fake plan -> ready -> execute -> focused verify -> review -> next/final/gate paths survive database close/reopen.
- Malformed/unknown contract versions fail closed with useful diagnostics.
- No ORM, workflow engine, or speculative adapter/plugin system exists.

**Focused validation:** Contract fixtures; full transition table tests; pause/resume matrix covering safe-origin and forced-`RECOVERY` targets, tampering/stale/duplicate resume, and cancellation from `PAUSED`; SQL migration/rollback tests; duplicate command tests; restart simulations at each persisted fake-attempt boundary.

**Exit condition:** Satisfied and independently confirmed. A deterministic fake vertical loop is automatically tested and current state can be queried headlessly after restart.

**Expected route:** Codex/Luna Max for routine implementation; Codex/Sol High review for state atomicity, schema, and recovery model.

## Phase 2 — First real vertical loop with Codex

**Status:** complete and independently confirmed at approved baseline `06fec341ad16aefd38df5d5cf3d1ccc1aa36a303`. The compatibility blocker is resolved with an official standalone Codex CLI; the ChatGPT.app-bundled CLI remains incompatible and fails closed.

**Objective:** Deliver the earliest useful real end-to-end loop in an isolated worktree using one executor.

**Exact scope:**

- Implement project registration/intake, canonical-path/hash validation, exact base OID capture, and dirty/untracked original-checkout gate.
- Implement minimum KerbsFlow-owned worktree create/lock/diff/retain lifecycle and runtime artifact layout.
- Implement safe subprocess supervision: argv spawn, worktree cwd, minimal environment, redacted/bounded stdout/stderr/JSONL, process identity, timeout, and graceful/forced cancellation.
- Before connecting any real adapter, persist durable `cancel_requested` intent atomically before invoking adapter/supervisor cancellation; the Phase 1 fake adapter ordering is not a safe contract for real process cancellation.
- Implement Codex capability/version/auth-readiness probe and `codex exec` adapter with JSONL, output schema, explicit model/reasoning/sandbox policy, result ingestion, and session identity.
- Implement a minimum Planning Master action selection and policy validator sufficient for one approved PLAN phase/task.
- Implement focused verifier facts: Git status/base/head/diff/changed paths, selected check execution, executor-claim comparison, and basic anti-greenwashing scan.
- Complete one synthetic repository objective through pass, one clear rework, one human gate, cancel, and restart/recovery paths.

**Out of scope:** OpenCode, learned routing, phase-wide/final release sophistication, UI, commits/push/merge/release, broad OS support beyond the approved U-03 matrix.

**Acceptance criteria:**

- The original checkout is unchanged; all executor writes occur in the recorded worktree.
- Codex cannot become active without a persisted `PREPARED` attempt and single-executor claim.
- A structured terminal result is schema-validated; zero exit without terminal/schema/evidence is failure.
- Independent diff/scope/check evidence, not the Codex claim, determines review outcome.
- Cancel leaves an inspectable terminal record and never deletes a dirty worktree.
- Restart does not duplicate a `PREPARED`/`RUNNING` ambiguous attempt; uncertainty gates.

**Focused validation:** Temporary Git repository tests for base/dirty/untracked/branch/lock/diff; subprocess fixtures for malformed JSONL, exit/signal/timeout/cancel; fake Codex executable contract tests; one opt-in live Codex smoke run with synthetic content.

**Exit condition:** Satisfied and independently confirmed. The deterministic Phase 2 and targeted-audit gates pass. Official standalone Codex CLI `0.157.0-alpha.1` denies synthetic outside reads, `.env` reads, `/tmp`, `/private/tmp`, resolved `$TMPDIR`, and local network access while preserving worktree writes; one disposable live smoke passed, followed by a second passing negative probe. Executable selection remains injected through `cliPath`/`CODEX_BIN`, and the capability probe remains authoritative rather than relying on a hard-coded version. The ChatGPT.app-bundled `0.155.0-alpha.9.2` remains incompatible and must not be selected.

**Expected route:** Codex/Luna Max for normal implementation, Sol Medium for process/CLI integration debugging, Sol High for security/recovery review.

## Phase 3 — Verification, review, and conservative recovery

**Status:** complete and independently confirmed at approved baseline `00e6924c057d6f3e28dfbea3f10f03896f84b07f`.

**Objective:** Make pass/rework/escalation/phase closure trustworthy under failures and validation manipulation.

**Exact scope:**

- Complete evidence classification and focused/phase/full validation selection.
- Implement anti-greenwashing detectors for the SPEC signal list and evidence-backed explanation flow.
- Implement fresh edit-disabled semantic review sessions when deterministic evidence is insufficient.
- Implement failure fingerprinting, bounded retry/rework budgets, escalation, and repeated-loop detection.
- Complete process/orphan/provider-session/worktree reconciliation for every documented crash window.
- Implement structured human gates and idempotent resolution.
- Implement PLAN/HANDOFF updates only at approved phase boundaries; protect canonical hashes from unnoticed mid-run changes.

**Out of scope:** Second executor, UI, remote CI/GitHub, autonomous repository history changes.

**Acceptance criteria:**

- Each review decision cites classified evidence and records disagreements.
- Every anti-greenwashing fixture is detected or explicitly justified; no exit-code-only pass exists.
- Same conceptual failure cannot loop indefinitely and scope/invariant violations are never blind-retried.
- Crash injection after intent/spawn/identity/result/verification reaches a proven state or human gate without duplicate execution.
- A fresh reviewer cannot write to the worktree.

**Focused validation:** Mutation-style fixtures for weakened gates; explicit focused-versus-phase command authority tests; reachable read-only semantic-review outcomes and ambiguity tests; real same-run retry/rework/escalation and attempt-ceiling tests; failure-fingerprint table tests; crash matrix; gate option/consequence tests.

**Exit condition:** Satisfied and independently confirmed. The Codex vertical loop requires a separately declared phase command, dispatches semantic review only for nonblocking semantic signals, consumes exact persisted reviewer authority, and executes bounded retry/rework/escalation within one run. Canonical intent is checked from the repository by the core, and ambiguous executor/reviewer crash windows recover conservatively without redispatch.

**Expected route:** Codex/Sol High for verification, recovery, security, and independent phase review.

## Phase 4 — OpenCode adapter and policy routing

**Status:** implementation, deterministic integration, and all targeted independent-audit corrections are complete and independently confirmed **PASS** at approved baseline `15274317000dd724ae3b280a0de82f0d477b6d1d`.

**Objective:** Add the preferred normal-work route and evidence-based escalation without changing the core lifecycle.

**Exact scope:**

- Pin and contract-test the actual supported OpenCode V2 `@opencode/sdk` version before relying on its capabilities.
- Prefer an explicitly owned embedded `OpenCode.create()` host with in-memory routing, no HTTP listener/network hop, sessions, generated client methods, `AsyncIterable` events, request `AbortSignal`, structured result support when available, and explicit close/recovery behavior.
- Add a KerbsFlow-owned authenticated loopback server/client only if Phase 4 evidence proves the pinned embedded host lacks a required capability; retain `opencode run` only as a diagnostic/fallback transport.
- Apply explicit deny-by-default OpenCode permissions and record enforcement strength.
- Implement model/agent selection and OpenCode-owned auth readiness without copying credentials.
- Record provider/control-plane network requirements separately from agent/tool/workload network enforcement; do not treat model-provider traffic as workload network permission.
- Implement typed routing for current policy, including Muse suitability/availability, Luna Max fallback, Sol Medium/High escalation, and Luna Medium prohibition.
- Persist non-sensitive routing decision/outcome metadata.
- Demonstrate that the same core loop runs through both adapters and capability mismatches fail closed.

**Out of scope:** Speculative OpenCode V1 compatibility, arbitrary third-party adapters, plugin marketplace, learned router, shared/remote OpenCode service, custom network proxy/firewall, and training-data export.

**Acceptance criteria:**

- The preferred path embeds and explicitly closes the V2 host without opening a local HTTP listener; the core lifecycle/result contract is unchanged if a tested fallback is selected.
- OpenCode `AsyncIterable` termination/gaps reconcile to session/status evidence without duplicate result ingestion.
- Request/session abort and host close reach a known/gated terminal state; uncertain remote/provider effects enter `RECOVERY` rather than replay.
- Permission policy denies secret/external/destructive actions and never relies on permissive defaults.
- The embedded host's shared process/environment trust boundary is reported honestly; credentials remain provider-owned, and inadequate separation selects a supported isolated fallback or gate.
- Capability output truthfully separates provider/control traffic from workload-network enforcement.
- Normal eligible work selects OpenCode/Muse; classified failures follow the bounded escalation table.
- Adapter-specific fields do not leak into core state-machine decisions outside capability/result envelopes.

**Focused validation:** Fake embedded V2 host/in-memory-router fixtures; explicit host ownership/close tests; `AsyncIterable` loss/termination/duplication/order tests; request abort; schema/permission/version capability tests; shared-environment credential non-copy/non-persistence checks; provider-versus-workload network reporting; routing/escalation tests; opt-in synthetic live smoke run. If loopback fallback is implemented, additionally test listener binding/auth, SSE reconciliation, teardown, and equivalence to the same adapter/core contract.

**Exit condition:** Satisfied for implementation and deterministic integration, and independently confirmed **PASS**. `@opencode/sdk` and the isolated official CLI were tested at `2.0.13`; the selected transport is an explicitly owned embedded host with no listener. Both adapters retain the v1 contract, and routing/escalation is deterministic, bounded, inspectable, and provider-agnostic at the core boundary. The opt-in live OpenCode smoke remains **NOT RUN** because the provider readiness API reported no enabled provider or model; enforcement remains honestly `tool_policy_only`.

**Expected route:** Codex/Sol Medium for embedded V2 SDK integration; Sol High for permission/auth/network/routing review; OpenCode/Muse may implement ordinary follow-up work after its adapter is verified.

## Phase 5 — Isolation and operational hardening

**Status:** Complete and independently confirmed **PASS** at approved implementation baseline `16359e9a37e62bc37da8b2c480fca88fe855a2dd`. F3–F5 remain accepted. By explicit product-scope decision, macOS is the only officially supported v0.1 host. Linux remains unsupported preview/best-effort; incomplete historical Linux validation is non-blocking and is not v0.1 certification.

**Objective:** Close the remaining filesystem, process, worktree, network, secret, artifact, and recovery risks for the officially supported macOS v0.1 host. Preserve fail-closed behavior in the Linux preview implementation without treating Linux as a v0.1 support or release gate.

**Exact scope:**

- Finish path canonicalization, symlink/allowed-root checks, temp permissions, environment allowlist, and secret redaction fail-closed behavior.
- Record and enforce filesystem/network capability strength per adapter/OS; gate when required isolation is unavailable.
- Harden process-group/tree cancellation and orphan reconciliation on each supported OS.
- Complete worktree branch collision, repair/prune, abandoned run, retention, and safe cleanup behavior.
- Enforce artifact-by-ID access, hashes, size limits, retention, and synthetic-public-fixture rules.
- Add the minimum `.gitignore` runtime boundaries when implementation introduces relevant paths.
- Validate database backup/migration failure/integrity recovery and decide from measurements whether WAL remains unnecessary.

**Out of scope:** Containers/VM platform, remote workers, production secrets, automatic destructive Git operations.

**Acceptance criteria:**

- No tested escape reaches outside allowed paths; unsupported enforcement is labeled/gated rather than claimed.
- The real macOS Seatbelt adversarial probe proves worktree read-only, private scratch writable, credential/environment protection, denied or confined unauthorized host writes, denied workload network, restricted descendants, and fail-closed cleanup.
- Known secrets and sensitive environment values are absent from persisted state/logs/artifacts and public fixtures.
- macOS cancellation terminates the owned process tree or produces an explicit recovery gate.
- Cleanup never force-removes unknown dirty work and can reconcile interrupted removal safely.
- SQLite remains consistent through migration/crash tests; any journaling change is evidence-backed and documented in the SPEC.

**Focused validation:** Adversarial path/symlink/argv/env/log fixtures; real macOS Seatbelt capability tests; macOS process-tree tests; dirty/missing/moved worktree matrix; database integrity, corruption, migration, backup, and recovery tests. Linux fixtures may verify defensive capability classification but are not release-certification evidence.

**Exit condition:** Satisfied and independently confirmed **PASS** at baseline `16359e9a37e62bc37da8b2c480fca88fe855a2dd`; the audit found no unresolved macOS Phase 5 blocker. On macOS Darwin 24.3.0 / Node v24.15.0, the actual Seatbelt probe denied `.env`, `.env.local`, and nested `.env.production` reads while allowing an ordinary source read. Focused sandbox, Git configuration/filter, process-tree, SQLite ownership, and cleanup tests passed, as did build, typecheck, the 241-test suite, high-severity dependency audit, and `git diff --check`. Rollback journaling remains the selected single-owner architecture, guarded across processes by a private owner record. Historical Linux validation is incomplete and does not establish Linux support; it is non-blocking for v0.1. Static path/symlink checks do not eliminate concurrent same-user path swaps under the v0.1 single-user threat model. At the Phase 5 exit baseline, Phase 6 implementation had not started.

**Expected route:** Codex/Sol High for implementation decisions and independent security/hardening review.

## Phase 6 — Thin local UI

**Status:** 6A is complete at approved HEAD `5f017cff55fbf81a137a8163fdb42e47249f2328`. 6B is CLOSED after physical macOS QA **PASS** at approved implementation baseline `d2c9a638c6e692ff516f4b7bf7c9fb92752207c4`. 6C.1 — Steer + Planning Master integration is CLOSED / **PASS** at approved implementation baseline `c5a4a683af63f988b06ded852a9462e05f9e92c8`. 6C.2A — RunCoordinator + control-plane core is CLOSED / **PASS** at approved implementation baseline `5d8e3524d69d20b2e6e2249169e88b50041d1d32`. 6C.2B — local API + dashboard controls is CLOSED / **PASS** at approved implementation baseline `841563b72c072d4559d8bd83aec50d9643c1832a`. 6C.3 — focused integration + physical macOS control QA is CLOSED / **PASS** at approved implementation baseline `e0f2c111ad02a280f5e3e20700923dc9550855da`. Phase 6C — Core controls is CLOSED / **PASS** at the same approved baseline. Phase 6 itself is NOT closed and Phase 6D — UX hardening is CLOSED / **PASS** at approved implementation baseline `4da62642bc10bab626c5bebbe11d2adf07a46366`. Phase 6E audit at `07d9ff5a6b58565e4734ea4ec05ffc29610318bb` found three blockers. They are remediated in this branch HEAD (`fix: address phase 6 audit blockers`), with focused integration, affected suites, full automated validation, headless regression, and independent diff review completed. **Phase 6 remains OPEN; Phase 6E re-audit at `891a686b0f6151c30dbb3023e2fcbcda2abdfb7b` found an additional Human Gate contract issue, remediated at this HEAD: `phase_validation_plan_missing` offers FAILED/CANCELLED (never unsupported REWORK), executor-blocked REWORK remains supported at its proven live checkpoint, and RECOVERY→HUMAN_GATE requires a settled attempt (PREPARED/RUNNING/UNKNOWN remain RECOVERY until trusted reconciliation proves a safe boundary). Phase 6E re-audit at `196fdc83caa5d6d88ec0527724bd5294c3c04e64` found executor Human Gates did not always guarantee both terminal choices, remediated at this HEAD: FAILED + CANCELLED are guaranteed on every normalized executor-blocked gate, REWORK additionally available only with proven continuation and remaining budget. Phase 6E full re-audit and complete physical macOS QA are pending. Phase 7 has NOT started.**

**Objective:** Expose the proven headless loop in a small local dashboard while keeping command authority, durable state, and provider logic in the existing KerbsFlow process/core.

**6E remediation boundaries:** Gate resolution goes through RunCoordinator and the core transaction. `FAILED`/`CANCELLED` release the matching reservation after durable terminal proof and drive settlement. `REWORK` continues only the same held executor-blocked drive, through Planning Master with matching gate/task/attempt and remaining attempt budget. Other nonterminal targets or origins, settled drives, and restart continuations reject before gate mutation. Pause/Resume preserve the held gate; Cancel wakes the existing checkpoint. Command replay cannot launch another drive or release a newer reservation.

**Supervision semantics:** Project is the bounded/redacted basename of the trusted repository binding. Lifecycle phase is derived from persisted state: `IDLE` → idle; `INTAKE` → intake; `PLAN`/`READY` → planning; `EXECUTE` → execution; `VERIFY_FOCUSED`/`VERIFY_PHASE`/`FINAL_VERIFY` → verification; `REVIEW` → review; `REWORK` → rework; `NEXT_PHASE` → phase boundary; `HUMAN_GATE`/`HUMAN_RELEASE_GATE` → human decision; `PAUSED` → paused; `RECOVERY` → recovery; `FAILED`/`CANCELLED`/`DONE` → terminal. This is not a product phase ID. Canonical/SPEC status records capture, not current file validity. Invariant policy is effective configuration, not a run-wide validation pass; observed scope/invariant checks require matching task/attempt evidence. Retry/rework/escalation counts are policy decisions for the current task, separate from recorded attempts. Pause/recovery details render persisted facts. Cancel reasons use one shared non-empty, ≤1024 UTF-8 byte contract.

**Selected UI approach:** Static HTML/CSS and browser ES modules, served by the existing KerbsFlow Node process using the built-in HTTP module. The UI surface is small, the repository has no UI framework/build stack or KerbsFlow HTTP UI server today, and another framework/build dependency has no demonstrated v0.1 benefit. This is an implementation choice within the SPEC's loopback HTTP/JSON + SSE boundary; it does not change the product contract, so this plan records it without changing the SPEC.

**Process and authority boundary:**

- One existing KerbsFlow process owns the listener and the existing core/SQLite connection. Bind only to `127.0.0.1` on an OS-assigned ephemeral port. Define start, ready, and close lifecycle behavior; closing or disconnecting the dashboard must not cancel a run. Never create a second database owner or let browser code write SQLite/state directly.
- Route run creation through the existing orchestration/run-start boundary; route lifecycle and gate actions through core command methods. Inspect/snapshot is read-only. Preserve the real-executor cancellation ordering: persist cancellation intent before signaling the owned process/adapter.
- Generate 32 cryptographically random bytes per process launch. Keep the token in process memory, bootstrap it into the no-store dashboard document, and keep the browser copy in page memory only. Do not put it in a URL, local storage, logs, persisted state, or repository content. Require it on every `/v1` request, including snapshots and SSE, using `X-KerbsFlow-Token`.
- Require the exact `Host` for `127.0.0.1:<assigned-port>` on all local requests. Read-only `GET`/`HEAD` requests may omit `Origin` because normal same-origin browser reads do not reliably send it; if present, require the exact origin `http://127.0.0.1:<assigned-port>`. Require that exact origin on every non-`GET`/`HEAD` `/v1` mutation. Keep the per-launch token required for every `/v1` request and do not enable permissive CORS. Permit a top-level `GET /` without `Origin`, but only with the exact Host.
- Send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame denial (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), and a restrictive same-origin CSP for the static assets and API connection.

**Versioned local API:** Implement only these routes; do not add generic RPC or arbitrary filesystem-path access:

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/v1/runs/:runId/snapshot` | Bounded authoritative read model and recent persisted activity |
| `GET` | `/v1/runs/:runId/events` | Authenticated SSE notifications keyed by persisted transition sequence |
| `POST` | `/v1/runs` | Start through existing orchestration boundary |
| `POST` | `/v1/runs/:runId/pause` | Core pause command |
| `POST` | `/v1/runs/:runId/resume` | Core resume command |
| `POST` | `/v1/runs/:runId/steer` | Persisted human instruction under the constraints below |
| `POST` | `/v1/runs/:runId/cancel` | Core cancellation command and durable cancellation ordering |
| `POST` | `/v1/runs/:runId/gates/:gateId/resolve` | Run- and gate-scoped core resolution |
| `GET` | `/v1/runs/:runId/artifacts/:artifactId` | Validated artifact-ID lookup scoped to the owning run |

Every mutation uses one runtime-validated JSON envelope with `commandId`, `idempotencyKey`, `expectedStateVersion`, and command-specific payload; start uses expected state version `0`. The current core/API creates command IDs internally, so 6A makes the smallest adjustment needed to accept and persist the supplied ID through the existing command path. Reuse the existing idempotency and state-version checks; do not create an HTTP-side idempotency store. Reject unknown fields and malformed JSON. Bound JSON request bodies to 64 KiB, Steer text to 4 KiB, gate notes to 4 KiB, and cancellation reasons to 1 KiB. Use the existing runtime-validation style, not a new validation framework.

Map malformed/schema errors to `400`, missing/wrong token to `401`, Host/Origin failures to `403`, unknown run/gate/artifact to `404`, state-version/idempotency/current-state conflicts to `409`, oversized bodies to `413`, and unexpected failures to sanitized `500`. Never include stack traces, paths, secrets, or provider diagnostics in responses.

**Snapshot, events, and artifacts:**

- Build the snapshot from the current persisted read model: run ID/state/state version, project identity, task, active attempt/adapter/model/phase, recovery and pause details, current human gate, latest validation/review, retry/escalation information, and bounded recent transitions/activity and artifact metadata/IDs. Exclude raw database content, environment, credentials, unbounded logs, and arbitrary paths.
- Use persisted transition sequence IDs for SSE cursor/reconnect. Authenticate SSE with `fetch` and `X-KerbsFlow-Token` (native `EventSource` cannot set that header). Send progress/invalidation notifications only; the client refetches the snapshot as canonical state. On reconnect or a sequence gap, refresh from the snapshot. Never rebuild canonical state from an event stream. UI/SSE disconnect does not mutate or cancel a run.
- Resolve artifacts only by validated artifact ID. Verify persisted ownership by the requested run before calling `FileArtifactStore.get()`, preserving its hash/size/path-confinement checks. Add only the minimal read-only ownership lookup if the existing read model does not expose it. Return conservative content type/disposition; never accept a path from the client.

**Steer contract:** Steer does not exist in the current core. 6C adds only a bounded, run-bound, durable, idempotent human instruction, with actor recorded as human. It must not rewrite an active prompt or mutate an in-flight attempt/state; the Planning Master consumes it once at the next safe boundary. Keep at most one pending human instruction and persist consumed status/evidence. Material scope, security, or permission implications still go through the normal human gate; Steer cannot grant permissions or broaden scope automatically. Do not add chat history, arbitrary agent messages, or a prompt editor.

**Approved Phase 6C implementation plan:**

1. **6C.1 — Steer + Planning Master integration.** Establish the Steer contract, persistence invariant, and initial/rework Planning Master boundaries.
2. **6C.2 — RunCoordinator + local API/dashboard controls.** Add truthful Start and coordinated Pause/Resume/Cancel, then wire the approved controls through the existing API and dashboard.
3. **6C.3 — Focused integration + physical macOS control QA.** Validate distinct failure modes and the controls on the supported host; preserve headless behavior.

**Steer persistence and planning:** Steer is at most 4096 UTF-8 bytes, secret-checked before persistence, durable, run-bound, idempotent, recorded as actor `human`, and never chat/history, a prompt editor, an in-flight prompt mutation, or a state transition. Use a minimal `steer_instructions` table; derive pending state from unconsumed rows and enforce one pending instruction per run with a partial UNIQUE index. Bind the originating command and durably bind consumption to the planning command and decision. Reuse `StateStore.executeCommand()` without a transition or second idempotency subsystem. Snapshots expose only bounded metadata (for example ID, creation time, pending status), never raw Steer text. Consume exactly once in the transaction accepting a Planning Master decision; rejected or failed planning leaves it pending. Material scope, security, or permission implications still require the Human Gate.

Both `PLAN -> READY` and `REWORK -> READY` are Planning Master boundaries; do not add `REWORK -> PLAN`. Before accepting bounded rework, provide the diagnosed failure, prior persisted decision, and pending Steer if present, then obtain a corrected `PlanningDecision`. It may change the decision ID, bounded correction summary, rework action kind, and eligible route/model/reasoning. It must preserve `selectedSkills`; the current `ProjectPolicy` has no skills allowlist. Unless a Human Gate approves otherwise, it also preserves run/task identity, canonical binding, policy authority, approved positive scope (except narrowing), negative scope, acceptance criteria, validation strength, required capabilities, permissions, and invariants. Protections may strengthen; scope may narrow. Each decision binds to the exact pending Steer observed, including explicit `none`; compare it atomically with current pending state at acceptance. If Steer changed during planning, reject the stale decision and plan again. Consume Steer atomically with accepted `PLAN -> READY` or `REWORK -> READY`.

**Coordinator, trusted launch, and Start:** Add one small process-local `RunCoordinator`. It owns only the single active-run/drive reservation, async `Phase2Loop` drive ownership, control coordination/checkpoints, trusted launch-context handoff, and pause/cancel race serialization. It does not own SQL/state transitions, Planning Master authority, routing or verification policy, worktrees, adapter signals, or provider lifecycle logic; those stay with existing owners. Trusted host-side launch context contains the canonical repository path, versioned launch-profile ID/hash, trusted focused and optional phase check profiles, execution timeout/failure policy, Planning Master dependency, and routing/model policy. The `POST /v1/runs` browser input remains `runId` and `objective` within the existing command envelope; objective is its only human task input. The browser never supplies paths, a `PlanningDecision`, verification commands, routing authority, permissions, or security policy. Persist repository identity and launch-profile binding atomically with accepted Start, with no `INTAKE` run lacking its trusted binding.

Before creating a run, require trusted launch context and reserve the one active-run slot. Successful Start means orchestration accepted ownership, the `Phase2Loop` drive is installed/owned, and the run entered intake; an unattended `INTAKE` row is not success. Duplicate idempotent Start cannot launch another drive; a competing Start conflicts while the slot is owned. On startup/restart, inspect unfinished persisted runs before accepting another Start; never blindly replay ambiguous worktree creation or execution.

**Drive, pause, cancellation, and recovery:** Preserve the Phase2Loop lifecycle. Refactor `run()` into a compatibility wrapper and a resumable drive for an already-started run. The drive receives trusted host context and a small control-checkpoint hook; production planning happens inside the drive, not from an initial browser/precomputed `PlanningDecision`. Check controls before new side effects and after awaited executor/verifier work. Resume only from a proven persisted safe checkpoint; if continuation cannot be proven, Recovery/Human Gate wins over replay.

Pause is coordinator-controlled: claim pause, prevent new work, let the currently owned operation settle/reconcile, and call `core.pause()` only when quiescent. The core selects and persists `resumeTarget`; report `PAUSED` only after that commit. Never suspend an arbitrary process or report `PAUSED` while executor/verifier work is active or ambiguous. If quiescence is uncertain, do not report pause success; use `RECOVERY`/gate where legal. Resume must restart/continue the drive from the persisted safe checkpoint; `core.resume()` alone is insufficient.

For a real nonterminal attempt, cancellation follows `requestRealCancellation()` (durable `REQUESTED` intent) -> `signalRealCancellation()` -> persist signal evidence -> `reconcileRealCancellation()` -> `CANCELLED` only on proven terminal cancellation, otherwise `RECOVERY`. Neither local API nor RunCoordinator calls `adapter.cancel()` directly. Claim cancellation before awaiting; transactional attempt-result ingestion checks durable cancellation intent so exactly one path wins, without double completion or duplicate external signal. If normal completion wins first, quiesce and cancel from the resulting safe state. After restart, reconcile persisted identity before any `REQUESTED` signal; never blindly re-signal `SIGNAL_PENDING`; uncertainty remains Recovery. Narrow core real-adapter cancellation protection only as needed for terminal, already-quiescent attempts while preserving durable intent ordering.

**6C exits and expected files:**

- **6C.1:** Steer contract/persistence and one-pending invariant; initial PLAN and REWORK Planning Master handoff; planner receives Steer; accepted decisions atomically consume the observed Steer; rejection/staleness leaves it pending; no state-machine graph change. Expected files: `contracts.ts`, `persistence.ts`, `core.ts`, `planning.ts`, `phase2.ts`; `routing.ts` only if refreshed trusted routing evidence requires it.
- **6C.2:** RunCoordinator, truthful Start, coordinated Pause/Resume/Cancel, scoped gate resolution, `/steer`, and dashboard controls; existing Host/Origin/token/body/`commandId` boundaries stay unchanged. Expected additions: `run-coordinator.ts`, `local-api.ts`, `index.ts`, `ui/index.html`, `ui/app.js`, `ui/styles.css`.
- **6C.3:** Focused distinct failure-mode validation, physical macOS QA of controls, and preserved headless behavior.

**6C validation policy:** Default to adding no test; add one only for a materially distinct failure, as needed for: the one-pending SQLite invariant; restart before Steer consumption; exactly-once accepted consumption; rejected/stale planning retention or Steer arriving during planning; Steer observed at REWORK; Start without owned orchestration or concurrent Start; Pause during active/ambiguous work; completion/Cancel races producing at most one signal; `REQUESTED`/`SIGNAL_PENDING` restart reconciliation; and stale UI mutations refreshing without success. Do not duplicate generic API-envelope/security tests or add tests for button count, CSS/pixels, coverage, or implementation shape. No React/Vite/framework/dependency change, state-machine graph change, merge, tag, release, or deployment.

**Dashboard:** One compact view with header/run identity, current work and attempt, validation/scope, human gate and consequences, available controls, and bounded activity. Render repository/provider/model text as inert text, never raw HTML or ANSI. Include clear loading, empty, disconnected/stale, and error states.

**Out of scope:** Remote access, accounts, collaboration, cloud hosting, a frontend framework/build dependency, WebSockets, UI-owned database access, generic RPC, arbitrary terminal/file browsing, client-supplied paths, raw HTML/ANSI rendering, and Phase 7 release actions.

**Checkpoints and exit criteria:**

- **6A — Local protocol and security boundary.** Own the loopback listener lifecycle, token bootstrap, Host/Origin checks, API schemas/body limits/error mapping, bounded snapshot, command delegation/ID handling, artifact-by-ID ownership, and authenticated SSE cursor contract. Test failure modes for foreign Host; foreign or required-but-missing Origin; missing/wrong/valid token; oversized body before processing; malformed/extra-field body; stale state version; duplicate idempotent command executing once; illegal HTTP transition; pathlike/traversal artifact ID; artifact owned by another run; unauthenticated SSE; reconnect/sequence gap repaired by snapshot; UI/server disconnect not canceling a run; and headless operation without the server. Keep tests synthetic and deterministic. No test-count target.
- **6B — Read-only dashboard.** Add the static document/styles/modules, initial snapshot rendering, connection/reconnect state, bounded activity, validation, scope, and human-gate display. Demonstrate that text is inert and no command or state transition originates from rendering. **Status: CLOSED / PASS after physical macOS QA at approved implementation baseline `d2c9a638c6e692ff516f4b7bf7c9fb92752207c4`.**
- **6C — Core controls.** Implement the approved 6C.1–6C.3 slices above; mark complete only when all three exit criteria are met.
- **6D — UX hardening.** Cover stale snapshot refresh, SSE gaps/reconnect, empty/loading/error states, keyboard/accessibility, responsive layout, and inert rendering of untrusted content. Verify disconnect and UI restart preserve the headless run.
- **6E — Phase 6 full audit.** Review the complete diff and API trust boundary, run the headless regression suite without the UI/server, exercise the complete dashboard lifecycle, perform physical macOS UI QA, and obtain independent review of security, state authority, recovery, and scope. Close only with evidence against the Phase 6 acceptance criteria.

**Phase 6 acceptance criteria:**

- The existing headless suite and core behavior remain usable without starting the UI server.
- UI restart/disconnect does not cancel or corrupt a run; authenticated snapshot plus persisted SSE sequence repairs missed events.
- Every mutation is host/origin/token/schema/command-ID/state-version checked and delegates to the core/orchestration boundary; duplicate commands do not execute twice and illegal transitions remain illegal.
- Browser code cannot write persisted state, bypass a human gate, expand Steer authority, or access an artifact outside its run.
- Persisted/UI summaries are bounded and redacted; external text renders inertly.

**Expected route:** OpenCode/Muse for ordinary UI implementation if verified; Codex/Luna Max fallback; Codex/Sol High for local-boundary security and independent Phase 6 review.

## Phase 7 — Full v0.1 gate and release preparation

**Objective:** Establish evidence-backed release readiness without performing merge, tag, release, or deployment.

**Exact scope:**

- Verify the resolved Apache-2.0 license decision and macOS-only official v0.1 support remain reflected in release evidence. Linux remains unsupported preview/best-effort, with no v0.1 compatibility guarantee or release gate; Windows remains deferred and unsupported.
- Freeze contract/migration versions and document tested Codex/OpenCode/runtime/support versions.
- Run the complete deterministic gate from the SPEC on the officially supported macOS host. Do not require Linux preview validation for v0.1 release readiness.
- Run synthetic end-to-end pass, rework, escalation, human gate, cancel, executor crash, orchestrator crash, and recovery scenarios through both adapters where live credentials are available; label unavailable live checks accurately.
- Review dependencies/licenses, public artifacts/fixtures, secrets, `.gitignore`, install/run guidance, and release diff.
- Perform independent critical code, architecture, security, recovery, and simplification review; fix only within SPEC.
- Present the final human release gate with evidence and remaining risks.

**Out of scope:** Automatic merge, push, tag, release publication, deployment, production, community automation, and post-v0.1 features.

**Acceptance criteria:**

- All 15 v0.1 SPEC acceptance criteria have current evidence on macOS or are explicitly not tested and block release readiness. Linux preview evidence is outside the v0.1 support matrix.
- No weakened validation, unfinished stub, silent fallback, secret/private content, operational database, or raw worktree is present in the release diff.
- Migrations/recovery and macOS process/worktree tests pass.
- Provider/version limitations and residual risks are visible in the human release gate.
- License text matches the human decision and copyright ownership.

**Focused validation:** None substituted for the full gate. Re-run only invalidated scopes after fixes, then the final integrated release gate.

**Exit condition:** Planning Master enters `HUMAN_RELEASE_GATE`; only the human decides merge/tag/release. `DONE` records that decision without performing prohibited actions.

**Expected route:** Codex/Sol High for independent critical review and final verification; use another verified route for implementation fixes when appropriate.

## Current gate

- Phase 5 is independently confirmed **PASS** at approved baseline `16359e9a37e62bc37da8b2c480fca88fe855a2dd`; macOS is the only officially supported v0.1 host, Linux is unsupported preview/non-blocking, and Windows is deferred/unsupported.
- Phase 6A is complete at approved HEAD `5f017cff55fbf81a137a8163fdb42e47249f2328`; Phase 6B is CLOSED at approved implementation baseline `d2c9a638c6e692ff516f4b7bf7c9fb92752207c4` after physical macOS QA **PASS**; Phase 6C.1 is CLOSED / **PASS** at approved implementation baseline `c5a4a683af63f988b06ded852a9462e05f9e92c8`.
- Phase 6C.2A — RunCoordinator + control-plane core is CLOSED / **PASS** at approved implementation baseline `5d8e3524d69d20b2e6e2249169e88b50041d1d32`. Phase 6C.2B — local API + dashboard controls is CLOSED / **PASS** at approved implementation baseline `841563b72c072d4559d8bd83aec50d9643c1832a`. Phase 6C.3 — focused integration + physical macOS control QA is CLOSED / **PASS** at approved implementation baseline `e0f2c111ad02a280f5e3e20700923dc9550855da`. Phase 6C — Core controls is CLOSED / **PASS** at the same baseline. Phase 6D — UX hardening is CLOSED / **PASS** at approved implementation baseline `4da62642bc10bab626c5bebbe11d2adf07a46366`. Phase 6E audit at `07d9ff5a6b58565e4734ea4ec05ffc29610318bb` found three blockers, remediated at `f07066c24683ac8ea17929f63e770a4b1714579f`. Phase 6E re-audit at `891a686b0f6151c30dbb3023e2fcbcda2abdfb7b` found an additional Human Gate contract issue, remediated at this HEAD (executable gate continuations; RECOVERY→HUMAN_GATE requires a settled attempt). Phase 6E re-audit at `196fdc83caa5d6d88ec0527724bd5294c3c04e64` found executor Human Gates did not always guarantee both terminal choices, remediated at this HEAD (FAILED + CANCELLED guaranteed; REWORK only with proven continuation and budget). Phase 6 remains OPEN; Phase 6E remains OPEN pending full re-audit and complete physical macOS QA. Phase 7 has NOT started.
- Phase 6E re-audit at `1e4a23c9109bfc6d8c7b537552db141aa1c4a00b` found snapshot text redaction could mutate a path-like executor option ID to `[path redacted]` and break gate resolution. Executor gate options now receive Core-owned safe control IDs before persistence; snapshots validate and project them unchanged while keeping human-readable gate text bounded and redacted. Authenticated gate resolution using the exact snapshot-delivered ID is verified. Phase 6 remains OPEN; Phase 6E remains OPEN pending full re-audit and complete physical macOS QA; Phase 7 has NOT started.
- Consolidated Phase 6E audit at `f1f24060944ab1843607c84578dff215059667b5` found B1/B2/B3. Remediation: executor gates retain one Core-owned option per semantic target with bounded terminal choices; Local API snapshots expose REWORK only when RunCoordinator has a live continuation and show only actionable terminal options after restart; direct FAILED/CANCELLED recovery rejects PREPARED/RUNNING/UNKNOWN attempts and preserves terminal attempt evidence. Focused suites passed 133/133, the full suite passed 314/314, and typecheck/build passed. Phase 6 remains OPEN; Phase 6E remains OPEN pending the full re-audit and complete physical macOS QA; Phase 7 has NOT started.
- Next action: full Phase 6E re-audit and complete physical macOS QA.
