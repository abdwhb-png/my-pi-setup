import { writeFixtureFile as writeFileSync } from "../../_shared/testing/config-fixture.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync,statSync,renameSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxConfigurationIssue, repairSandboxConfigPermissions, canonicalProjectPath, readGlobalSandboxConfig, readProjectSandboxConfig } from "./authority.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "sandbox-authority-")); roots.push(root); const agent = join(root, "agent"); const project = join(root, "project"); mkdirSync(join(agent,"config"),{recursive:true}); mkdirSync(project); return { root, agent, project }; }

test("refuses a dangling global authority instead of treating it as absent", () => {
    const { agent } = fixture(); const path = join(agent, "config", "sandbox.json"); symlinkSync(join(agent, "missing"), path);
    expect(() => readGlobalSandboxConfig(path, "machine")).toThrow("symbolic link");
});
test("canonicalizes a project alias before applying a ceiling", () => {
    const { root, project } = fixture(); const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(project, "escape"));
    expect(canonicalProjectPath("escape/cache", project)).toBe(join(outside, "cache"));
});
test("requires owner-only versioned global config and rejects reserved project fields", () => {
    const { agent, project } = fixture(); const global = join(agent, "config", "sandbox.json"); writeFileSync(global, JSON.stringify({ version: 2, machineId: "machine" }), { mode: 0o600 }); chmodSync(global, 0o600);
    expect(readGlobalSandboxConfig(global, "machine")?.version).toBe(2);
    const local = join(project, "config", "sandbox.json"); writeFileSync(local, JSON.stringify({ version: 2 }));
    expect(() => readProjectSandboxConfig(local)).toThrow("reserved to global");
});

test("project checkout permissions accept group writes without changing the file", () => {
 const {project}=fixture(); const path=join(project,"sandbox.json");
 writeFileSync(path, JSON.stringify({network:{allowedDomains:[]}})); chmodSync(path,0o664);
 expect(readProjectSandboxConfig(path)?.network?.allowedDomains).toEqual([]);
});
test("global group writes explain the precise file and repair", () => {
 const {agent}=fixture(); const path=join(agent,"config/sandbox.json");
 writeFileSync(path,JSON.stringify({version:2,machineId:"machine"})); chmodSync(path,0o664);
 expect(()=>readGlobalSandboxConfig(path,"machine")).toThrow(path);
 expect(()=>readGlobalSandboxConfig(path,"machine")).toThrow("/sandbox repair");
});

test("permission repair preserves content and rejects a replaced file", () => {
 const {agent,project}=fixture();const path=join(agent,"config/sandbox.json");const body=JSON.stringify({version:2,machineId:"machine"});
 writeFileSync(path,body);chmodSync(path,0o664);
 let issue;try{readGlobalSandboxConfig(path,"machine");}catch(e){issue=sandboxConfigurationIssue(e);}
 expect(issue?.reason).toBe("permissions");if(!issue)throw Error("missing issue");
 repairSandboxConfigPermissions(issue,path,join(project,"sandbox.json"));
 expect(statSync(path).mode & 0o777).toBe(0o644);expect(readFileSync(path,"utf8")).toBe(body);
 chmodSync(path,0o664);try{readGlobalSandboxConfig(path,"machine");}catch(e){issue=sandboxConfigurationIssue(e);}
 if(!issue)throw Error("missing issue");renameSync(path,path+".old");writeFileSync(path,body);chmodSync(path,0o664);
 expect(()=>repairSandboxConfigPermissions(issue!,path,join(project,"sandbox.json"))).toThrow("changed");expect(statSync(path).mode & 0o777).toBe(0o664);
});
test("project public writes and symlinks remain refused; JSON diagnostics hide contents",()=>{
 const {project}=fixture();const path=join(project,"sandbox.json");writeFileSync(path,"{}");chmodSync(path,0o666);
 expect(()=>readProjectSandboxConfig(path)).toThrow("public writes");
 chmodSync(path,0o644);symlinkSync(path,path+".link");expect(()=>readProjectSandboxConfig(path+".link")).toThrow("symbolic link");
 writeFileSync(path,'{"environment":{"variables":{"TOKEN":"private-fixture"}}');
 try{readProjectSandboxConfig(path);throw Error("accepted invalid JSON");}catch(e){expect(sandboxConfigurationIssue(e)?.reason).toBe("json");expect(String(e)).not.toContain("private-fixture");}
});

test.skipIf(!process.getuid)("foreign ownership is a distinct refusal and cannot be repaired",()=>{
 const {project,agent}=fixture();const path=join(project,"sandbox.json");writeFileSync(path,"{}");const original=statSync(path);const uid=spyOn(process,"getuid").mockReturnValue(original.uid+1);
 try {let issue;try{readProjectSandboxConfig(path);}catch(e){issue=sandboxConfigurationIssue(e);}
 expect(issue?.reason).toBe("owner");if(!issue)throw Error("missing ownership diagnostic");
 expect(()=>repairSandboxConfigPermissions(issue!,join(agent,"config/sandbox.json"),path)).toThrow("cannot be repaired");expect(statSync(path).mode).toBe(original.mode);
 }finally{uid.mockRestore();}
});
