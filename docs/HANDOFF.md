# KerbsFlow handoff

- **State:** Phase 5 final pre-Linux F1/F2 corrections are implemented on `phase5/isolation-operational-hardening`; F3–F5 remain accepted. Phase 6 is not started. Verdict: **PASS_IMPLEMENTATION_PENDING_LINUX**; support-matrix exit remains **BLOCKED**.
- **Evidence/blockers:** macOS Darwin 24.3.0 / Node v24.15.0 passed the actual `.env`/`.env.*` Seatbelt probe, focused Git/sandbox/process/SQLite/cleanup tests, typecheck, 237 tests, high-severity npm audit, and diff check. Independent re-audit and real Linux Node 24 operational evidence are pending. Linux is **NOT TESTED**; Bubblewrap requires upstream 0.12.0+ or trusted CVE-2026-87766 backport evidence and a passing adversarial probe. The pinned dependency tree has 16 moderate and 6 low advisories.
- **Next action:** Independently re-audit this Phase 5 diff, then run the real Linux Node 24 operational gate before considering support-matrix **PASS**.
