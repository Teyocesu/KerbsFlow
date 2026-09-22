import { chmodSync, constants, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { KerbsFlowError } from "./errors.js";

export function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function ensurePrivateDirectory(path: string): string {
  const requested = resolve(path);
  const existed = existsSync(requested);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  if (lstatSync(requested).isSymbolicLink()) throw new KerbsFlowError("OWNED_DIRECTORY_LINKED", "KerbsFlow runtime directory cannot be a symbolic link");
  const canonical = realpathSync(requested);
  if (!lstatSync(canonical).isDirectory()) {
    throw new KerbsFlowError("OWNED_DIRECTORY_INVALID", "KerbsFlow runtime path is not a directory");
  }
  if (process.platform !== "win32") {
    const mode = lstatSync(canonical).mode & 0o777;
    if (existed && (mode & 0o077) !== 0) {
      throw new KerbsFlowError("OWNED_DIRECTORY_PERMISSIONS", "existing KerbsFlow runtime directory must already be owner-only; permissions were not changed");
    }
    if (!existed) chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function resolveExistingWithin(root: string, relativePath: string): string {
  assertRelativePath(relativePath);
  const canonicalRoot = realpathSync(root);
  const candidate = realpathSync(resolve(canonicalRoot, relativePath));
  if (!pathIsWithin(canonicalRoot, candidate)) {
    throw new KerbsFlowError("PATH_ESCAPE", "path resolves outside its allowed root");
  }
  return candidate;
}

export function resolveNewWithin(root: string, relativePath: string): string {
  assertRelativePath(relativePath);
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, relativePath);
  const canonicalParent = realpathSync(dirname(candidate));
  if (!pathIsWithin(canonicalRoot, canonicalParent)) {
    throw new KerbsFlowError("PATH_ESCAPE", "path parent resolves outside its allowed root");
  }
  return resolve(canonicalParent, basename(candidate));
}

export function readPrivateFileWithin(root: string, relativePath: string, maximumBytes: number): Buffer {
  assertRelativePath(relativePath);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
    throw new KerbsFlowError("OWNED_FILE_LIMIT_INVALID", "owned-file read bound must be between 1 byte and 64 MiB");
  }
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, relativePath);
  const canonicalParent = realpathSync(dirname(candidate));
  if (!pathIsWithin(canonicalRoot, canonicalParent)) throw new KerbsFlowError("PATH_ESCAPE", "file parent resolves outside its allowed root");
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    if (lstatSync(candidate).isSymbolicLink()) throw new KerbsFlowError("OWNED_FILE_LINKED", "owned file cannot be a symbolic link");
    if (!pathIsWithin(canonicalRoot, realpathSync(candidate))) throw new KerbsFlowError("PATH_ESCAPE", "file resolves outside its allowed root");
    descriptor = openSync(candidate, flags);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new KerbsFlowError("OWNED_FILE_INVALID", "owned path is not a regular file");
    if (before.size > maximumBytes) throw new KerbsFlowError("OWNED_FILE_TOO_LARGE", `owned file exceeds ${maximumBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new KerbsFlowError("OWNED_FILE_TOO_LARGE", `owned file exceeds ${maximumBytes} bytes`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== bytes.byteLength) {
      throw new KerbsFlowError("OWNED_FILE_CHANGED", "owned file changed while it was being read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof KerbsFlowError) throw error;
    throw new KerbsFlowError("OWNED_FILE_UNREADABLE", "owned file is missing, moved, linked, or unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function atomicWritePrivateFile(root: string, relativePath: string, content: string | Buffer, replace = false): string {
  const target = resolveNewWithin(root, relativePath);
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    if (replace) {
      renameSync(temporary, target);
    } else {
      linkSync(temporary, target);
      unlinkSync(temporary);
    }
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new KerbsFlowError("OWNED_FILE_WRITE_FAILED", "owned file write failed without exposing its target or contents");
  }
}

export function assertRelativePath(value: string): void {
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new KerbsFlowError("PATH_INVALID", "path must be a non-empty relative path");
  }
  const normalized = relative(".", resolve(".", value));
  if (normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(normalized)) {
    throw new KerbsFlowError("PATH_ESCAPE", "path escapes its allowed root");
  }
}
