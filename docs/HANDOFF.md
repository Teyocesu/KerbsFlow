# KerbsFlow handoff

- **Current state:** The final Phase 4 routing-authority correction is implemented but uncommitted on `phase4/opencode-routing`: `beginAttempt()` fails closed without matching durable authority, and prepared adapter descriptors are capability-hash-bound to authoritative discovery. The focused suites and full deterministic gate are green; Phase 5 has not started.
- **Residual risks:** Live OpenCode smoke was not run because readiness reported no enabled provider/model; enforcement is honestly `tool_policy_only`, and the pinned SDK tree has 6 low/16 moderate audit advisories but no high/critical finding.
- **Next action:** Review and commit the working-tree correction, then independently confirm the resulting `phase4/opencode-routing` HEAD; do not start Phase 5.
