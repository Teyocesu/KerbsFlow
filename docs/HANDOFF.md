# KerbsFlow handoff

- **Current state:** Phase 2 is complete on `phase2/codex-vertical-loop`; deterministic gates and the disposable live Codex smoke pass, and independent review is pending.
- **Unresolved:** Linux process-group behavior was not executed in this macOS session; workspace-write does not provide universal host read isolation. Windows and deeper isolation hardening remain deferred by the PLAN.
- **Next action:** Independently audit the pushed Phase 2 HEAD; do not begin Phase 3 or alter the frozen SPEC before that gate passes.
