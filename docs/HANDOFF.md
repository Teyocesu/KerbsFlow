# KerbsFlow handoff

- **State:** Phase 5 F1–F5 audit corrections are implemented on `phase5/isolation-operational-hardening`; the human-approved verifier sandbox prerequisite is recorded in the SPEC. Phase 6 is not started. Support-matrix exit is **BLOCKED**.
- **Evidence/blockers:** macOS Darwin 24.3.0 / Node v24.15.0 passed focused F1–F5 tests, typecheck, 233 deterministic tests, high-severity npm audit, and diff check; a final narrow Seatbelt profile change passed focused sandbox/vertical-loop checks. Independent audit and real Linux Node 24 operational evidence are pending; Linux Bubblewrap requires upstream 0.12.0+ or trusted CVE-2026-87766 backport evidence, plus a passing adversarial probe. The pinned dependency tree has 16 moderate and 6 low audit advisories.
- **Next action:** Independently audit this Phase 5 diff, then run the required operational gate on a real Linux Node 24 host before considering support-matrix **PASS**.
