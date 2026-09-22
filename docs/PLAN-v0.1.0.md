# KerbsFlow v0.1.0 implementation plan

Status: **Phase 4 implementation, deterministic validation, and independent audit complete at approved baseline `15274317000dd724ae3b280a0de82f0d477b6d1d`**

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

**Objective:** Close the remaining filesystem, process, worktree, network, secret, artifact, and cross-platform risks on the approved support matrix.

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
- Known secrets and sensitive environment values are absent from persisted state/logs/artifacts and public fixtures.
- Cancellation terminates the owned process tree or produces an explicit recovery gate on every supported OS.
- Cleanup never force-removes unknown dirty work and can reconcile interrupted removal safely.
- SQLite remains consistent through migration/crash tests; any journaling change is evidence-backed and documented in the SPEC.

**Focused validation:** Adversarial path/symlink/argv/env/log fixtures; network-policy capability tests; process-tree tests per OS; dirty/missing/moved worktree matrix; database corruption/migration backup tests.

**Exit condition:** Security/recovery review finds no unresolved high-severity boundary issue for the v0.1 support matrix.

**Expected route:** Codex/Sol High for implementation decisions and independent security/hardening review.

## Phase 6 — Thin local UI

**Objective:** Expose the proven headless loop without moving authority or provider logic into the UI.

**Exact scope:**

- Implement the versioned loopback HTTP/JSON snapshot/command surface and SSE notifications over persisted state versions.
- Add per-launch token, strict host/origin/no-CORS policy, schema/size validation, conflict/idempotency responses, and artifact-ID confinement.
- Select the smallest maintainable local UI approach only after comparing dependency cost against a minimal native/static implementation; record any material decision in the SPEC.
- Render project, run/state/phase, task, executor/model, SPEC/scope/invariants, validations, retries/escalations, activity, and human gate.
- Implement Pause, Resume, Inspect, Steer, Cancel, and gate resolution as core commands.

**Out of scope:** Remote access, accounts, collaboration, cloud hosting, UI-owned database access, arbitrary terminal/file browser, raw HTML/ANSI rendering.

**Acceptance criteria:**

- The headless test suite runs unchanged without UI/server.
- UI restart/disconnect does not cancel or corrupt a run; snapshot + SSE sequence repairs missed events.
- Every mutation requires token, valid origin/host, schema, command ID, and expected state version.
- UI cannot produce an illegal transition or bypass a human gate.
- Repository/model text renders inertly and artifacts cannot traverse the runtime root.

**Focused validation:** API contract/state-conflict/idempotency tests; origin/token/CSRF-like localhost tests; SSE reconnect; escaped-content fixtures; UI smoke flows for run, gate, pause/resume/cancel.

**Exit condition:** A user can supervise the entire proven loop locally while the same behavior remains available headlessly.

**Expected route:** OpenCode/Muse for ordinary UI work if verified; Codex/Luna Max fallback; Codex/Sol High security review of the localhost boundary.

## Phase 7 — Full v0.1 gate and release preparation

**Objective:** Establish evidence-backed release readiness without performing merge, tag, release, or deployment.

**Exact scope:**

- Verify the resolved Apache-2.0 license decision and macOS/Linux v0.1 support matrix remain reflected in the release evidence; Windows remains deferred until its explicit platform gates pass.
- Freeze contract/migration versions and document tested Codex/OpenCode/runtime/support versions.
- Run the complete deterministic gate from the SPEC across the approved platforms.
- Run synthetic end-to-end pass, rework, escalation, human gate, cancel, executor crash, orchestrator crash, and recovery scenarios through both adapters where live credentials are available; label unavailable live checks accurately.
- Review dependencies/licenses, public artifacts/fixtures, secrets, `.gitignore`, install/run guidance, and release diff.
- Perform independent critical code, architecture, security, recovery, and simplification review; fix only within SPEC.
- Present the final human release gate with evidence and remaining risks.

**Out of scope:** Automatic merge, push, tag, release publication, deployment, production, community automation, and post-v0.1 features.

**Acceptance criteria:**

- All 15 v0.1 SPEC acceptance criteria have current evidence or are explicitly not tested and block release readiness.
- No weakened validation, unfinished stub, silent fallback, secret/private content, operational database, or raw worktree is present in the release diff.
- Migrations/recovery and supported-platform process/worktree tests pass.
- Provider/version limitations and residual risks are visible in the human release gate.
- License text matches the human decision and copyright ownership.

**Focused validation:** None substituted for the full gate. Re-run only invalidated scopes after fixes, then the final integrated release gate.

**Exit condition:** Planning Master enters `HUMAN_RELEASE_GATE`; only the human decides merge/tag/release. `DONE` records that decision without performing prohibited actions.

**Expected route:** Codex/Sol High for independent critical review and final verification; use another verified route for implementation fixes when appropriate.

## Current gate

- Phase 3 is independently confirmed at `00e6924c057d6f3e28dfbea3f10f03896f84b07f`. Phase 4 implementation and all targeted independent-audit corrections are independently confirmed **PASS** at approved baseline `15274317000dd724ae3b280a0de82f0d477b6d1d`: core dispatch requires durable trusted provenance, and prepared descriptors are hash-bound to authoritative discovery. Focused routing/OpenCode validation and the full deterministic gate are green; live OpenCode remains **NOT RUN** because readiness reports no enabled provider/model, with enforcement honestly `tool_policy_only`. Phase 5 has not started. Next action: begin Phase 5 from the approved Phase 4 baseline.
