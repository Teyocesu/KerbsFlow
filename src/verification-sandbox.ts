import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { createServer } from "node:net";

import { KerbsFlowError } from "./errors.js";
import { ProcessSupervisor, type ProcessResult, type SupervisedProcessSpec } from "./process.js";

export interface VerificationCommand {
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface VerificationCapability {
  backend: "seatbelt" | "bubblewrap";
  backendVersion: string;
  platform: NodeJS.Platform;
  filesystemEnforcement: "enforced";
  workloadNetworkEnforcement: "enforced";
  probeAt: string;
  probeHash: string;
}

export interface VerificationSandboxResult {
  result: ProcessResult;
  capability: VerificationCapability;
}

export interface VerificationCommandSandbox {
  run(command: VerificationCommand, worktreePath: string): Promise<VerificationSandboxResult>;
}

/** The only entry point for launching untrusted repository verification commands. */
export class VerificationSandbox implements VerificationCommandSandbox {
  constructor(private readonly supervisor: ProcessSupervisor) {}

  async run(command: VerificationCommand, worktreePath: string): Promise<VerificationSandboxResult> {
    let root: string | undefined;
    let result: VerificationSandboxResult | undefined;
    let failure: KerbsFlowError | undefined;
    const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
    try {
      if (!isAbsolute(worktreePath) || !existsSync(worktreePath)) throw unavailable("assigned worktree is missing");
      const worktree = realpathSync(worktreePath);
      const executable = resolveExecutable(command.executable, worktree);
      const backend = detectBackend();
      root = privateTemp("kerbsflow-verification-");
      const probeWorktree = join(root, "probe-worktree");
      const probeScratch = join(root, "probe-scratch");
      mkdirSync(probeWorktree, { mode: 0o700 });
      mkdirSync(probeScratch, { mode: 0o700 });
      writeFileSync(join(probeWorktree, "readable.txt"), "readable", { mode: 0o600 });
      writeFileSync(join(probeWorktree, ".env"), "synthetic-credential", { mode: 0o600 });
      writeFileSync(join(probeWorktree, ".env.local"), "synthetic-credential", { mode: 0o600 });
      mkdirSync(join(probeWorktree, "subdir"), { mode: 0o700 });
      writeFileSync(join(probeWorktree, "subdir", ".env.production"), "synthetic-credential", { mode: 0o600 });
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "outside", { mode: 0o600 });
      const outsideSnapshot = lstatSync(outside, { bigint: true });
      const hostTmpProbe = `/tmp/kerbsflow-sandbox-${randomUUID()}`;
      try { writeFileSync(hostTmpProbe, "preflight", { flag: "wx", mode: 0o600 }); unlinkSync(hostTmpProbe); }
      catch { throw unavailable("host /tmp denial probe cannot establish a writable control path"); }
      if (lstatIfPresent(hostTmpProbe) !== undefined) throw unavailable("host /tmp control path could not be cleared before the probe");
      const listener = createServer();
      await new Promise<void>((accept, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", accept);
      });
      try {
        const address = listener.address();
        if (address === null || typeof address === "string") throw unavailable("network probe listener has no port");
        const probeSpec = sandboxSpec(backend, process.execPath, ["-e", ADVERSARIAL_PROBE, probeWorktree, backend.kind === "bubblewrap" ? "/tmp" : probeScratch, outside, String(address.port), hostTmpProbe], probeWorktree, probeScratch, 5000);
        const probe = await this.supervisor.start(probeSpec).completion;
        let observed: Record<string, unknown>;
        try { observed = JSON.parse(probe.stdout) as Record<string, unknown>; } catch { throw unavailable("adversarial sandbox probe produced no valid evidence"); }
        const expected = ["worktreeRead", "scratchWrite", "worktreeWriteDenied", "outsideReadDenied", "credentialReadDenied", "envLocalReadDenied", "nestedEnvProductionReadDenied", "networkDenied", "outboundDenied", "childWorktreeWriteDenied"];
        if (probe.exitKind !== "normal" || probe.exitCode !== 0 || expected.some((key) => observed[key] !== true)) {
          throw unavailable(`adversarial sandbox probe failed: ${expected.filter((key) => observed[key] !== true).join(", ") || probe.exitKind}`);
        }
        const validWriteOutcome = (succeeded: unknown, errorCode: unknown): boolean =>
          (succeeded === true && errorCode === null)
          || (succeeded === false && typeof errorCode === "string" && SANDBOX_DENIAL_CODES.has(errorCode));
        if (!validWriteOutcome(observed.outsideWriteSucceeded, observed.outsideWriteError)
          || !validWriteOutcome(observed.hostTmpWriteSucceeded, observed.hostTmpWriteError)) {
          throw unavailable("adversarial sandbox write probe produced invalid evidence");
        }
        const outsideAfter = lstatSync(outside, { bigint: true });
        const outsideUnchanged = outsideAfter.isFile()
          && readFileSync(outside, "utf8") === "outside"
          && outsideAfter.dev === outsideSnapshot.dev
          && outsideAfter.ino === outsideSnapshot.ino
          && outsideAfter.mode === outsideSnapshot.mode
          && outsideAfter.uid === outsideSnapshot.uid
          && outsideAfter.gid === outsideSnapshot.gid
          && outsideAfter.nlink === outsideSnapshot.nlink
          && outsideAfter.size === outsideSnapshot.size
          && outsideAfter.mtimeNs === outsideSnapshot.mtimeNs
          && outsideAfter.ctimeNs === outsideSnapshot.ctimeNs;
        const privateScratchWritePreserved = readFileSync(join(probeScratch, "allowed"), "utf8") === "ok";
        const privateHostTmpProbe = join(probeScratch, basename(hostTmpProbe));
        const hostTmpWriteWasPrivate = observed.hostTmpWriteSucceeded !== true
          || backend.kind !== "bubblewrap"
          || (lstatIfPresent(privateHostTmpProbe) !== undefined && readFileSync(privateHostTmpProbe, "utf8") === "x");
        const protectedWorktreeTargetsAbsent = lstatIfPresent(join(probeWorktree, "blocked")) === undefined
          && lstatIfPresent(join(probeWorktree, "blocked-child")) === undefined;
        if (!outsideUnchanged || !privateScratchWritePreserved || !hostTmpWriteWasPrivate
          || !protectedWorktreeTargetsAbsent || lstatIfPresent(hostTmpProbe) !== undefined) {
          throw unavailable("adversarial sandbox host-effect probe failed");
        }
      } finally {
        listener.close();
        if (lstatIfPresent(hostTmpProbe) !== undefined) unlinkSync(hostTmpProbe);
      }
      const scratch = join(root, "scratch");
      mkdirSync(scratch, { mode: 0o700 });
      const spec = sandboxSpec(backend, executable, command.args, worktree, scratch, command.timeoutMs);
      const capability: VerificationCapability = {
        backend: backend.kind,
        backendVersion: backend.version,
        platform: process.platform,
        filesystemEnforcement: "enforced",
        workloadNetworkEnforcement: "enforced",
        probeAt: new Date().toISOString(),
        probeHash: createHash("sha256").update(JSON.stringify({ backend: backend.kind, version: backend.version, probe: ADVERSARIAL_PROBE, profile: spec.args.slice(0, -command.args.length - 1) })).digest("hex"),
      };
      const processResult = await this.supervisor.start(spec).completion;
      result = { result: processResult, capability };
    } catch (error) {
      failure = normalizeSandboxFailure(error);
    }
    try {
      if (root !== undefined) cleanupPrivateRoot(root, expectedUid);
    } catch (cleanupError) {
      throw combineCleanupFailure(failure, cleanupError);
    }
    if (failure !== undefined) throw failure;
    if (result === undefined) throw unavailable("verification sandbox produced no result");
    return result;
  }
}

type Backend = { kind: "seatbelt" | "bubblewrap"; path: string; version: string };

function detectBackend(): Backend {
  if (process.platform === "darwin") {
    const path = "/usr/bin/sandbox-exec";
    if (!existsSync(path)) throw unavailable("macOS Seatbelt sandbox-exec is unavailable");
    if (!trustedHostExecutable(path)) throw unavailable("macOS Seatbelt executable is not a trusted host installation");
    let version: string;
    try { version = `Darwin ${execFileSync("/usr/bin/uname", ["-r"], { encoding: "utf8", timeout: 2000 }).trim()} (sandbox-exec)`; }
    catch { throw unavailable("macOS sandbox backend version cannot be established"); }
    return { kind: "seatbelt", path, version };
  }
  if (process.platform === "linux") {
    const path = findTrustedBubblewrap();
    if (path === undefined) throw unavailable("trusted root-owned Bubblewrap installation is unavailable");
    let version: string;
    try { version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 2000 }).trim(); }
    catch { throw unavailable("Bubblewrap version cannot be established"); }
    const match = /\bbubblewrap\s+(\d+)\.(\d+)\.(\d+)\b/u.exec(version);
    if (match === null || Number(match[1]) < 0 || (Number(match[1]) === 0 && Number(match[2]) < 12)) {
      throw unavailable("Bubblewrap build is not proven fixed for CVE-2026-87766; require upstream 0.12.0 or trusted backport evidence");
    }
    return { kind: "bubblewrap", path, version };
  }
  throw unavailable(`verification sandbox is unsupported on ${process.platform}`);
}

function sandboxSpec(backend: Backend, executable: string, args: string[], worktree: string, scratch: string, timeoutMs: number): SupervisedProcessSpec {
  const nodeRuntimeRoot = dirname(dirname(process.execPath));
  const sandboxScratch = backend.kind === "bubblewrap" ? "/tmp" : scratch;
  const environment: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sandboxScratch, TMPDIR: sandboxScratch, TMP: sandboxScratch, TEMP: sandboxScratch, LANG: "C", LC_ALL: "C" };
  if (backend.kind === "seatbelt") {
    return {
      executable: backend.path,
      args: ["-p", seatbeltProfile(worktree, scratch, executable, nodeRuntimeRoot), executable, ...args],
      cwd: worktree, environment, timeoutMs, gracePeriodMs: 1000,
    };
  }
  const directories = new Set<string>();
  for (const path of [worktree, scratch, executable, nodeRuntimeRoot]) for (const ancestor of ancestors(path).slice(1, -1)) directories.add(ancestor);
  const system = ["/usr", "/bin", "/lib", "/lib64"].filter(existsSync);
  const mountArgs = [...directories].filter((path) => !system.some((base) => path === base || path.startsWith(`${base}/`))).sort((a, b) => a.length - b.length).flatMap((path) => ["--dir", path]);
  const masks = linuxCredentialMasks(worktree, dirname(scratch));
  return {
    executable: backend.path,
    args: ["--unshare-user", "--unshare-pid", "--unshare-net", "--new-session", "--die-with-parent", "--bind", scratch, "/tmp", ...mountArgs,
      ...system.flatMap((path) => ["--ro-bind", path, path]),
      "--ro-bind", nodeRuntimeRoot, nodeRuntimeRoot,
      "--ro-bind", worktree, worktree, "--ro-bind", executable, executable,
      ...masks,
      "--proc", "/proc", "--dev", "/dev",
      "--chdir", worktree, "--setenv", "HOME", sandboxScratch, "--setenv", "TMPDIR", sandboxScratch,
      "--", executable, ...args],
    cwd: worktree, environment, timeoutMs, gracePeriodMs: 1000,
  };
}

function linuxCredentialMasks(worktree: string, privateRoot: string): string[] {
  const deniedFile = join(privateRoot, "denied-file");
  const deniedDirectory = join(privateRoot, "denied-directory");
  if (!existsSync(deniedFile)) writeFileSync(deniedFile, "", { mode: 0o000 });
  if (!existsSync(deniedDirectory)) mkdirSync(deniedDirectory, { mode: 0o000 });
  const mounts: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 32) throw unavailable("worktree nesting exceeds credential-mask probe bound");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const deniedName = entry.name === ".env" || entry.name.startsWith(".env.")
        || [".aws", ".ssh", ".npmrc", ".netrc"].includes(entry.name)
        || entry.name === "gh" && directory.endsWith("/.config");
      if (deniedName) {
        if (entry.isSymbolicLink()) throw unavailable("credential path is a symlink and cannot be safely masked");
        mounts.push("--ro-bind", entry.isDirectory() ? deniedDirectory : deniedFile, path);
      } else if (entry.isDirectory()) {
        visit(path, depth + 1);
      }
    }
  };
  visit(worktree, 0);
  return mounts;
}

function seatbeltProfile(worktree: string, scratch: string, executable: string, nodeRuntimeRoot: string): string {
  const literalPaths = new Set(["/", ...ancestors(worktree).slice(1, -1), ...ancestors(scratch).slice(1, -1), ...ancestors(executable).slice(1, -1), ...ancestors(nodeRuntimeRoot).slice(1, -1)]);
  const readPaths = ["/usr", "/System", "/Library", "/dev", "/opt/homebrew", nodeRuntimeRoot, worktree, scratch];
  const exactFiles = [executable];
  const lines = [
    "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)",
    `(allow file-read* ${[...literalPaths].map((path) => `(literal ${schemeString(path)})`).join(" ")} ${readPaths.map((path) => `(subpath ${schemeString(path)})`).join(" ")} ${exactFiles.map((path) => `(literal ${schemeString(path)})`).join(" ")})`,
    `(allow file-write* (subpath ${schemeString(scratch)}))`,
    `(deny file-read* (regex #"(^|/)\\.env(\\.[^/]*)?($|/)") (regex #"(^|/)\\.aws($|/)") (regex #"(^|/)\\.ssh($|/)") (regex #"(^|/)\\.config/gh($|/)") (regex #"(^|/)\\.npmrc($|/)") (regex #"(^|/)\\.netrc($|/)"))`,
  ];
  return lines.join("\n");
}

function schemeString(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw unavailable("sandbox path contains unsupported characters");
  return JSON.stringify(value);
}

function ancestors(path: string): string[] {
  const result = [parse(path).root];
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    result.push(current);
  }
  return result;
}

function resolveExecutable(executable: string, worktree: string): string {
  const path = executable.includes(sep) ? executable : findOnPath(executable);
  if (path === undefined || !existsSync(path)) throw unavailable("verification executable is missing");
  const canonical = realpathSync(path);
  const nodeRuntime = realpathSync(dirname(dirname(process.execPath)));
  const systemRoots = process.platform === "darwin" ? ["/usr", "/bin", "/System", "/Library", "/opt/homebrew"] : ["/usr", "/bin", "/lib", "/lib64"];
  if (![worktree, nodeRuntime, ...systemRoots].some((root) => canonical === root || canonical.startsWith(`${root}${sep}`))) {
    throw unavailable("verification executable is outside the assigned worktree and approved runtime paths");
  }
  return canonical;
}

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

function findTrustedBubblewrap(): string | undefined {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, "bwrap");
    if (existsSync(candidate) && trustedHostExecutable(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

function trustedHostExecutable(path: string): boolean {
  try {
    let current = realpathSync(path);
    const file = statSync(current);
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o4022) !== 0 || (file.mode & 0o111) === 0) return false;
    current = dirname(current);
    while (true) {
      const directory = statSync(current);
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch { return false; }
}

function privateTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return realpathSync(root);
}

class ScratchCleanupError extends Error {
  constructor(readonly code: string) {
    super("verification scratch cleanup encountered an unsafe private-root entry");
    this.name = "ScratchCleanupError";
  }
}

function cleanupPrivateRoot(root: string, expectedUid: number | undefined): void {
  const initial = lstatIfPresent(root);
  if (initial === undefined) return;
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw new ScratchCleanupError("INVALID_ROOT");
  const ownerUid = expectedUid ?? initial.uid;
  const device = initial.dev;
  assertCleanupOwnership(initial, ownerUid, device);
  if (realpathSync(root) !== root) throw new ScratchCleanupError("ROOT_PATH_CHANGED");

  const pending: Array<{ path: string | Buffer; root: boolean; removeDirectory: boolean }> = [
    { path: root, root: true, removeDirectory: false },
  ];
  const separator = Buffer.from(sep);
  const dot = Buffer.from(".");
  const dotDot = Buffer.from("..");
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const metadata = lstatIfPresent(entry.path);
    if (metadata === undefined) continue;
    assertCleanupOwnership(metadata, ownerUid, device);

    if (entry.removeDirectory) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ScratchCleanupError("DIRECTORY_CHANGED");
      restoreOwnerDirectoryAccess(entry.path, metadata);
      rmdirSync(entry.path);
      continue;
    }

    if (entry.root && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
      throw new ScratchCleanupError("INVALID_ROOT");
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      unlinkSync(entry.path);
      continue;
    }

    restoreOwnerDirectoryAccess(entry.path, metadata);
    pending.push({ path: entry.path, root: entry.root, removeDirectory: true });
    for (const name of readdirSync(entry.path, { encoding: "buffer" })) {
      if (name.length === 0 || name.equals(dot) || name.equals(dotDot) || name.includes(separator) || name.includes(0)) {
        throw new ScratchCleanupError("INVALID_ENTRY_NAME");
      }
      const parent = Buffer.isBuffer(entry.path) ? entry.path : Buffer.from(entry.path);
      pending.push({ path: Buffer.concat([parent, separator, name]), root: false, removeDirectory: false });
    }
  }

  if (lstatIfPresent(root) !== undefined) throw new ScratchCleanupError("ROOT_REMAINS");
}

function lstatIfPresent(path: string | Buffer): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertCleanupOwnership(metadata: Stats, ownerUid: number, device: number): void {
  if (metadata.uid !== ownerUid) throw new ScratchCleanupError("UNEXPECTED_OWNER");
  if (metadata.dev !== device) throw new ScratchCleanupError("MOUNT_BOUNDARY");
}

function restoreOwnerDirectoryAccess(path: string | Buffer, metadata: Stats): void {
  const permissions = metadata.mode & 0o7777;
  const accessiblePermissions = permissions | 0o700;
  if (permissions !== accessiblePermissions) chmodSync(path, accessiblePermissions);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function normalizeSandboxFailure(error: unknown): KerbsFlowError {
  if (error instanceof KerbsFlowError && error.code === "VERIFICATION_SANDBOX_UNAVAILABLE") return error;
  return unavailable("verification sandbox preparation or launch failed");
}

export function combineCleanupFailure(primary: KerbsFlowError | undefined, cleanupError: unknown): KerbsFlowError {
  const errorCode = nodeErrorCode(cleanupError);
  const cleanupFailure = {
    code: errorCode !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode) ? errorCode : "UNKNOWN",
  };
  if (primary === undefined) {
    return new KerbsFlowError("VERIFICATION_SANDBOX_UNAVAILABLE", "verification scratch cleanup could not be proven", { cleanupFailure });
  }
  return new KerbsFlowError(primary.code, primary.message, {
    primaryFailure: { code: primary.code },
    cleanupFailure,
  });
}

function unavailable(summary: string): KerbsFlowError {
  return new KerbsFlowError("VERIFICATION_SANDBOX_UNAVAILABLE", summary);
}

const SANDBOX_DENIAL_CODES = new Set(["EPERM", "EACCES", "ENOENT", "EROFS"]);
const sandboxDenialCodesJson = JSON.stringify([...SANDBOX_DENIAL_CODES]);

const ADVERSARIAL_PROBE = String.raw`
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const [worktree,scratch,outside,port,hostTmpProbe]=process.argv.slice(1);
const DENIAL_CODES=new Set(${sandboxDenialCodesJson});
const errorCode=(fn)=>{try{fn();return null}catch(e){return typeof e?.code==='string'?e.code:'UNKNOWN'}};
const denied=(code)=>DENIAL_CODES.has(code);
const result={
 worktreeRead:fs.readFileSync(worktree+'/readable.txt','utf8')==='readable',
 scratchWrite:false,worktreeWriteDenied:false,worktreeWriteError:null,outsideReadDenied:false,
 outsideWriteSucceeded:false,outsideWriteError:null,
 credentialReadDenied:false,envLocalReadDenied:false,nestedEnvProductionReadDenied:false,
 hostTmpWriteSucceeded:false,hostTmpWriteError:null,networkDenied:false,outboundDenied:false,
 childWorktreeWriteDenied:false,childWorktreeWriteError:null
};
const scratchError=errorCode(()=>fs.writeFileSync(scratch+'/allowed','ok'));result.scratchWrite=scratchError===null;
result.worktreeWriteError=errorCode(()=>fs.writeFileSync(worktree+'/blocked','x'));result.worktreeWriteDenied=denied(result.worktreeWriteError);
result.outsideReadDenied=denied(errorCode(()=>fs.readFileSync(outside)));
result.outsideWriteError=errorCode(()=>fs.writeFileSync(outside,'x'));result.outsideWriteSucceeded=result.outsideWriteError===null;
result.credentialReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/.env')));
result.envLocalReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/.env.local')));
result.nestedEnvProductionReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/subdir/.env.production')));
result.hostTmpWriteError=errorCode(()=>fs.writeFileSync(hostTmpProbe,'x'));result.hostTmpWriteSucceeded=result.hostTmpWriteError===null;
const childScript='const fs=require("node:fs"),codes=new Set('+JSON.stringify([...DENIAL_CODES])+');try{fs.writeFileSync(process.argv[1],"x");process.exit(1)}catch(e){const code=typeof e?.code==="string"?e.code:"UNKNOWN";process.stdout.write(code);process.exit(codes.has(code)?0:2)}';
const child=cp.spawnSync(process.execPath,['-e',childScript,worktree+'/blocked-child'],{encoding:'utf8'});
result.childWorktreeWriteError=child.stdout.trim()||child.error?.code||'UNEXPECTED';
result.childWorktreeWriteDenied=child.status===0&&DENIAL_CODES.has(result.childWorktreeWriteError);
const attempt=(host,port,codes)=>new Promise((resolve)=>{
 const socket=net.connect(port,host);let settled=false;
 const done=(value)=>{if(settled)return;settled=true;socket.destroy();resolve(value)};
 socket.once('connect',()=>done(false));socket.once('error',(error)=>done(codes.includes(error.code)));
 setTimeout(()=>done(false),1000).unref();
});
Promise.all([
 attempt('127.0.0.1',Number(port),['EPERM','EACCES','ECONNREFUSED','ENETUNREACH']),
 attempt('1.1.1.1',53,['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'])
]).then(([local,outbound])=>{result.networkDenied=local;result.outboundDenied=outbound;console.log(JSON.stringify(result))});
`;
