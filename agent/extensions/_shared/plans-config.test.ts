import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlansConfig } from "./plans-config.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"plans-config-")); dirs.push(root);
 const agentDir=join(root,"agent"),cwd=join(root,"project");
 mkdirSync(join(agentDir,"config"),{recursive:true}); mkdirSync(join(cwd,".pi","config"),{recursive:true});
 new ProjectTrustStore(agentDir).set(cwd, true);
 return {agentDir,cwd};
}
test("plans config merges trusted project fields without activating obsolete plannotator config",()=>{
 const {agentDir,cwd}=fixture();
 writeFileSync(join(agentDir,"plannotator.json"),"not json");
 writeFileSync(join(agentDir,"config/plans.json"),JSON.stringify({autoExecute:false}));
 writeFileSync(join(cwd,".pi/config/plans.json"),JSON.stringify({browserCommand:"browser",autoExecute:true}));
 expect(loadPlansConfig(cwd,false,agentDir)).toEqual({autoExecute:false});
 expect(loadPlansConfig(cwd,true,agentDir)).toEqual({autoExecute:true,browserCommand:"browser"});
});
test.each([["false"],[0],[null],[[]]])("invalid autoExecute is rejected (%j)",autoExecute=>{
 const {agentDir,cwd}=fixture();
 writeFileSync(join(agentDir,"config/plans.json"),JSON.stringify({autoExecute}));
 expect(()=>loadPlansConfig(cwd,false,agentDir)).toThrow("autoExecute must be a boolean");
});
test("removed plan override requires migration",()=>{
 const {agentDir,cwd}=fixture();
 writeFileSync(join(agentDir,"config/plans.json"),JSON.stringify({planFileDir:"old"}));
 expect(()=>loadPlansConfig(cwd,false,agentDir)).toThrow("planFileDir");
});
