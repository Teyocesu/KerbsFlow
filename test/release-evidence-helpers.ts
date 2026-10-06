import { createHash } from "node:crypto";
import { RELEASE_REQUIRED_LIMITATIONS, RELEASE_PROHIBITED_ACTIONS, type ReleaseEvidenceCandidate, type ReleaseEvidenceDossier } from "../src/contracts.js";

// Synthetic evidence only: this fixture never represents a completed repository release gate.
export function syntheticReleaseDossier(candidate: ReleaseEvidenceCandidate = { headOid: "1".repeat(40), baseOid: "1".repeat(40), fingerprint: "2".repeat(64) }, options: { branch?: string; codexVersion?: string; profileHash?: string } = {}): ReleaseEvidenceDossier {
  const digest = createHash("sha256").update("synthetic release fixture").digest("hex");
  const refs = ["evidence_gate"];
  const check = (summary: string) => ({ outcome: "PASS" as const, summary: `Synthetic ${summary}`, evidenceRefs: [...refs] });
  return {
    schemaVersion: "kerbsflow.release-evidence/v1",
    candidate: { ...candidate, sourceBaseline: candidate.baseOid, branch: options.branch ?? "master", clean: true, hashes: { source: digest, contracts: digest, profile: options.profileHash ?? digest, migrations: digest, package: digest, lock: digest } },
    host: { platform: "darwin", macOSVersion: "15.3.2", macOSBuild: "24D81", arch: process.arch, node: process.versions.node, npm: "11.12.1", typescript: "5.9.3", nodeTypes: "24.13.6", sqlite: process.versions.sqlite!, git: "2.39.5" },
    support: { macOS: "official", linux: "unsupported_preview", windows: "unsupported", license: "Apache-2.0", copyright: "Teyocesu 2026", licenseNotice: check("license and notice comparison") },
    adapters: [
      { adapter: "codex", version: options.codexVersion ?? "0.155.0-fixture", provider: "openai", model: "fixture-model", identityHash: digest, capabilityHash: digest, workload: "os_enforced", readiness: "tested", summary: "Synthetic CLI boundary", evidenceRefs: ["evidence_provider"] },
      { adapter: "opencode", version: "2.0.13", provider: "opencode", model: "opencode/muse-fixture", identityHash: digest, capabilityHash: digest, workload: "tool_policy_only", readiness: "tested", summary: "Synthetic owned V2 provider boundary", evidenceRefs: ["evidence_provider"] },
    ],
    evidence: [
      { id: "evidence_gate", classification: "automatically_tested", boundary: "actual", origin: "fresh", candidateHead: candidate.headOid, hash: digest, summary: "Synthetic fixture metadata for the complete gate" },
      { id: "evidence_provider", classification: "simulated", boundary: "synthetic", origin: "fresh", candidateHead: candidate.headOid, hash: digest, summary: "Synthetic provider attribution" },
    ],
    acceptance: Array.from({ length: 15 }, (_, i) => ({ id: `AC${i + 1}`, outcome: "PASS", summary: `Synthetic AC${i + 1} attribution`, evidenceRefs: [...refs], limitations: ["Provider inference is synthetic"] })),
    deterministicGate: { ...check("deterministic gate"), candidateHead: candidate.headOid, commands: ["npm run typecheck", "npm test"].map(command => ({ command, exitCode: 0, outputHash: digest, evidenceRefs: [...refs] })), suites: { discovered: 27, executed: 27, failures: 0, cancellations: 0, skips: 0, todos: 0, inventoryHash: digest }, boundaries: { sandbox: check("sandbox"), processes: check("process trees"), worktrees: check("worktrees"), migrations: check("migration checksums and rollback"), recovery: check("owner recovery") }, integrity: check("candidate integrity") },
    scenarios: ["codex", "opencode"].flatMap(adapter => Array.from({ length: 13 }, (_, i) => ({ id: `X${i + 1}`, adapter: adapter as "codex" | "opencode", outcome: "PASS" as const, classification: "simulated" as const, boundary: "synthetic" as const, evidenceRefs: ["evidence_provider"], limitations: ["Synthetic provider and dossier; not a final 7D result"] }))),
    dependencies: { ...check("dependency review"), audit: { status: "complete", advisories: 0, evidenceRefs: [...refs], riskDispositionRefs: [] }, licenses: check("dependency licenses and required notices"), provenance: check("integrity and install hooks"), packageSurface: check("package dry-run surface") },
    secrets: { scan: check("deliberate secret scan"), provenanceInspection: check("fixture and public artifact provenance") },
    reviewHistory: { broad: check("broad independent review"), remediation: check("consolidated remediation"), postFix: check("post-fix independent reviews"), knownBlockers: 0 },
    liveProvider: { status: "not_tested", reason: "not opted in", evidenceRefs: [] },
    limitations: [...RELEASE_REQUIRED_LIMITATIONS, "Live provider NOT TESTED — not opted in"],
    prohibitedActions: [...RELEASE_PROHIBITED_ACTIONS],
  };
}
