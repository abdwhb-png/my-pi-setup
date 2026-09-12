import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import type { BashPreparationContext, PreparedBashSpawn } from "../_shared/command-execution/exec.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { createSandboxedBashOps } from "./index.ts";
import type { SandboxService } from "./runtime/service.ts";
import { createAdmittedSandboxExecutionContext, type SandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import { createPrivateTempLease } from "./runtime/private-temp.ts";

test("the shared shell route uses private Bash and delays permission observation until admission", async () => {
 let prepared: ((context:BashPreparationContext)=>PreparedBashSpawn|Promise<PreparedBashSpawn>)|undefined;
 const supervisor=createBashProcessSupervisor();
 const capture={...supervisor,createOperations:(options:Parameters<typeof supervisor.createOperations>[0])=>{prepared=options?.prepareSpawn;return supervisor.createOperations(options);}};
 let commandFile="";let observed:SandboxExecutionContext|undefined;
 const lease=await createPrivateTempLease();
 const context=createAdmittedSandboxExecutionContext({sha256:"a".repeat(64),report:{schema:1,runtime:{target:"x86_64-unknown-linux-gnu",version:"test",manifestSha256:"a".repeat(64),component:"shell"},helperSha256:"b".repeat(64),kernelMounts: [], mounts:[],filesystem:{allowRead:[],allowWrite:[],denyRead:[],denyReadGlobs:[],denyWrite:[],denyWriteGlobs:[]},network:{mode:"deny-all",allow:[],allowHost:[],deny:[]},resources:{unixSockets:[],tcpPublications:[]},path:["/__zerobox/runtime/bin"],environment:{inherit:[],set:["HOME","PATH"],deny:[]},home:{path:"/home/sandbox",namespace:"lease-private"},tmp:{path:"/tmp",namespace:"lease-private"},docker:{mode:"disabled"}}},"bash-general",lease,{homeDir:"/fixture/home"});
 let didAdmit=false;
 let release!:()=>void;const admitted=new Promise<void>(resolve=>{release=resolve;});
 const prepareBash: SandboxService["prepareBash"]=async(command)=>{commandFile=command.file;return{file:"/fixture/engine",args:[],cwd:process.cwd(),env:{},statusProtocol:{fd:3,version:2},extraStdio:[],getSandboxContext:()=>didAdmit?context:undefined,supervise:()=>({ready:admitted.then(()=>{didAdmit=true;}),settled:admitted})};};
 const service={prepareBash,prepareThinkBash:prepareBash};
 createSandboxedBashOps(service,capture,{onSandboxContext:(value)=>{observed=value;}});
 try {
 if(!prepared)throw new Error("Missing shared route preparation");
 const spawn=await prepared({command:"true",cwd:process.cwd(),env:{}});
 expect(commandFile).toBe("/__zerobox/runtime/bin/bash");
 expect(observed).toBeUndefined();
 const status=spawn.supervise(new ChildProcess());release();await status.ready;
 expect(observed).toBe(context);
 } finally {await lease.dispose();}
});
