import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSandboxConfig } from "./index.ts";
import { sandboxDoctor } from "./doctor.ts";
import type { PrivateRuntimeBundle } from "./runtime/runtime-bundle.ts";
import { createAdmittedSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import { createBashPolicy } from "./runtime/policies.ts";
import { createPrivateTempLease } from "./runtime/private-temp.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "doctor-")); roots.push(root);
    const cwd = join(root, "project"); const agentDir = join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const real = join(root, "real-tool"); const link = join(cwd, "Tool");
    writeFileSync(real, "#!/bin/sh\nexit 99\n", { mode: 0o700 }); symlinkSync(real, link);
    return { cwd, real, configure(filesystem: object) {
        writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: "fixture", filesystem, environment: { path: [cwd] } }), { mode: 0o600 });
        return loadSandboxConfig(cwd, { agentDir, machineId: "fixture" });
    } };
}
test("doctor reports uncovered symlink targets and precise grants", () => {
    const f = fixture();
    expect(sandboxDoctor(f.configure({ allowRead: ["."] }), "Tool")).toContain("Configured read coverage: missing");
    expect(sandboxDoctor(f.configure({ allowRead: [".", f.real] }), "Tool")).toContain("Configured read coverage: covered");
    expect(sandboxDoctor(f.configure({ allowRead: ["."], denyRead: ["Tool"] }), "Tool")).toContain("Configured read coverage: denied");
    expect(sandboxDoctor(f.configure({}), "missing-probe-tool")).toContain("Executable unavailable on sandbox PATH");
});

test("doctor distinguishes Docker authorization from an unexposed client link without executing it", () => {
    const f = fixture();
    const bin = join(dirname(f.cwd), "host-bin");
    mkdirSync(bin);
    symlinkSync(f.real, join(bin, "docker"));
    const resolved = f.configure({ allowRead: [f.real] });
    resolved.config.environment.path = [bin];
    resolved.config.docker = { mode: "targeted", endpoint: "unix:///hidden.sock", targets: [] };
    const output = sandboxDoctor(resolved);
    expect(output).toContain("Docker: targeted");
    expect(output).toContain("Docker CLI: inaccessible (planned inspection)");
    expect(output).toContain(`Read grant missing for executable: ${join(bin, "docker")}`);
    expect(output).toContain("Docker permission does not expose the client executable or Compose plugin.");
    expect(output).not.toContain("hidden.sock");
});

test("doctor reports an exposed Docker client separately from an inaccessible Compose plugin without executing either", () => {
    const f = fixture();
    const marker = join(f.cwd, "executed");
    writeFileSync(join(f.cwd, "docker"), `#!/bin/bash\nprintf executed > '${marker}'\n`, { mode: 0o700 });
    const resolved = f.configure({ allowRead: ["/bin/bash", "/usr/bin/bash"] });
    resolved.config.docker = { mode: "targeted", endpoint: "unix:///hidden.sock", targets: [] };
    const output = sandboxDoctor(resolved);
    expect(output).toContain("Docker CLI: exposed (planned inspection)");
    expect(output).toMatch(/Docker Compose: (unavailable|inaccessible) \(planned inspection/);
    expect(output).toContain("Static inspection does not prove client execution");
    expect(existsSync(marker)).toBeFalse();
});

test("doctor selects an exposed PATH candidate after an unexposed host candidate", () => {
    const f = fixture();
    const bin = join(dirname(f.cwd), "host-bin");
    mkdirSync(bin);
    symlinkSync(f.real, join(bin, "docker"));
    writeFileSync(join(f.cwd, "docker"), "#!/usr/bin/true\n", { mode: 0o700 });
    const resolved = f.configure({ allowRead: [f.real, "/usr/bin/true"] });
    resolved.config.environment.path = [bin, f.cwd];
    const output = sandboxDoctor(resolved, "docker");
    expect(output).toContain(`Resolved executable: ${join(f.cwd, "docker")}`);
    expect(output).toContain("Configured read coverage: covered");
});

test("doctor retains denial priority for Docker clients and does not disclose custom plugin configuration values", () => {
    const f = fixture();
    const tool = join(f.cwd, "docker");
    symlinkSync(f.real, tool);
    const resolved = f.configure({ allowRead: [f.real], denyRead: [f.real] });
    resolved.config.docker = { mode: "targeted", endpoint: "unix:///hidden.sock", targets: [] };
    resolved.config.environment.variables.DOCKER_CONFIG = "never-display-this-config-value";
    const output = sandboxDoctor(resolved);
    expect(output).toContain("Docker CLI: inaccessible");
    expect(output).toContain(`Read denied for executable: ${tool}`);
    expect(output).toContain("Docker Compose: unknown");
    expect(output).not.toContain("never-display-this-config-value");
});
test("doctor distinguishes private commands and inaccessible interpreters without executing either",()=>{
 const f=fixture();const shell=join(f.cwd,"runtime");mkdirSync(join(shell,"bin"),{recursive:true});
 writeFileSync(join(shell,"bin/bash"),"#!/missing/interpreter\nexit 99",{mode:0o700});
 const runtime={root:f.cwd,binaryPath:join(f.cwd,"engine"),target:"x86_64-unknown-linux-gnu",version:"test",manifestSha256:"a".repeat(64),helperSha256:"b".repeat(64),components:{shell:{root:shell,files:[]},analysis:{root:join(f.cwd,"analysis"),files:[]}}} satisfies PrivateRuntimeBundle;
 const text=sandboxDoctor(f.configure({}),"bash",undefined,runtime);
 expect(text).toContain("Command source: private runtime");
 expect(text).toContain("Dependency inaccessible: /missing/interpreter");
 expect(text).toContain("planned");
});
test("doctor recognizes an explicitly configured filesystem root", () => {
    const f = fixture();
    expect(sandboxDoctor(f.configure({ allowRead: ["/"] }), "Tool")).toContain("Configured read coverage: covered");
});
test("doctor identifies inaccessible ELF dependencies through the real executable without running it",()=>{
 const f=fixture();copyFileSync("/bin/bash",f.real);
 const output=sandboxDoctor(f.configure({allowRead:[".",f.real]}),"Tool");
 expect(output).toMatch(/Dependency inaccessible: \/.*ld-linux/);
 expect(output).toContain("Dependency inaccessible: libc.so");
});

test("doctor resolves home-relative paths from admitted mount records",async()=>{
 const f=fixture();const toolRoot=mkdtempSync(join(homedir(),"doctor-installation-"));roots.push(toolRoot);
 writeFileSync(join(toolRoot,"probe"),"#!/__zerobox/runtime/bin/bash\nexit 99\n",{mode:0o700});
 const resolved=f.configure({allowRead:[toolRoot]});resolved.config.environment.path=[toolRoot];
 const lease=await createPrivateTempLease();try{
  const policy=createBashPolicy({cwd:f.cwd,config:resolved.config,lease});
  const context=createAdmittedSandboxExecutionContext({sha256:"a".repeat(64),report:{schema:1,runtime:{target:"x86_64-unknown-linux-gnu",version:"test",component:"shell",manifestSha256:"a".repeat(64)},helperSha256:"b".repeat(64),kernelMounts: [], mounts:[{source:toolRoot,destination:toolRoot,access:"ro",origin:"policy"}],filesystem:policy.filesystem,network:policy.network,resources:{unixSockets:[],tcpPublications:[]},environment:{inherit:[],set:Object.keys(policy.environment.set),deny:[]},path:[toolRoot],home:{path:"/home/sandbox",namespace:"lease-private"},tmp:{path:"/tmp",namespace:"lease-private"},docker:{mode:"disabled"}}},"bash-general",lease,{homeDir:homedir()});
  const output=sandboxDoctor(resolved,"probe",context);
  expect(output).toContain(`Resolved executable: ${join(toolRoot,"probe")}`);
  expect(output).toContain("Configured read coverage: covered");
 }finally{await lease.dispose();}
});

test("doctor attributes only selected files to their installation label", () => {
    const f = fixture();
    const selected = join(f.cwd, "selected");
    const sibling = join(f.cwd, "sibling");
    for (const file of [selected, sibling]) writeFileSync(file, "#!/__zerobox/runtime/bin/bash\nexit 0\n", { mode: 0o700 });
    const resolved = f.configure({});
    resolved.config.environment.installations = [{ name: "local", roots: [{ root: f.cwd, files: ["selected"], path: ["."] }] }];
    expect(sandboxDoctor(resolved, "selected")).toContain("Command source: authorized installation local");
    expect(sandboxDoctor(resolved, "sibling")).toContain("Command source: explicit filesystem configuration");
});
