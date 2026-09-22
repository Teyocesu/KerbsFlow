import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
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
      const hostTmpProbe = `/tmp/kerbsflow-sandbox-${randomUUID()}`;
      try { writeFileSync(hostTmpProbe, "preflight", { flag: "wx", mode: 0o600 }); unlinkSync(hostTmpProbe); }
      catch { throw unavailable("host /tmp denial probe cannot establish a writable control path"); }
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
        const expected = ["worktreeRead", "scratchWrite", "worktreeWriteDenied", "outsideReadDenied", "outsideWriteDenied", "credentialReadDenied", "envLocalReadDenied", "nestedEnvProductionReadDenied", "hostTmpWriteDenied", "networkDenied", "outboundDenied", "childRestricted"];
        if (probe.exitKind !== "normal" || probe.exitCode !== 0 || expected.some((key) => observed[key] !== true)) {
          throw unavailable(`adversarial sandbox probe failed: ${expected.filter((key) => observed[key] !== true).join(", ") || probe.exitKind}`);
        }
      } finally {
        listener.close();
        if (existsSync(hostTmpProbe)) unlinkSync(hostTmpProbe);
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
      const result = await this.supervisor.start(spec).completion;
      return { result, capability };
    } catch (error) {
      if (error instanceof KerbsFlowError && error.code === "VERIFICATION_SANDBOX_UNAVAILABLE") throw error;
      throw unavailable("verification sandbox preparation or launch failed");
    } finally {
      if (root !== undefined) {
        try { rmSync(root, { recursive: true, force: true }); }
        catch { throw unavailable("verification scratch cleanup could not be proven"); }
      }
    }
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

function unavailable(summary: string): KerbsFlowError {
  return new KerbsFlowError("VERIFICATION_SANDBOX_UNAVAILABLE", summary);
}

const ADVERSARIAL_PROBE = String.raw`
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const [worktree,scratch,outside,port,hostTmpProbe]=process.argv.slice(1);
const denied=(fn)=>{try{fn();return false}catch(e){return e&&(['EPERM','EACCES','ENOENT'].includes(e.code))}};
const result={
 worktreeRead:fs.readFileSync(worktree+'/readable.txt','utf8')==='readable',
 scratchWrite:false,worktreeWriteDenied:false,outsideReadDenied:false,outsideWriteDenied:false,
 credentialReadDenied:false,envLocalReadDenied:false,nestedEnvProductionReadDenied:false,
 hostTmpWriteDenied:false,networkDenied:false,outboundDenied:false,childRestricted:false
};
try{fs.writeFileSync(scratch+'/allowed','ok');result.scratchWrite=true}catch{}
result.worktreeWriteDenied=denied(()=>fs.writeFileSync(worktree+'/blocked','x'));
result.outsideReadDenied=denied(()=>fs.readFileSync(outside));
result.outsideWriteDenied=denied(()=>fs.writeFileSync(outside,'x'));
result.credentialReadDenied=denied(()=>fs.readFileSync(worktree+'/.env'));
result.envLocalReadDenied=denied(()=>fs.readFileSync(worktree+'/.env.local'));
result.nestedEnvProductionReadDenied=denied(()=>fs.readFileSync(worktree+'/subdir/.env.production'));
result.hostTmpWriteDenied=denied(()=>fs.writeFileSync(hostTmpProbe,'x'));
try{const child=cp.spawnSync(process.execPath,['-e','const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"x");process.exit(1)}catch{process.exit(0)}',outside]);result.childRestricted=child.status===0}catch{}
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
