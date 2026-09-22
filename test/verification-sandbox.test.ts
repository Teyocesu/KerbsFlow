import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

import { ProcessSupervisor } from "../src/process.js";
import { VerificationSandbox } from "../src/verification-sandbox.js";
import { KerbsFlowError } from "../src/errors.js";

test("verification command and descendant cannot escape read-only worktree, scratch, home, tmp, or network policy", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-sandbox-test-"));
  const worktree = join(root, "worktree");
  const home = join(root, "home");
  mkdirSync(worktree);
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(worktree, "source.txt"), "source");
  writeFileSync(join(worktree, ".env"), "synthetic-secret");
  const outside = join(root, "outside.txt");
  const credential = join(home, ".aws", "credentials");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(worktree, "outside-link"));
  writeFileSync(credential, "synthetic-secret");
  const hostTmpProbe = `/tmp/kerbsflow-verification-escape-${randomUUID()}`;
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const script = String.raw`
      const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const [worktree,outside,credential,port,hostTmpProbe]=process.argv.slice(1);
      const denied=(fn)=>{try{fn();return false}catch{return true}};
      const result={ read:fs.readFileSync(worktree+'/source.txt','utf8')==='source' };
      result.worktreeWriteDenied=denied(()=>fs.writeFileSync(worktree+'/new.txt','x'));
      result.scratchWrite=false;
      try{fs.writeFileSync(process.env.TMPDIR+'/scratch.txt','ok');result.scratchWrite=true}catch{}
      result.outsideReadDenied=denied(()=>fs.readFileSync(outside));
      result.symlinkEscapeReadDenied=denied(()=>fs.readFileSync(worktree+'/outside-link'));
      result.outsideWriteDenied=denied(()=>fs.writeFileSync(outside,'x'));
      result.envReadDenied=denied(()=>fs.readFileSync(worktree+'/.env'));
      result.credentialReadDenied=denied(()=>fs.readFileSync(credential));
      result.hostTmpWriteDenied=denied(()=>fs.writeFileSync(hostTmpProbe,'x'));
      const child=cp.spawnSync(process.execPath,['-e','const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"x");process.exit(1)}catch{process.exit(0)}',outside]);
      result.childRestricted=child.status===0;
      const socket=net.connect(Number(port),'127.0.0.1');
      socket.once('connect',()=>{result.networkDenied=false;socket.destroy();console.log(JSON.stringify(result))});
      socket.once('error',(error)=>{result.networkDenied=error.code==='EPERM'||error.code==='EACCES';console.log(JSON.stringify(result))});
      setTimeout(()=>{socket.destroy();console.log(JSON.stringify(result))},1000).unref();
    `;
    const { result, capability } = await new VerificationSandbox(new ProcessSupervisor()).run({
      executable: process.execPath, args: ["-e", script, realpathSync(worktree), outside, credential, String(address.port), hostTmpProbe], timeoutMs: 5000,
    }, worktree);
    assert.equal(result.exitKind, "normal");
    assert.equal(result.exitCode, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const [key, value] of Object.entries(observed)) assert.equal(value, true, key);
    assert.equal(capability.filesystemEnforcement, "enforced");
    assert.equal(capability.workloadNetworkEnforcement, "enforced");
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.equal(existsSync(join(worktree, "new.txt")), false);
    await assert.rejects(
      new VerificationSandbox(new ProcessSupervisor()).run({ executable: outside, args: [], timeoutMs: 1000 }, worktree),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "VERIFICATION_SANDBOX_UNAVAILABLE",
    );
  } finally {
    listener.close();
    if (existsSync(hostTmpProbe)) rmSync(hostTmpProbe);
    rmSync(root, { recursive: true, force: true });
  }
});
