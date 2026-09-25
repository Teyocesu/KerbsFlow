import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

import { ProcessSupervisor, type SupervisedProcess, type SupervisedProcessSpec } from "../src/process.js";
import { combineCleanupFailure, VerificationSandbox } from "../src/verification-sandbox.js";
import { KerbsFlowError } from "../src/errors.js";

async function withIsolatedVerificationTemp<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  const directory = mkdtempSync(join(tmpdir(), "kerbsflow-verification-test-"));
  process.env.TMPDIR = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
  }
}

function makeWorktree(): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-sandbox-cleanup-test-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  return { root, worktree };
}

function hostFileSnapshot(path: string) {
  const stats = lstatSync(path, { bigint: true });
  return {
    isFile: stats.isFile(), dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid, gid: stats.gid,
    nlink: stats.nlink, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs,
  };
}

function assertHostPathAbsent(path: string, message: string): void {
  assert.throws(() => lstatSync(path), { code: "ENOENT" }, message);
}

test("VerificationSandbox cleanup removes its mode-000 credential-mask sentinel", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const { root, worktree } = makeWorktree();
  try {
    await withIsolatedVerificationTemp(async (temporaryDirectory) => {
      const { result } = await new VerificationSandbox(new ProcessSupervisor()).run({ executable: "/usr/bin/true", args: [], timeoutMs: 5000 }, realpathSync(worktree));
      assert.equal(result.exitKind, "normal");
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(readdirSync(temporaryDirectory), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VerificationSandbox cleanup handles nested mode-000 scratch directories and unlinks symlinks without following them", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const { root, worktree } = makeWorktree();
  const outside = join(root, "outside");
  const outsideFile = join(outside, "preserved.txt");
  mkdirSync(outside);
  writeFileSync(outsideFile, "outside scratch target");
  const script = String.raw`
    const fs=require('node:fs');
    const [outsideFile,outsideDirectory]=process.argv.slice(1);
    const scratch=process.env.TMPDIR;
    const top=scratch+'/mode-zero-top';
    const nested=top+'/nested';
    const denied=nested+'/denied';
    fs.mkdirSync(denied,{recursive:true,mode:0o700});
    fs.writeFileSync(denied+'/payload','synthetic');
    fs.chmodSync(denied,0);
    fs.chmodSync(top,0);
    fs.writeFileSync(scratch+'/mode-zero-file','synthetic');
    fs.chmodSync(scratch+'/mode-zero-file',0);
    fs.symlinkSync(outsideFile,scratch+'/outside-file-link');
    fs.symlinkSync(outsideDirectory,scratch+'/outside-directory-link');
    console.log('hostile scratch created');
  `;
  try {
    await withIsolatedVerificationTemp(async (temporaryDirectory) => {
      const { result } = await new VerificationSandbox(new ProcessSupervisor()).run({
        executable: process.execPath,
        args: ["-e", script, outsideFile, outside],
        timeoutMs: 5000,
      }, realpathSync(worktree));
      assert.equal(result.exitKind, "normal");
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /hostile scratch created/u);
      assert.deepEqual(readdirSync(temporaryDirectory), []);
      assert.equal(readFileSync(outsideFile, "utf8"), "outside scratch target");
      assert.deepEqual(readdirSync(outside), ["preserved.txt"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VerificationSandbox preserves the normalized primary failure after successful cleanup", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  class FailedSupervisor extends ProcessSupervisor {
    override start(_spec: SupervisedProcessSpec): SupervisedProcess {
      throw new Error("sensitive child diagnostic must not escape");
    }
  }
  const { root, worktree } = makeWorktree();
  try {
    await withIsolatedVerificationTemp(async (temporaryDirectory) => {
      await assert.rejects(
        new VerificationSandbox(new FailedSupervisor()).run({ executable: "/usr/bin/true", args: [], timeoutMs: 1000 }, realpathSync(worktree)),
        (error: unknown) => error instanceof KerbsFlowError
          && error.code === "VERIFICATION_SANDBOX_UNAVAILABLE"
          && error.message === "verification sandbox preparation or launch failed"
          && !error.message.includes("sensitive child diagnostic"),
      );
      assert.deepEqual(readdirSync(temporaryDirectory), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure retains the primary code/message and only sanitized cleanup evidence", () => {
  const primary = new KerbsFlowError("VERIFICATION_SANDBOX_UNAVAILABLE", "adversarial probe failed");
  const cleanup = Object.assign(new Error("secret and path must not be disclosed"), { code: "EACCES" });
  const combined = combineCleanupFailure(primary, cleanup);
  assert.equal(combined.code, primary.code);
  assert.equal(combined.message, primary.message);
  assert.deepEqual(combined.details, {
    primaryFailure: { code: "VERIFICATION_SANDBOX_UNAVAILABLE" },
    cleanupFailure: { code: "EACCES" },
  });
  assert.equal(JSON.stringify(combined.details).includes("secret"), false);

  const cleanupOnly = combineCleanupFailure(undefined, cleanup);
  assert.equal(cleanupOnly.code, "VERIFICATION_SANDBOX_UNAVAILABLE");
  assert.equal(cleanupOnly.message, "verification scratch cleanup could not be proven");
  assert.deepEqual(cleanupOnly.details, { cleanupFailure: { code: "EACCES" } });
});

test("verification command and descendant cannot escape read-only worktree, scratch, home, tmp, or network policy", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-sandbox-test-"));
  const worktree = join(root, "worktree");
  const home = join(root, "home");
  mkdirSync(worktree);
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(worktree, "source.txt"), "source");
  writeFileSync(join(worktree, ".env"), "synthetic-secret");
  writeFileSync(join(worktree, ".env.local"), "synthetic-secret");
  mkdirSync(join(worktree, "subdir"));
  writeFileSync(join(worktree, "subdir", ".env.production"), "synthetic-secret");
  const outside = join(root, "outside.txt");
  const credential = join(home, ".aws", "credentials");
  writeFileSync(outside, "outside");
  const outsideSnapshot = hostFileSnapshot(outside);
  symlinkSync(outside, join(worktree, "outside-link"));
  writeFileSync(credential, "synthetic-secret");
  const hostTmpProbe = `/tmp/kerbsflow-verification-escape-${randomUUID()}`;
  writeFileSync(hostTmpProbe, "host-control", { flag: "wx", mode: 0o600 });
  unlinkSync(hostTmpProbe);
  assertHostPathAbsent(hostTmpProbe, "host /tmp control starts absent");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const script = String.raw`
      const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const [worktree,outside,credential,port,hostTmpProbe]=process.argv.slice(1);
      const deniedCodes=['EPERM','EACCES','ENOENT','EROFS'];
      const errorCode=(fn)=>{try{fn();return null}catch(error){return typeof error?.code==='string'?error.code:'UNKNOWN'}};
      const denied=(code)=>deniedCodes.includes(code);
      const result={ read:fs.readFileSync(worktree+'/source.txt','utf8')==='source' };
      result.worktreeWriteError=errorCode(()=>fs.writeFileSync(worktree+'/new.txt','x'));
      result.worktreeWriteDenied=denied(result.worktreeWriteError);
      const scratchError=errorCode(()=>fs.writeFileSync(process.env.TMPDIR+'/scratch.txt','ok'));
      result.scratchWrite=scratchError===null;
      result.outsideReadDenied=denied(errorCode(()=>fs.readFileSync(outside)));
      result.symlinkEscapeReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/outside-link')));
      result.outsideWriteError=errorCode(()=>fs.writeFileSync(outside,'x'));
      result.outsideWriteSucceeded=result.outsideWriteError===null;
      result.envReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/.env')));
      result.envLocalReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/.env.local')));
      result.nestedEnvProductionReadDenied=denied(errorCode(()=>fs.readFileSync(worktree+'/subdir/.env.production')));
      result.credentialReadDenied=denied(errorCode(()=>fs.readFileSync(credential)));
      result.hostTmpWriteError=errorCode(()=>fs.writeFileSync(hostTmpProbe,'x'));
      result.hostTmpWriteSucceeded=result.hostTmpWriteError===null;
      const child=cp.spawnSync(process.execPath,['-e','const fs=require("node:fs"),codes=new Set(["EPERM","EACCES","ENOENT","EROFS"]);try{fs.writeFileSync(process.argv[1],"x");process.exit(1)}catch(error){const code=typeof error?.code==="string"?error.code:"UNKNOWN";process.stdout.write(code);process.exit(codes.has(code)?0:2)}',worktree+'/child-new.txt'],{encoding:'utf8'});
      result.childWorktreeWriteError=child.stdout.trim()||child.error?.code||'UNEXPECTED';
      result.childWorktreeWriteDenied=child.status===0&&deniedCodes.includes(result.childWorktreeWriteError);
      const attempt=(host,port,codes)=>new Promise((resolve)=>{const socket=net.connect(port,host);let settled=false;const done=(value)=>{if(settled)return;settled=true;socket.destroy();resolve(value)};socket.once('connect',()=>done(false));socket.once('error',(error)=>done(codes.includes(error.code)));setTimeout(()=>done(false),1000).unref()});
      Promise.all([attempt('127.0.0.1',Number(port),['EPERM','EACCES','ECONNREFUSED','ENETUNREACH']),attempt('1.1.1.1',53,['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'])]).then(([local,outbound])=>{result.networkDenied=local;result.outboundDenied=outbound;console.log(JSON.stringify(result))});
    `;
    const { result, capability } = await new VerificationSandbox(new ProcessSupervisor()).run({
      executable: process.execPath, args: ["-e", script, realpathSync(worktree), outside, credential, String(address.port), hostTmpProbe], timeoutMs: 5000,
    }, worktree);
    assert.equal(result.exitKind, "normal");
    assert.equal(result.exitCode, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ["read", "worktreeWriteDenied", "scratchWrite", "outsideReadDenied", "symlinkEscapeReadDenied", "envReadDenied", "envLocalReadDenied", "nestedEnvProductionReadDenied", "credentialReadDenied", "childWorktreeWriteDenied", "networkDenied", "outboundDenied"]) {
      assert.equal(observed[key], true, key);
    }
    const denialCodes = ["EPERM", "EACCES", "ENOENT", "EROFS"];
    assert.ok(denialCodes.includes(observed.worktreeWriteError as string), "main worktree write uses an accepted denial errno");
    assert.ok(denialCodes.includes(observed.childWorktreeWriteError as string), "child worktree write uses an accepted denial errno");
    for (const prefix of ["outsideWrite", "hostTmpWrite"]) {
      assert.equal(typeof observed[`${prefix}Succeeded`], "boolean", `${prefix} outcome is recorded`);
      if (observed[`${prefix}Succeeded`] === true) assert.equal(observed[`${prefix}Error`], null, `${prefix} success has no error`);
      else assert.ok(denialCodes.includes(observed[`${prefix}Error`] as string), `${prefix} failure has an explicit denial errno`);
    }
    if (process.platform === "linux") {
      assert.equal(observed.worktreeWriteError, "EROFS");
      assert.equal(observed.childWorktreeWriteError, "EROFS");
      assert.equal(observed.hostTmpWriteSucceeded, true, "private sandbox /tmp is writable");
    }
    assert.equal(capability.filesystemEnforcement, "enforced");
    assert.equal(capability.workloadNetworkEnforcement, "enforced");
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.deepEqual(hostFileSnapshot(outside), outsideSnapshot, "host outside file identity and metadata remain unchanged");
    assertHostPathAbsent(join(worktree, "new.txt"), "parent blocked-write target remains absent on host");
    assertHostPathAbsent(join(worktree, "child-new.txt"), "child blocked-write target remains absent on host");
    assertHostPathAbsent(hostTmpProbe, "host /tmp control remains absent after sandbox exit");
    await assert.rejects(
      new VerificationSandbox(new ProcessSupervisor()).run({ executable: outside, args: [], timeoutMs: 1000 }, worktree),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "VERIFICATION_SANDBOX_UNAVAILABLE",
    );
  } finally {
    listener.close();
    rmSync(hostTmpProbe, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
