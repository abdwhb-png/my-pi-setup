import { afterEach, expect, test } from "bun:test";
import { chmodSync, statSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import sandboxExtension, { loadSandboxConfig, persistProjectDockerPreference } from "./index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sandbox-config-boundary-"));
    roots.push(root);
    const agentDir = join(root, "agent"), cwd = join(root, "project");
    mkdirSync(join(agentDir, "config"), { recursive: true });
    mkdirSync(join(cwd, ".pi/config"), { recursive: true });
    return { agentDir, cwd, projectPath: join(cwd, ".pi/config/sandbox.json") };
}

test.each([null, false])("sandbox does not read or write project config without saved trust (%s)", async (decision) => {
    const { agentDir, cwd, projectPath } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, decision);
    writeFileSync(projectPath, "malformed and untrusted");
    expect(loadSandboxConfig(cwd, { agentDir, projectTrusted: true }).source).toBe("default");
    await expect(persistProjectDockerPreference(cwd, "off", agentDir)).rejects.toThrow("saved project trust");
    expect(readFileSync(projectPath, "utf8")).toBe("malformed and untrusted");
    new ProjectTrustStore(agentDir).set(cwd, true);
    expect(() => loadSandboxConfig(cwd, { agentDir, projectTrusted: true })).toThrow();
    expect(loadSandboxConfig(cwd, { agentDir, projectTrusted: false }).source).toBe("default");
});

test.each(["global-legacy", "project-legacy", "global-marker", "canonical-marker"])("Docker preference refuses %s before creating canonical state", async (kind) => {
    const { agentDir, cwd, projectPath } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, true);
    const path = kind === "project-legacy" ? join(cwd, ".pi/sandbox.json") : kind === "canonical-marker" ? join(agentDir, "config/sandbox.json.migration") : join(agentDir, kind === "global-legacy" ? "sandbox.json" : "sandbox.json.migration");
    writeFileSync(path, "{}");
    await expect(persistProjectDockerPreference(cwd, "off", agentDir)).rejects.toThrow();
    expect(existsSync(projectPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{}");
});

test.each(["sandbox.json", "sandbox.json.migration", "config/sandbox.json.migration"])("installation UI refuses pending %s before offering writes", async (legacy) => {
    const { agentDir, cwd } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, true);
    writeFileSync(join(agentDir, legacy), "{}");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const session = await createTestSession({ cwd, extensionFactories: [sandboxExtension], mockUI: { select: "Global: Add", input: "tools", editor: "[]", confirm: true } });
        try {
            await session.session.prompt("/sandbox installations");
            expect(session.events.uiCallsFor("select")).toHaveLength(0);
            expect(session.events.uiCallsFor("notify").some(call => /migration|migrat/i.test(String(call.args[0])))).toBe(true);
            expect(existsSync(join(agentDir, "config/sandbox.json"))).toBe(false);
        } finally {
            await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
        }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("a trusted Git worktree under umask 0002 loads its group-writable configuration unchanged",()=>{
 const f=fixture();writeFileSync(f.projectPath,JSON.stringify({network:{allowedDomains:[]}}));
 execFileSync("git",["init","-q",f.cwd]);execFileSync("git",["-C",f.cwd,"add","."]);
 execFileSync("git",["-C",f.cwd,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture"]);
 const worktree=join(f.cwd,"..","checkout");
 execFileSync("sh",["-c",'umask 002; exec git -C "$1" worktree add --detach "$2" HEAD',"fixture",f.cwd,worktree],{stdio:"pipe"});
 const path=join(worktree,".pi/config/sandbox.json");const before=readFileSync(path,"utf8");expect(statSync(path).mode & 0o777).toBe(0o664);
 new ProjectTrustStore(f.agentDir).set(worktree,true);
 expect(loadSandboxConfig(worktree,{agentDir:f.agentDir,projectTrusted:true}).source).toBe("project-config");
 expect(readFileSync(path,"utf8")).toBe(before);expect(statSync(path).mode & 0o777).toBe(0o664);
});

test("real Pi repair confirms a metadata change but keeps malformed configuration blocked",async()=>{
 const f=fixture();const path=join(f.agentDir,"config/sandbox.json");const body='{"environment":{"variables":{"TOKEN":"fixture-private"}}';writeFileSync(path,body);chmodSync(path,0o664);
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=f.agentDir;
 try{
 const session=await createTestSession({cwd:f.cwd,extensionFactories:[sandboxExtension],mockUI:{confirm:true}});
 try{
 await session.session.prompt("/sandbox repair");
 expect(session.events.uiCallsFor("confirm")).toHaveLength(1);expect(statSync(path).mode & 0o777).toBe(0o644);expect(readFileSync(path,"utf8")).toBe(body);
 const notices=session.events.uiCallsFor("notify").map(c=>String(c.args[0]));expect(notices.some(m=>m.includes("Invalid JSON")&&m.includes(path))).toBe(true);expect(notices.join("\n")).not.toContain("fixture-private");expect(notices.join("\n")).not.toContain("initialization completed");
 }finally{session.dispose();}
 }finally{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});
