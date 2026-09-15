import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "./index.ts";
const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "pi-profiles-")); roots.push(root); const agentDir = join(root, "agent"); const cwd = join(root, "project"); mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true }); return { root, agentDir, cwd }; }
function global(agentDir: string, machineId: string, policy: Record<string, unknown>) { writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId, ...policy }), { mode: 0o600 }); }
test("real configuration files keep ordinary Docker targets in each project", () => {
    const { root, agentDir, cwd } = fixture();
    const second = join(root, "second");
    mkdirSync(join(second, ".pi"), { recursive: true });
    global(agentDir, "machine", { docker: { allowed: true, unsafeTargets: [{ type: "container-name", name: "sensitive" }] } });
    for (const [project, name] of [[cwd, "first"], [second, "second"]]) {
        writeFileSync(join(project, ".pi/sandbox.json"), JSON.stringify({ docker: { enabled: true, targets: [{ selector: { type: "container-name", name }, operations: ["logs"] }] } }), { mode: 0o600 });
        expect(loadSandboxConfig(project, { agentDir, machineId: "machine" }).config.docker).toMatchObject({ mode: "targeted", targets: [{ selector: { type: "container-name", name }, operations: ["logs"], allowUnsafeTarget: false }] });
    }
    writeFileSync(join(second, ".pi/sandbox.json"), JSON.stringify({ docker: { enabled: true, unsafeTargets: [] } }), { mode: 0o600 });
    expect(() => loadSandboxConfig(second, { agentDir, machineId: "machine" })).toThrow("Unknown project docker field");
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.docker).toMatchObject({ targets: [{ selector: { name: "first" } }] });
});
test("project restrictions derive custom while preserving the global ceiling", () => { const { root, agentDir, cwd } = fixture(); mkdirSync(join(cwd, "src")); global(agentDir, "machine", { network: { allowedDomains: ["example.com"] }, filesystem: { allowWrite: [cwd] }, tmpNamespace: "host" }); writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ network: { allowedDomains: [] }, filesystem: { allowWrite: ["src"] }, tmpNamespace: "lease-private" })); const result = loadSandboxConfig(cwd, { agentDir, machineId: "machine" }); expect(result.shell.profile).toBe("custom"); expect(result.config.tmpNamespace).toBe("lease-private"); expect(result.config.filesystem.allowWrite).toEqual([join(cwd, "src")]); expect(result.config.network.allowedDomains).toEqual([]); });
test("a new installation defaults to sandbox mode with no network destinations", () => { const { agentDir, cwd } = fixture(); const result = loadSandboxConfig(cwd, { agentDir, machineId: "machine" }); expect(result.shell.mode).toBe("sandbox"); expect(result.shell.profile).toBe("default"); expect(result.config.network.allowedDomains).toEqual([]); });
test("a project cannot auto-select host mode", () => { const { agentDir, cwd } = fixture(); global(agentDir, "machine", { mode: "host" }); writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ mode: "host" })); expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("explicit current-session"); });
test("explicit empty project ceilings close project reads and writes", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", { filesystem: { allowRead: [], allowWrite: [] } });
    const result = loadSandboxConfig(cwd, { agentDir, machineId: "machine" });
    expect(result.config.filesystem.allowRead).toEqual([]);
    expect(result.config.filesystem.allowWrite).toEqual([]);
});
test("resources inherit the global ceiling and explicit project lists close it", () => {
    const { agentDir, cwd } = fixture();
    const socket = join(cwd, "service.sock");
    const publication = { transport: "tcp" as const, scope: "host" as const, listen: "127.0.0.1:41001", target: "127.0.0.1:41002" };
    global(agentDir, "machine", { resources: { unixSockets: [socket], tcpPublications: [publication] } });
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.resources).toEqual({ unixSockets: [socket], tcpPublications: [publication] });
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ resources: { unixSockets: [], tcpPublications: [] } }));
    const closed = loadSandboxConfig(cwd, { agentDir, machineId: "machine" });
    expect(closed.config.resources).toEqual({ unixSockets: [], tcpPublications: [] });
});
test("a resource leaf inherits when its project and session leaves are absent", () => {
    const { agentDir, cwd } = fixture();
    const socket = join(cwd, "service.sock");
    const publication = { transport: "tcp" as const, scope: "host" as const, listen: "127.0.0.1:41003", target: "127.0.0.1:41004" };
    global(agentDir, "machine", { resources: { unixSockets: [socket], tcpPublications: [publication] } });
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ resources: { unixSockets: [] } }));
    const result = loadSandboxConfig(cwd, { agentDir, machineId: "machine", session: { resources: { unixSockets: [] } } });
    expect(result.config.resources).toEqual({ unixSockets: [], tcpPublications: [publication] });
});
test("canonicalizes equivalent IPv6 publication tuples before project restriction", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        resources: {
            tcpPublications: [{
                transport: "tcp",
                scope: "host",
                listen: "[0:0:0:0:0:0:0:1]:41011",
                target: "[0:0:0:0:0:0:0:1]:41012",
            }],
        },
    });
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({
        resources: {
            tcpPublications: [{
                transport: "tcp",
                scope: "host",
                listen: "[::1]:41011",
                target: "[::1]:41012",
            }],
        },
    }));
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.resources?.tcpPublications).toEqual([{
        transport: "tcp",
        scope: "host",
        listen: "[::1]:41011",
        target: "[::1]:41012",
    }]);
});
test("canonicalizes a home-relative Unix socket before comparing project restrictions", () => {
    const { agentDir, cwd } = fixture();
    const socket = join(homedir(), "run", "pi-resource.sock");
    global(agentDir, "machine", { resources: { unixSockets: ["~/run/pi-resource.sock"] } });
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ resources: { unixSockets: [socket] } }));
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.resources?.unixSockets).toEqual([socket]);
});
test("active loading rejects invalid resource fields and UDP", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", { resources: { unixSokcets: [] } });
    expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("Unknown global.resources field: unixSokcets");
    global(agentDir, "machine", { resources: { tcpPublications: [{ transport: "udp", scope: "host", listen: "127.0.0.1:41001", target: "127.0.0.1:41002" }] } });
    expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("unsupported capability");
});
test("loader rejects raw Docker daemon sockets and accepts an unrelated exact socket", () => {
    const { root, agentDir, cwd } = fixture();
    const daemon = join(root, "daemon.sock");
    const alias = join(root, "daemon-alias.sock");
    const hardlink = join(root, "daemon-hardlink.sock");
    const service = join(root, "service.sock");
    writeFileSync(daemon, "daemon");
    writeFileSync(service, "service");
    symlinkSync(daemon, alias);
    linkSync(daemon, hardlink);
    global(agentDir, "machine", { resources: { unixSockets: ["/var/run/docker.sock"] } });
    expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("Raw Docker daemon sockets");
    const inactiveDocker = {
        allowed: false,
        mode: "targeted",
        endpoint: `unix://${daemon}`,
    };
    global(agentDir, "machine", { docker: inactiveDocker, resources: { unixSockets: [alias] } });
    expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("Raw Docker daemon sockets");
    global(agentDir, "machine", { docker: inactiveDocker, resources: { unixSockets: [hardlink] } });
    expect(() => loadSandboxConfig(cwd, { agentDir, machineId: "machine" })).toThrow("Raw Docker daemon sockets");
    global(agentDir, "machine", { docker: inactiveDocker, resources: { unixSockets: [service] } });
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.resources?.unixSockets).toEqual([service]);
});
test("a domain beneath a wildcard ceiling remains a valid project restriction", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", { network: { allowedDomains: ["*.example.com"] } });
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["api.example.com"] } }));
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.network.allowedDomains).toEqual(["api.example.com"]);
});
test("a restriction alone derives custom and returning to the effective baseline derives default", () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ filesystem: { allowRead: [], denyWrite: ["src"] } }));
    const restricted = loadSandboxConfig(cwd, { agentDir, machineId: "machine" });
    expect(restricted.shell.profile).toBe("custom");
    writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify({}));
    const restored = loadSandboxConfig(cwd, { agentDir, machineId: "machine" });
    expect(restored.shell.profile).toBe("default");
});

test("active loading rejects nested typos instead of silently discarding them", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        network: { allowedDomains: [], allowLocalBnding: false },
    });
    expect(() =>
        loadSandboxConfig(cwd, { agentDir, machineId: "machine" }),
    ).toThrow("Unknown global.network field");
});

test("active loading retains recognized generic environment and network settings", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        network: { allowLocalBinding: false },
        environment: {
            allowedVariables: ["LANG"],
            deniedVariables: ["TERM"],
            variables: { LANG: "C" },
            path: ["/usr/bin"],
        },
    });
    const config = loadSandboxConfig(cwd, {
        agentDir,
        machineId: "machine",
    }).config;
    expect(config.network.allowLocalBinding).toBeFalse();
    expect(config.environment.allowedVariables).toEqual(["LANG"]);
    expect(config.environment.deniedVariables).toEqual(["TERM"]);
    expect(config.environment.variables).toEqual({ LANG: "C" });
    expect(config.environment.path).toEqual(["/usr/bin"]);
    expect(config.filesystem.allowRead).not.toContain("/usr/bin");
});

test("active loading expands PATH entries before comparing global, project and session restrictions", () => {
    const { agentDir, cwd } = fixture();
    const tools = join(homedir(), ".pi-path-fixture", "bin");
    global(agentDir, "machine", { environment: { path: ["~/.pi-path-fixture/bin"] } });
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.environment.path).toEqual([tools]);
    writeFileSync(join(cwd, ".pi/sandbox.json"), JSON.stringify({ environment: { path: [tools] } }));
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine", session: { environment: { path: ["~/.pi-path-fixture/bin"] } } }).config.environment.path).toEqual([tools]);
    writeFileSync(join(cwd, ".pi/sandbox.json"), JSON.stringify({ environment: { path: ["~/.pi-ungranted-path/bin"] } }));
    expect(loadSandboxConfig(cwd, { agentDir, machineId: "machine" }).config.environment.path).toEqual([]);
});

test("a project can restrict, but not add, globally configured environment values", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        environment: {
            allowedVariables: ["LANG", "TERM"],
            variables: { LANG: "C", TERM: "xterm" },
        },
    });
    writeFileSync(
        join(cwd, ".pi", "sandbox.json"),
        JSON.stringify({
            environment: {
                allowedVariables: ["LANG"],
                deniedVariables: ["TERM"],
                variables: { LANG: "C" },
            },
        }),
    );
    const environment = loadSandboxConfig(cwd, {
        agentDir,
        machineId: "machine",
    }).config.environment;
    expect(environment.allowedVariables).toEqual(["LANG"]);
    expect(environment.deniedVariables).toContain("TERM");
    expect(environment.variables).toEqual({ LANG: "C" });
});

test("a project cannot inject an environment value outside the global ceiling", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        environment: { variables: { LANG: "C" } },
    });
    writeFileSync(
        join(cwd, ".pi", "sandbox.json"),
        JSON.stringify({ environment: { variables: { NEW_VALUE: "unsafe" } } }),
    );
    expect(() =>
        loadSandboxConfig(cwd, { agentDir, machineId: "machine" }),
    ).toThrow("outside its ceiling");
});

test("a project cannot reopen globally disabled local binding", () => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        network: { allowLocalBinding: false },
    });
    writeFileSync(
        join(cwd, ".pi", "sandbox.json"),
        JSON.stringify({ network: { allowLocalBinding: true } }),
    );
    expect(() =>
        loadSandboxConfig(cwd, { agentDir, machineId: "machine" }),
    ).toThrow("outside its ceiling");
});

test("external filesystem denials protect another project without blocking it as the current project", () => {
    const { root, agentDir, cwd } = fixture();
    const projects = join(root, "projects");
    const protectedProject = join(projects, "Foundry-AI");
    const siblingProject = join(projects, "sibling");
    mkdirSync(protectedProject, { recursive: true });
    mkdirSync(siblingProject, { recursive: true });
    global(agentDir, "machine", {
        filesystem: {
            allowRead: [projects],
            allowWrite: [projects],
            denyReadWhenExternal: [protectedProject],
            denyWriteWhenExternal: [protectedProject],
        },
    });

    const external = loadSandboxConfig(siblingProject, {
        agentDir,
        machineId: "machine",
    }).config.filesystem;
    expect(external.denyRead).toContain(protectedProject);
    expect(external.denyWrite).toContain(protectedProject);

    const parent = loadSandboxConfig(projects, {
        agentDir,
        machineId: "machine",
    }).config.filesystem;
    expect(parent.denyRead).toContain(protectedProject);
    expect(parent.denyWrite).toContain(protectedProject);

    const current = loadSandboxConfig(protectedProject, {
        agentDir,
        machineId: "machine",
    }).config.filesystem;
    expect(current.allowRead).toContain(protectedProject);
    expect(current.allowWrite).toContain(protectedProject);
    expect(current.denyRead).not.toContain(protectedProject);
    expect(current.denyWrite).not.toContain(protectedProject);
});

test("external filesystem denials require stable literal global paths", () => {
    for (const configuredPath of ["Foundry-AI", "/projects/Foundry-*"]) {
        const { agentDir, cwd } = fixture();
        global(agentDir, "machine", {
            filesystem: {
                denyReadWhenExternal: [configuredPath],
            },
        });
        expect(() =>
            loadSandboxConfig(cwd, {
                agentDir,
                machineId: "machine",
            }),
        ).toThrow("absolute or home-relative literal paths");
    }
});

test.each([
    "denyReadWhenExternal",
    "denyWriteWhenExternal",
] as const)("reserves filesystem.%s to the global authority", (field) => {
    const { agentDir, cwd } = fixture();
    global(agentDir, "machine", {
        filesystem: { allowRead: [cwd], allowWrite: [cwd] },
    });
    writeFileSync(
        join(cwd, ".pi", "sandbox.json"),
        JSON.stringify({ filesystem: { [field]: [cwd] } }),
    );
    expect(() =>
        loadSandboxConfig(cwd, { agentDir, machineId: "machine" }),
    ).toThrow(`Unknown project.filesystem field: ${field}`);
});

test("canonicalizes home-relative external denials before applying them", () => {
    const { agentDir, cwd } = fixture();
    const protectedRoot = join(homedir(), ".pi-protected-project-fixture");
    global(agentDir, "machine", {
        filesystem: {
            denyReadWhenExternal: ["~/.pi-protected-project-fixture"],
        },
    });
    const filesystem = loadSandboxConfig(cwd, {
        agentDir,
        machineId: "machine",
    }).config.filesystem;
    expect(filesystem.denyRead).toContain(protectedRoot);
});
