import { expect, test } from "bun:test";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import { sandboxAccessRemoved } from "./revocation.ts";
import { resolveShellPolicy } from "./policy.ts";

test("resolves relative grants against the admitted project when checking a new absolute denial", () => {
    const previous = validatePiSandboxConfig({ filesystem: { allowRead: ["."], allowWrite: ["."] } });
    const next = validatePiSandboxConfig({ filesystem: { allowRead: ["."], allowWrite: ["."], denyRead: ["/work/project/secret"] } });
    expect(sandboxAccessRemoved(previous, next, "/work/project")).toBe(true);
    expect(sandboxAccessRemoved(previous, next, "/different/project")).toBe(false);
});

test("a project cannot change the port of a globally allowed wildcard domain",()=>{
 const result=resolveShellPolicy({cwd:process.cwd(),baseline:validatePiSandboxConfig({}),authorityPath:"/authority",global:{network:{allowedDomains:["*.example.com:443"]}},project:{network:{allowedDomains:["api.example.com:80"]}}});
 expect(result.config.network.allowedDomains).toEqual([]);
});

test("additions preserve admitted executions while removed file and environment rights revoke them",()=>{
 const previous=validatePiSandboxConfig({filesystem:{allowRead:["/tools/a"],allowWrite:["/project"]},environment:{allowedVariables:["CUSTOM"]},network:{allowedDomains:["example.com:443"]}});
 const additive=validatePiSandboxConfig({filesystem:{allowRead:["/tools"],allowWrite:["/project","/extra"]},environment:{allowedVariables:["CUSTOM","SECOND"]},network:{allowedDomains:["example.com"]}});
 expect(sandboxAccessRemoved(previous,additive)).toBe(false);
 expect(sandboxAccessRemoved(additive,previous)).toBe(true);
 expect(sandboxAccessRemoved(previous,{...previous,environment:{...previous.environment,allowedVariables:[]}})).toBe(true);
 expect(sandboxAccessRemoved(previous,{...previous,filesystem:{...previous.filesystem,denyRead:["/tools/a/secret"]}})).toBe(true);
 expect(sandboxAccessRemoved(previous,{...previous,filesystem:{...previous.filesystem,denyRead:["/unrelated"]}})).toBe(false);
});
test("network ports, host temporary storage, sockets and Docker grants cannot remain after removal",()=>{
 const previous=validatePiSandboxConfig({tmpNamespace:"host",network:{allowedDomains:["*.example.com:443"]},resources:{unixSockets:["/service.sock"]}});
 expect(sandboxAccessRemoved(previous,{...previous,network:{...previous.network,allowedDomains:["*.example.com:80"]}})).toBe(true);
 expect(sandboxAccessRemoved(previous,{...previous,tmpNamespace:"lease-private"})).toBe(true);
 expect(sandboxAccessRemoved(previous,{...previous,resources:{unixSockets:[],tcpPublications:[]}})).toBe(true);
 const docker={...previous,docker:{mode:"full" as const,endpoint:"unix:///var/run/docker.sock"}};
 expect(sandboxAccessRemoved(docker,previous)).toBe(true);
});
