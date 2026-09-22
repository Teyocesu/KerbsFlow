import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { RunId } from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import { StateStore, type StoredCanonicalSnapshot, type StoredPhaseBoundary } from "./persistence.js";
import { pathIsWithin } from "./paths.js";

export const CANONICAL_DOCUMENTS = ["AGENTS.md", "docs/SPEC-v0.1.0.md", "docs/PLAN-v0.1.0.md", "docs/HANDOFF.md"] as const;

export interface CanonicalVerification {
  current: boolean;
  expected: Record<string, string>;
  observed: Record<string, string>;
  changed: string[];
}

export class CanonicalIntentGuard {
  constructor(private readonly store: StateStore) {}

  capture(runId: RunId, repositoryPath: string, baseOid: string): StoredCanonicalSnapshot {
    const root = realpathSync(repositoryPath);
    return this.store.recordCanonicalSnapshot({ runId, repositoryPath: root, baseOid, hashes: hashCanonicalDocuments(root) });
  }

  verify(runId: RunId): CanonicalVerification {
    const snapshot = this.store.getCanonicalSnapshot(runId);
    if (snapshot === undefined) {
      throw new KerbsFlowError("CANONICAL_SNAPSHOT_REQUIRED", `run ${runId} has no canonical intent snapshot`);
    }
    const observed = hashCanonicalDocuments(snapshot.repositoryPath);
    const changed = CANONICAL_DOCUMENTS.filter((path) => observed[path] !== snapshot.hashes[path]);
    return { current: changed.length === 0, expected: snapshot.hashes, observed, changed };
  }

  preparePhaseBoundary(boundaryId: string, runId: RunId): StoredPhaseBoundary {
    const verification = this.verify(runId);
    if (!verification.current) {
      throw new KerbsFlowError("CANONICAL_INTENT_DRIFT", `canonical intent changed unexpectedly: ${verification.changed.join(", ")}`);
    }
    return this.store.preparePhaseBoundary({ boundaryId, runId, expectedHashes: verification.expected });
  }

  completePhaseBoundary(boundaryId: string, runId: RunId): StoredPhaseBoundary {
    const snapshot = this.store.getCanonicalSnapshot(runId);
    const boundary = this.store.getPhaseBoundary(boundaryId);
    if (snapshot === undefined || boundary === undefined || boundary.runId !== runId) {
      throw new KerbsFlowError("PHASE_BOUNDARY_INVALID", "phase boundary does not match the canonical snapshot and run");
    }
    const observed = hashCanonicalDocuments(snapshot.repositoryPath);
    for (const protectedPath of ["AGENTS.md", "docs/SPEC-v0.1.0.md"] as const) {
      if (observed[protectedPath] !== boundary.expectedHashes[protectedPath]) {
        throw new KerbsFlowError("CANONICAL_INTENT_DRIFT", `${protectedPath} cannot change during a phase-boundary PLAN/HANDOFF update`);
      }
    }
    return this.store.completePhaseBoundary(boundaryId, observed);
  }
}

export function hashCanonicalDocuments(repositoryPath: string): Record<(typeof CANONICAL_DOCUMENTS)[number], string> {
  const root = realpathSync(repositoryPath);
  return Object.fromEntries(CANONICAL_DOCUMENTS.map((path) => {
    if (isAbsolute(path)) {
      throw new KerbsFlowError("CANONICAL_PATH_INVALID", "canonical path must be repository-relative");
    }
    const candidate = realpathSync(resolve(root, path));
    if (!pathIsWithin(root, candidate)) {
      throw new KerbsFlowError("CANONICAL_PATH_ESCAPE", `${path} resolves outside the repository`);
    }
    return [path, createHash("sha256").update(readFileSync(candidate)).digest("hex")];
  })) as Record<(typeof CANONICAL_DOCUMENTS)[number], string>;
}
