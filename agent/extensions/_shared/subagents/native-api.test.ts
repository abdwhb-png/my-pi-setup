import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubagentPackage } from "./index.ts";
import { preflightSubagent } from "./index.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

test("public preflight selects a project-only package after saved trust approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-trusted-project-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent"), cwd = join(root, "project"), pkg = join(root, "package");
        mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(pkg);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./preflight": "./preflight.ts" } }));
        writeFileSync(join(pkg, "preflight.ts"), 'export function resolveSubagentLaunchContract() { return { ok: true, marker: "project-owner" }; }');
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
        const input = { cwd, agent: "reader", context: "fresh" as const };
        await expect(preflightSubagent(input)).rejects.toThrow("found 0");
        new ProjectTrustStore(agentDir).set(cwd, true);
        expect(await preflightSubagent(input)).toMatchObject({ ok: true, marker: "project-owner" });
        await expect(preflightSubagent(input, { projectTrusted: false })).rejects.toThrow("found 0");
        new ProjectTrustStore(agentDir).set(cwd, false);
        expect(await preflightSubagent(input, { projectTrusted: true })).toMatchObject({ ok: true, marker: "project-owner" });
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});

test("package resolution keeps one physical configured owner and ignores untrusted project packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-package-root-"));
    try {
        const agentDir = join(root, "agent"), cwd = join(root, "project");
        mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
        const pkg = (name: string) => {
            const path = join(root, name); mkdirSync(path);
            writeFileSync(join(path, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./preflight": "./preflight.ts" } }));
            writeFileSync(join(path, "preflight.ts"), "export {};\n");
            return path;
        };
        const first = pkg("first"), second = pkg("second");
        const alias = join(root, "alias"); symlinkSync(first, alias);
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [first, alias] }));
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [second] }));
        expect(await resolveSubagentPackage(cwd, agentDir)).toEqual({ root: realpathSync(first), preflight: join(realpathSync(first), "preflight.ts") });
        await expect(resolveSubagentPackage(cwd, agentDir, true)).rejects.toThrow("found 2");
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        await expect(resolveSubagentPackage(cwd, agentDir)).rejects.toThrow("found 0");
        expect((await resolveSubagentPackage(cwd, agentDir, true)).root).toBe(realpathSync(second));
        rmSync(join(second, "preflight.ts"));
        symlinkSync(join(first, "preflight.ts"), join(second, "preflight.ts"));
        await expect(resolveSubagentPackage(cwd, agentDir, true)).rejects.toThrow("escapes");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight forwards the resolved project trust decision to the package API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-trust-input-'));
    const agentDir = join(root, 'agent'), cwd = join(root, 'project'), pkg = join(root, 'package');
    try {
        mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(pkg);
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({name:'pi-subagents',exports:{'./preflight':'./preflight.ts'}}));
        writeFileSync(join(pkg, 'preflight.ts'), 'export function resolveSubagentLaunchContract(input) { return {ok:true, projectTrusted:input.projectTrusted}; }');
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({packages:[pkg]}));
        expect(await preflightSubagent({agent:'reader',cwd}, {agentDir,projectTrusted:false})).toMatchObject({projectTrusted:false});
        expect(await preflightSubagent({agent:'reader',cwd}, {agentDir,projectTrusted:true})).toMatchObject({projectTrusted:true});
        expect(await preflightSubagent({agent:'reader',cwd}, {agentDir})).toMatchObject({projectTrusted:false});
        new ProjectTrustStore(agentDir).set(cwd,true);
        expect(await preflightSubagent({agent:'reader',cwd}, {agentDir})).toMatchObject({projectTrusted:true});
    } finally {rmSync(root,{recursive:true,force:true});}
});

test("effective reader loads a conditional package export and returns native resolved tools", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(tmpdir(), "subagent-effective-reader-"));
    try {
        const agentDir = join(root,"agent"), cwd = join(root,"project"), pkg = join(root,"package");
        mkdirSync(join(agentDir,"agents"),{recursive:true}); mkdirSync(join(agentDir,"config")); mkdirSync(cwd); mkdirSync(pkg);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"pi-subagents", exports:{"./preflight":"./preflight.ts", "./agents":{types:"./agents.d.ts", default:"./agents.ts"}}}));
        writeFileSync(join(pkg,"preflight.ts"),"export {};\n");
        writeFileSync(join(pkg,"agents.ts"),`export { discoverAgents } from ${JSON.stringify(import.meta.resolve("pi-subagents/agents"))};`);
        writeFileSync(join(agentDir,"settings.json"),JSON.stringify({packages:[pkg],subagents:{toolSelectionResolver:join(import.meta.dir,"../../pi-subagents-addons/tool-selection.ts")}}));
        writeFileSync(join(agentDir,"config/tool-groups.json"),JSON.stringify({groups:{inspect:["read"]}}));
        writeFileSync(join(agentDir,"agents/reader.md"),"---\nname: reader\ndescription: Reader fixture\ntools: '@inspect'\n---\nInspect.\n");
        const {discoverSubagents} = await import("./index.ts");
        const discovered = await discoverSubagents(cwd,{projectTrusted:false});
        expect(discovered.agents.find(agent=>agent.name === "reader")?.tools).toEqual(["read"]);
    } finally {
        if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;
        rmSync(root,{recursive:true,force:true});
    }
});
