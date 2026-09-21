# KerbsFlow repository rules

- The active `docs/SPEC-*.md`, `docs/PLAN-*.md`, and `docs/HANDOFF.md` are the canonical product contract, execution plan, and continuation state. In that order, they override routine preferences.
- Keep v0.1 lean. Reuse platform capabilities and existing dependencies before adding abstractions or packages.
- Never silently change product intent, architecture, scope, acceptance criteria, invariants, security boundaries, or compatibility. Record material uncertainty and request a human decision.
- Treat executor claims as untrusted evidence. Persist structured results and independently inspect the diff, scope, checks, and anti-greenwashing signals before declaring success.
- Validate progressively: focused behavior first, then the affected phase/subsystem, then the full release gate when warranted. Never weaken a gate to obtain green.
- Do not commit secrets, credentials, private-repository content, operational databases, worktrees, or unredacted run artifacts. Public fixtures must be synthetic.
- High-impact actions, including secret exposure, destructive operations, push, merge, tag, release, deployment, and production access, require the human gates defined by the SPEC.
- Keep `docs/HANDOFF.md` extremely short: current state, unresolved blockers, and the exact next action only.
