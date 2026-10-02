# KerbsFlow v0.1

KerbsFlow is a local orchestration library for supervised coding work. A trusted Planning Master proposes bounded tasks; Core validates commands, owns the 18-state lifecycle and persists decisions in SQLite. Executor claims remain untrusted until independent verification. This checkout is private package metadata, not an npm-published application or CLI.

Official v0.1 support is **macOS with Node 24**. Linux is an unsupported preview with best-effort, fail-closed Bubblewrap checks. Windows is unsupported. Required macOS verification uses Seatbelt (`/usr/bin/sandbox-exec`); missing or unproven isolation produces a Human Gate. License: Apache-2.0, Teyocesu, 2026.

From the checkout:

```sh
npm ci
npm run typecheck
npm run build
```

There is no `npm start` or installed KerbsFlow CLI. Built library modules are under `dist/src/`; tests are under `dist/test/`. Import the actual checkout paths:

```js
import {
  StateStore, KerbsFlowCore, RunCoordinator, LocalApiServer,
  CodexAdapter, FileArtifactStore, GitWorktreeManager,
  Phase2Loop, FocusedVerifier, RandomIdSource,
} from './dist/src/index.js';
import { VerificationSandbox } from './dist/src/verification-sandbox.js';
import { ProcessSupervisor } from './dist/src/process.js';
```

The host application composes one `StateStore`, an executor adapter, a `FileArtifactStore`, Core, a `GitWorktreeManager`, `FocusedVerifier(git, new VerificationSandbox(new ProcessSupervisor()), ids)`, a `Phase2Loop`, and a `RunCoordinator(core, store, loop, trustedLaunchProfile, ids)`. A `LocalApiServer({ core, coordinator, store, artifacts })` serves the optional browser dashboard; call `await server.start()` and open `http://127.0.0.1:${server.port()}/`. Close the server, settle owned provider work, close adapter resources, and finally close the store when shutting down. Disconnecting the browser does not cancel work.

A Planning Master is injected by the host through `trustedLaunchProfile.planningMaster`. It implements `planInitial(input)` and `planRework(input)` and returns a `PlanningMasterResult`; it must obtain runtime-trusted routing authority for Phase 4 decisions. KerbsFlow does not supply an automatic planning model. Browser requests can supply a bounded objective or human instruction, but cannot choose executables, repositories, models, permissions, result ingestion, or recovery authority.

The trusted launch profile fixes the repository, profile ID/hash, execution timeout and focused/phase/optional full check commands. Each check declares its executable, ordered arguments, timeout and a positive proof contract such as:

```js
const focusedCheck = {
  name: 'explicit synthetic assertion',
  executable: process.execPath,
  args: ['-e', "if (2 + 2 !== 4) process.exit(1); console.log('ARITHMETIC_ASSERTION_PROVED')"],
  timeoutMs: 1000,
  proof: { kind: 'stdout_line', expected: 'ARITHMETIC_ASSERTION_PROVED' },
};
```

A phase check additionally declares `level: 'phase'` and `commandId`; a full check declares `level: 'full'` and its own `commandId`. Each positive literal must follow the actual assertions for that profile. Exit zero, arbitrary output, missing proof, timeout or cancellation cannot pass. Check declarations are copied, frozen and durably bound to run/task/attempt and the exact candidate. Lower levels cannot substitute for full. Full success creates an immutable evidence bundle and a Human Release Gate; missing acceptance-specific evidence remains explicitly `not_tested`. The optional full check must be selected by the trusted host, not the browser.

Choose private runtime roots **outside the source checkout**. SQLite is the durable authority; its journal, owner record and migration backups belong to that runtime. Scratch roots are disposable verifier-owned writable areas. Worktrees are isolated, owned Git checkouts, not security sandboxes. Failure, uncertainty and dirty work are retained for inspection rather than silently discarded. Do not commit operational databases, provider staging or worktree records.

The UI listens only on IPv4 loopback at an ephemeral port and uses an instance token plus host/origin validation. It projects bounded, redacted, inert text and run-scoped artifact IDs. Pause waits for an owned checkpoint; Resume requires a real continuation. Cancel records intent before signaling and requires terminal proof. Human Gates present evidence classifications, consequences and only executable choices. A release gate offers Accept readiness (DONE records the human decision only), Request corrections (a persisted request for a separately approved run; no dead REWORK action), and Cancel readiness. Deferring leaves it open.

After a crash, opening an unfinished database preserves uncertainty and enters conservative recovery where needed. A normal opener never deletes a stale owner. For a newly recorded v2 owner, the trusted host can explicitly call `StateStore.open(databasePath, { recoverOwner: true })`; same-host/boot OS process evidence must prove that exact owner stale. Live owners, legacy owner ambiguity and foreign host/boot records fail closed. An ambiguous acquisition guard also needs human handling. This operation does not reset the database. `RunCoordinator.reconcileRecovery(...)` inspects the exact provider attempt and can ingest proven terminal evidence, then continue validation without blind execution replay. Unknown outcomes remain RECOVERY. The browser has no recovery-result injection endpoint.

Codex uses an explicitly configured CLI executable, JSONL and structured terminal results, with independently probed filesystem/network permission profiles. OpenCode uses an owned V2 embedded host and native session reconciliation/interruption. OpenCode's `tool_policy_only` limitation is policy enforcement, not OS sandbox enforcement. Authentication belongs to each provider; the host configures provider-owned authentication. KerbsFlow's smoke script does not read or copy credential stores.

The optional live Codex smoke is opt-in and checks only a disposable `hello.txt` content phase through NEXT_PHASE:

```sh
KERBSFLOW_LIVE_CODEX=1 CODEX_BIN=/absolute/path/to/approved/codex npm run test:live-codex
```

It can invoke a paid provider. It is optional, requires the approved executable explicitly, and does not prove full verification or release readiness. Without opt-in it refuses before invoking the provider. Failed or uncertain smoke runs retain their private runtime material.

KerbsFlow never automatically commits, pushes, merges, tags, publishes, releases, deploys or touches production. A human readiness decision grants none of those operations.
