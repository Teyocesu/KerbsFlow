import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { relative } from "node:path";

import type { ArtifactId, AttemptId, RunId } from "./contracts.js";
import { asArtifactId, asAttemptId, asRunId } from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import type { ArtifactReference } from "./fake.js";
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFileWithin, resolveNewWithin } from "./paths.js";
import type { IdSource } from "./runtime.js";
import { containsLikelySecret, publicFixtureIssue, SENSITIVE_RESULT_REJECTION } from "./secrets.js";

export type ArtifactRetentionCategory = ArtifactReference["retentionCategory"];

export interface ArtifactStore {
  put(runId: RunId, kind: string, content: string, attemptId?: AttemptId, retentionCategory?: ArtifactRetentionCategory): ArtifactReference;
}

export interface FileArtifactStoreOptions {
  maximumBytes?: number;
}

export class FileArtifactStore implements ArtifactStore {
  readonly root: string;
  private readonly contentRoot: string;
  private readonly metadataRoot: string;
  private readonly maximumBytes: number;

  constructor(root: string, private readonly ids: IdSource, options: FileArtifactStoreOptions = {}) {
    this.root = ensurePrivateDirectory(root);
    this.contentRoot = ensurePrivateDirectory(resolveNewWithin(this.root, "runs"));
    this.metadataRoot = ensurePrivateDirectory(resolveNewWithin(this.root, "metadata"));
    this.maximumBytes = options.maximumBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1 || this.maximumBytes > 64 * 1024 * 1024) {
      throw new KerbsFlowError("ARTIFACT_LIMIT_INVALID", "artifact size bound must be between 1 byte and 64 MiB");
    }
  }

  put(runId: RunId, kind: string, content: string, attemptId?: AttemptId, retentionCategory: ArtifactRetentionCategory = "active_run"): ArtifactReference {
    assertRetention(retentionCategory);
    if (containsLikelySecret(content)) throw new KerbsFlowError("ARTIFACT_SECRET_REJECTED", SENSITIVE_RESULT_REJECTION);
    const publicIssue = retentionCategory === "public_synthetic_fixture" ? publicFixtureIssue(content) : undefined;
    if (publicIssue !== undefined) {
      throw new KerbsFlowError("PUBLIC_FIXTURE_NOT_SYNTHETIC", `public fixture contains ${publicIssue}`);
    }
    const sizeBytes = Buffer.byteLength(content);
    if (sizeBytes > this.maximumBytes) throw new KerbsFlowError("ARTIFACT_TOO_LARGE", `artifact exceeds ${this.maximumBytes} bytes`);
    const artifactId = asArtifactId(this.ids.next("artifact"));
    runId = asRunId(runId);
    const runDirectory = ensurePrivateDirectory(resolveNewWithin(this.contentRoot, runId));
    const relativePath = relative(this.root, resolveNewWithin(runDirectory, `${artifactId}.json`));
    const reference: ArtifactReference = {
      artifactId,
      runId,
      ...(attemptId === undefined ? {} : { attemptId }),
      kind: safeKind(kind),
      relativePath,
      contentHash: createHash("sha256").update(content).digest("hex"),
      sizeBytes,
      redactionState: "not_applicable",
      retentionCategory,
    };
    atomicWritePrivateFile(this.root, relativePath, content);
    try {
      atomicWritePrivateFile(this.metadataRoot, `${artifactId}.json`, `${JSON.stringify(reference)}\n`);
    } catch (error) {
      rmSync(resolveNewWithin(this.root, relativePath), { force: true });
      throw error;
    }
    return reference;
  }

  get(artifactIdValue: ArtifactId): string {
    const artifactId = asArtifactId(artifactIdValue);
    const reference = this.readReference(artifactId);
    const bytes = readPrivateFileWithin(this.root, reference.relativePath, this.maximumBytes);
    if (bytes.byteLength !== reference.sizeBytes) throw new KerbsFlowError("ARTIFACT_SIZE_MISMATCH", "artifact size does not match its stored metadata");
    const observedHash = createHash("sha256").update(bytes).digest("hex");
    if (observedHash !== reference.contentHash) throw new KerbsFlowError("ARTIFACT_HASH_MISMATCH", "artifact content hash does not match its stored metadata");
    return bytes.toString("utf8");
  }

  setRetention(artifactIdValue: ArtifactId, retentionCategory: ArtifactRetentionCategory): ArtifactReference {
    const artifactId = asArtifactId(artifactIdValue);
    assertRetention(retentionCategory);
    const metadataPath = `${artifactId}.json`;
    const current = this.readReference(artifactId);
    if (retentionCategory === "public_synthetic_fixture") {
      const content = this.get(artifactId);
      const issue = publicFixtureIssue(content);
      if (issue !== undefined) throw new KerbsFlowError("PUBLIC_FIXTURE_NOT_SYNTHETIC", `public fixture contains ${issue}`);
    }
    const next = { ...current, retentionCategory };
    atomicWritePrivateFile(this.metadataRoot, metadataPath, `${JSON.stringify(next)}\n`, true);
    return next;
  }

  private readReference(artifactId: ArtifactId): ArtifactReference {
    const bytes = readPrivateFileWithin(this.metadataRoot, `${artifactId}.json`, 16 * 1024);
    try {
      return parseReference(JSON.parse(bytes.toString("utf8")), artifactId);
    } catch (error) {
      if (error instanceof KerbsFlowError) throw error;
      throw new KerbsFlowError("ARTIFACT_METADATA_INVALID", "artifact metadata is malformed");
    }
  }
}

function parseReference(value: unknown, artifactId: ArtifactId): ArtifactReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new KerbsFlowError("ARTIFACT_METADATA_INVALID", "artifact metadata is not an object");
  const raw = value as Record<string, unknown>;
  const retention = raw.retentionCategory;
  const runId = typeof raw.runId === "string" ? asRunId(raw.runId) : undefined;
  const attemptId = raw.attemptId === undefined || typeof raw.attemptId !== "string" ? raw.attemptId : asAttemptId(raw.attemptId);
  const allowedKeys = new Set(["artifactId", "runId", "attemptId", "kind", "relativePath", "contentHash", "sizeBytes", "redactionState", "retentionCategory"]);
  if (
    Object.keys(raw).some((key) => !allowedKeys.has(key))
    ||
    raw.artifactId !== artifactId
    || runId === undefined
    || (attemptId !== undefined && typeof attemptId !== "string")
    || typeof raw.kind !== "string"
    || safeKind(raw.kind) !== raw.kind
    || raw.relativePath !== `runs/${runId}/${artifactId}.json`
    || typeof raw.relativePath !== "string"
    || typeof raw.contentHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(raw.contentHash)
    || !Number.isSafeInteger(raw.sizeBytes)
    || Number(raw.sizeBytes) < 0
    || (raw.redactionState !== "not_applicable" && raw.redactionState !== "redacted")
    || (retention !== "active_run" && retention !== "retained_failure_recovery" && retention !== "terminal_clean_eligible" && retention !== "public_synthetic_fixture")
  ) {
    throw new KerbsFlowError("ARTIFACT_METADATA_INVALID", "artifact metadata identity, path, hash, size, or retention is invalid");
  }
  return raw as unknown as ArtifactReference;
}

function assertRetention(value: string): asserts value is ArtifactRetentionCategory {
  if (value !== "active_run" && value !== "retained_failure_recovery" && value !== "terminal_clean_eligible" && value !== "public_synthetic_fixture") {
    throw new KerbsFlowError("ARTIFACT_RETENTION_INVALID", "artifact retention category is invalid");
  }
}

function safeKind(kind: string): string {
  const value = kind.trim();
  if (value.length < 1 || value.length > 100 || !/^[a-z0-9._-]+$/iu.test(value)) throw new KerbsFlowError("ARTIFACT_KIND_INVALID", "artifact kind is invalid");
  return value;
}
