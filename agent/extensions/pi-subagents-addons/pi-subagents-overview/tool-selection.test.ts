import { expect, mock, spyOn, test } from "bun:test";
import * as os from "node:os";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestSession, when, type TestSession } from "@abdwhb-png/pi-test-harness";

test("print overview displays native resolved tools and qualified agent identities", async () => {
    const originalOs = {...os};
    const previous = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(os.tmpdir(),"overview-selections-"));
    let session: TestSession | undefined;
    const output: string[] = [];
    const consoleSpy = spyOn(console,"log").mockImplementation(value => output.push(String(value)));
    try {
        const agentDir = join(root,".pi/agent"), cwd = join(root,"project");
        mkdirSync(join(agentDir,"agents"),{recursive:true}); mkdirSync(join(agentDir,"config")); mkdirSync(cwd);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mock.module("node:os", () => ({...originalOs,homedir:()=>root}));
        writeFileSync(join(agentDir,"settings.json"),JSON.stringify({packages:[dirname(realpathSync(fileURLToPath(import.meta.resolve("pi-subagents"))))],subagents:{toolSelectionResolver:join(import.meta.dir,"../tool-selection.ts"),agentOverrides:{worker:{tools:["@inspect"]}}}}));
        writeFileSync(join(agentDir,"config/tool-groups.json"),JSON.stringify({groups:{inspect:["read","grep"]}}));
        writeFileSync(join(agentDir,"agents/qualified.md"),"---\nname: qualified\npackage: alpha\ndescription: Qualified fixture\ntools: '@inspect'\n---\nInspect.\n");
        const {default:overview} = await import("./index.ts");
        session = await createTestSession({cwd, extensionFactories:[overview]});
        await session.session.bindExtensions({mode:"print"});
        await session.run(when("/subagents-overview", []));
        const text = output.join("\n").replace(/\x1b\[[0-9;]*m/g,"");
        expect(text).toMatch(/Tools\*: read, grep  ← OVERRIDDEN\n/);
        expect(text).toContain("alpha.qualified");
        expect(text).not.toMatch(/Tools\*?:[^\n]*@inspect/);
    } finally {
        session?.dispose(); consoleSpy.mockRestore();
        mock.module("node:os",()=>originalOs);
        if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;
        rmSync(root,{recursive:true,force:true});
    }
}, 30_000);
