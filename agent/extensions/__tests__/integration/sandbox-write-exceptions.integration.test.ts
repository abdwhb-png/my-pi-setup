import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { calls, createTestSession, says, when, type TestSession } from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFixtureFileAsync as writeFile } from "../../_shared/testing/config-fixture.ts";
import { localMachineId } from "../../_shared/sandbox-runtime/machine-identity.ts";
import { resolveSandboxExecutionContext } from "../../_shared/sandbox-runtime/execution-context.ts";

test.skipIf(process.env.PI_SANDBOX_CACHE_EXCEPTIONS_CONTRACT !== "1")(
    "both shell tools enforce admitted cache exceptions and report native write denials",
    async () => {
        if (!process.env.PI_SANDBOX_CACHE_FIXTURE_HOME) {
            const home = await mkdtemp("/tmp/");
            try {
                const child = Bun.spawn([process.execPath,"test","--isolate",import.meta.path],{env:{...process.env,HOME:home,PI_SANDBOX_CACHE_FIXTURE_HOME:home},stdout:"pipe",stderr:"pipe"});
                try {
                    const [exit,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
                    if(exit!==0)throw new Error(`Cold runtime contract failed: ${stdout}${stderr}`);
                    expect(exit).toBe(0);
                } finally {
                    if(child.exitCode===null) {child.kill("SIGTERM");await child.exited;}
                }
            } finally {
                await rm(home,{recursive:true,force:true});
            }
            return;
        }
        expect(homedir()).toBe(process.env.PI_SANDBOX_CACHE_FIXTURE_HOME);
        const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
        const priorStatus = process.env.PI_SANDBOX_SESSION_STATUS;
        const fixtureHome = homedir();
        const root = await mkdtemp("/var/tmp/pi-cache-contract-");
        let session: TestSession | undefined;
        try {
            const project = join(root, "project");
            const agentDir = join(root, "agent");
            const bundle = process.env.PI_SANDBOX_RUNTIME_BUNDLE;
            const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
            const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
            if (!bundle || !binaryPath || !binarySha256) throw new Error("An explicit Zerobox candidate is required");
            expect(await realpath(binaryPath)).toBe(await realpath(join(bundle,"bin/zerobox")));
            const staged = Bun.spawn([process.execPath,resolve(import.meta.dir,"../../sandbox/runtime/distribution/stage-release.ts"),
                "--candidate-root",bundle,"--runtime-base",join(fixtureHome,".pi/runtimes"),"--managed-binary",join(fixtureHome,".pi/bin/zerobox"),
                "--provenance-source",join(bundle,"provenance.json"),"--expected-binary-sha256",binarySha256],{stdout:"pipe",stderr:"pipe"});
            const [stageExit,stageOutput,stageError] = await Promise.all([staged.exited,new Response(staged.stdout).text(),new Response(staged.stderr).text()]);
            if(stageExit!==0)throw new Error(`Candidate fixture installation failed: ${stageOutput}${stageError}`);
            await mkdir(join(project,"node_modules/pkg"),{recursive:true});
            await writeFile(join(project,"node_modules/pkg/index.js"),"original");
            await writeFile(join(agentDir,"config/sandbox.json"),JSON.stringify({
                version:2,machineId:localMachineId(),
                filesystem:{allowRead:["."],allowWrite:["."],denyWrite:["node_modules/*","*.key"],
                    denyWriteExceptions:[{pattern:"node_modules/*",paths:["node_modules/.vite-temp","node_modules/.vite","node_modules/.cache","node_modules/.vue-global-types","node_modules/.tmp"]}]},
            }));
            await writeFile(join(agentDir,"extensions/pi-permission-system/config.json"),JSON.stringify({authorizerChain:[],shellTools:{safe_bash:{commandArgument:"command"}},permission:{"*":"allow",bash:{"*":"allow"}}}));
            process.env.PI_CODING_AGENT_DIR=agentDir;
            delete process.env.PI_SANDBOX_SESSION_STATUS;
            const permission = await realpath(resolve(import.meta.dir,"../../../node_modules/@gotgenes/pi-permission-system/src/index.ts"));
            const contexts = new Map<string,ReturnType<typeof resolveSandboxExecutionContext>>();
            session = await createTestSession({cwd:project,extensions:[permission,resolve(import.meta.dir,"../../sandbox/index.ts"),resolve(import.meta.dir,"../../bash-execution/index.ts")],extensionFactories:[
                (pi:ExtensionAPI)=>{pi.on("tool_result",event=>{contexts.set(event.toolCallId,resolveSandboxExecutionContext(event.toolCallId,event.details));});},
            ]});
            await session.run(when("Probe",[
                calls("bash",{command:"for cache_name in .vite-temp .vite .cache .vue-global-types .tmp; do mkdir -p node_modules/$cache_name; printf cache >node_modules/$cache_name/generated; done"}),
                calls("bash",{command:"printf changed >node_modules/pkg/index.js"}),
                calls("safe_bash",{command:"printf changed >node_modules/pkg/index.js"}),
                calls("bash",{command:"printf EACCES; exit 7"}),says("done"),
            ]));
            const bash=session.events.toolResultsFor("bash");
            if (bash[0]?.isError) throw new Error(`Cache command failed: ${bash[0].text}`);
            expect(bash[0]?.isError).toBe(false);
            for (const result of [bash[1],session.events.toolResultsFor("safe_bash")[0]]) {
                expect(result?.isError).toBe(true);
                expect(result?.text).toContain("Sandbox (mode=sandbox): write denied");
                expect(result?.text).toContain("node_modules/*");
                expect(result?.details).toMatchObject({execution:{mode:"sandbox",status:"sandboxed",backend:"zerobox"}});
                expect(contexts.get(result!.toolCallId)?.filesystem.denyWriteExceptions?.[0]?.paths).toHaveLength(5);
            }
            expect(bash[2]?.text).not.toContain("write denied for");
            expect(await readFile(join(project,"node_modules/pkg/index.js"),"utf8")).toBe("original");
            let commandError: unknown;
            let completed = false;
            const running = session.run(when("Revoke",[calls("bash",{command:"printf ready >node_modules/.vite/revoke-ready; sleep 20; printf late >node_modules/.vite/revoke-late",timeout:40}),says("stopped")]));
            const finished = running.then(()=>{completed=true;},error=>{commandError=error;completed=true;});
            const readyPath=join(project,"node_modules/.vite/revoke-ready");
            let ready=false;
            const deadline=performance.now()+15_000;
            while(!ready && !completed && performance.now()<deadline) {
                try { ready=(await readFile(readyPath,"utf8"))==="ready"; }
                catch(error) { if(!(error instanceof Error) || !("code" in error) || error.code!=="ENOENT")throw error; }
                if(!ready)await Bun.sleep(25);
            }
            if(!ready)throw new Error(`Revocation command did not start: ${String(commandError)}`);
            const global=JSON.parse(await readFile(join(agentDir,"config/sandbox.json"),"utf8"));
            global.filesystem.denyWriteExceptions=[];
            await writeFile(join(agentDir,"config/sandbox.json"),JSON.stringify(global));
            await finished;
            expect(await readFile(join(project,"node_modules/.vite/revoke-late"),"utf8").then(()=>true,error=>{
                if(error.code!=="ENOENT")throw error;return false;
            })).toBe(false);
            const revoked=session.events.toolResultsFor("bash").at(-1);
            expect(`${revoked?.text ?? ""} ${String(commandError ?? "")}`).toMatch(/abort|revok/i);

        } finally {
            try { await session?.session.extensionRunner.emit({type:"session_shutdown",reason:"quit"}); }
            finally {
                session?.dispose();
                if(priorAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=priorAgentDir;
                if(priorStatus===undefined)delete process.env.PI_SANDBOX_SESSION_STATUS;else process.env.PI_SANDBOX_SESSION_STATUS=priorStatus;
                await rm(root,{recursive:true,force:true});
            }
        }
    },180_000,
);
