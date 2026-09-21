import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { ArtifactId, AttemptId, RunId } from "./contracts.js";
import { asArtifactId } from "./contracts.js";
import type { ArtifactReference } from "./fake.js";
import type { IdSource } from "./runtime.js";

export interface ArtifactStore {
  put(runId: RunId, kind: string, content: string, attemptId?: AttemptId): ArtifactReference;
}

export class FileArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string, private readonly ids: IdSource) {
    const requestedRoot = resolve(root);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    this.root = realpathSync(requestedRoot);
  }

  put(runId: RunId, kind: string, content: string, attemptId?: AttemptId): ArtifactReference {
    const artifactId = asArtifactId(this.ids.next("artifact"));
    const requestedDirectory = this.withinRoot(join(this.root, "runs", runId));
    mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
    const directory = this.withinRoot(realpathSync(requestedDirectory));
    const path = this.withinRoot(join(directory, `${artifactId}.json`));
    writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      artifactId,
      runId,
      ...(attemptId === undefined ? {} : { attemptId }),
      kind,
      relativePath: relative(this.root, path),
      contentHash: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content),
      redactionState: "not_applicable",
    };
  }

  get(artifactId: ArtifactId, relativePath: string): string {
    if (basename(relativePath) !== `${artifactId}.json`) {
      throw new Error("artifact path does not match the requested artifact ID");
    }
    const candidate = this.withinRoot(join(this.root, relativePath));
    return readFileSync(this.withinRoot(realpathSync(candidate)), "utf8");
  }

  private withinRoot(path: string): string {
    const candidate = resolve(path);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}/`)) {
      throw new Error("artifact path escapes the runtime root");
    }
    return candidate;
  }
}
