import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import type { SandboxPolicy } from "./contracts.ts";

test("backend requires the pinned bundle and publishes context only after matching engine admission",async()=>{
 const parent=await mkdtemp(join(tmpdir(),"z-"));const root=join(parent,"bundle");
 const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
 const lease=await createPrivateTempLease({rootDir:join(parent,"r")});
 for(const path of ["bin","helper","components/shell/bin","components/analysis"])await mkdir(join(root,path),{recursive:true});
 for(const [path,value] of Object.entries({"bin/zerobox":"engine","helper/zerobox-linux-sandbox":"helper","components/shell/bin/bash":"bash","components/shell/bin/env":"env"}))await writeFile(join(root,path),value,{mode:0o700});
 const manifest=JSON.stringify({schema:1,target:"x86_64-unknown-linux-gnu",version:"test",helper:{path:"helper/zerobox-linux-sandbox",sha256:sha("helper")},components:{shell:{root:"components/shell",files:[{path:"bin/bash",sha256:sha("bash")},{path:"bin/env",sha256:sha("env")}]},analysis:{root:"components/analysis",files:[]}}});
 await writeFile(join(root,"manifest.json"),manifest);
 const cwd=join(parent,"project");await mkdir(cwd);
 const policy:SandboxPolicy={name:"bash-general",strict:true,tmpNamespace:"lease-private",filesystem:{allowRead:[cwd],allowWrite:[cwd],denyRead:[],denyWrite:[],denyReadGlobs:[],denyWriteGlobs:[]},network:{mode:"deny-all",allow:[],allowHost:[],deny:[]},resources:{unixSockets:[],tcpPublications:[]},docker:{mode:"disabled"},environment:{inherit:[],set:{HOME:"/home/sandbox",PATH:"/__zerobox/runtime/bin"},deny:[]}};
 const report={schema:1 as const,runtime:{target:"x86_64-unknown-linux-gnu" as const,version:"test",manifestSha256:sha(manifest),component:"shell" as const},helperSha256:sha("helper"),kernelMounts: [{ destination: "/__zerobox/runtime", root: "/bundle/shell", source: "/dev/test", filesystem: "ext4", access: "ro" as const }], mounts:[{source:join(root,"components/shell"),destination:"/__zerobox/runtime",access:"ro" as const,origin:"runtime" as const}],filesystem:policy.filesystem,network:{...policy.network,allowLocalBinding:false},resources:policy.resources!,path:["/__zerobox/runtime/bin"],environment:{inherit:[],set:["HOME","PATH"],deny:[]},home:{path:"/home/sandbox",namespace:"lease-private" as const},tmp:{path:"/tmp" as const,namespace:"lease-private" as const},docker:policy.docker};
 const proof={report,sha256:sha(JSON.stringify(report))};
 let acknowledgements=0;
 try{
  const backend=createZeroboxBackend({binaryPath:join(root,"bin/zerobox"),expectedProvenance:{version:"test",binarySha256:sha("engine")},runCommand:(_file,args)=>({exitCode:0,stdout:args.includes("--version")?"zerobox test":"--allow-unix-socket --publish-tcp",stderr:""}),createStatusChannel:async()=>({childStdio:20,supervise:options=>{const ready=Promise.resolve().then(()=>options?.onAdmitted?.(proof.sha256));return{ready,settled:ready};},dispose:async()=>{}}),createAdmissionChannel:async()=>({childStdio:21,childAckStdio:22,read:async()=>proof,acknowledge:async(digest:string)=>{expect(digest).toBe(proof.sha256);acknowledgements++;},dispose:async()=>{}})});
  const spawn=await backend.prepare({file:"/__zerobox/runtime/bin/bash",args:["-c","true"],cwd},policy,lease);
  expect(spawn.args).toContain(`--runtime-bundle=${root}`);
  expect(spawn.statusProtocol).toEqual({fd:3,version:2});
  expect(spawn.extraStdio).toEqual([20,21,22]);
  expect(spawn.getSandboxContext?.()).toBeUndefined();
  await spawn.supervise(new ChildProcess()).ready;
  expect(spawn.getSandboxContext?.()).toMatchObject({version:3,admission:"admitted",admissionSha256:proof.sha256});
  expect(acknowledgements).toBe(1);
  await spawn.cleanup?.();
  report.helperSha256="c".repeat(64);
  const rejected=await backend.prepare({file:"/__zerobox/runtime/bin/bash",args:["-c","true"],cwd},policy,lease);
  const rejectedStatus=rejected.supervise(new ChildProcess());
  void rejectedStatus.settled.catch(()=>undefined);
  await expect(rejectedStatus.ready).rejects.toMatchObject({code:"protocol-error"});
  expect(acknowledgements).toBe(1);
  await rejected.cleanup?.();
 }finally{await lease.dispose();await rm(parent,{recursive:true,force:true});}
});
