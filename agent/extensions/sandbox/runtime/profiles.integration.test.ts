import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSandboxedBashOps, loadSandboxConfig } from "../index.ts";
import { createBashProcessSupervisor } from "../../_shared/command-execution/exec.ts";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import {
    SANDBOX_PRIVATE_HOME,
    validatePiSandboxConfig,
} from "./policies.ts";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { candidateBackendOptions, hasCandidateRuntime } from "./integration-fixtures.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";

function createCandidateBackend(leaseRoot: string) {
    return createZeroboxBackend(candidateBackendOptions(leaseRoot));
}

function createTemporaryLeaseOptions(rootDir: string) {
    return {
        createLease: () => createPrivateTempLease({ rootDir }),
        recoverStaleLeases: async () => {
            await recoverStalePrivateTempLeases({ rootDir });
        },
    };
}

test.skipIf(
    !hasCandidateRuntime(),
).each(["lease-private", "host"] as const)("Bash tmp %s preserves strict Think isolation and sibling leases", async namespace => {
    const cwd = await mkdtemp(join(import.meta.dir, ".tmp-profiles-"));
    const hostTmp = await mkdtemp("/tmp/pi-host-contract-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const siblingRoot = await mkdtemp("/var/tmp/z-");
    const sibling = await createPrivateTempLease({ rootDir: siblingRoot });
    const service = createSandboxService({
        backend: createCandidateBackend(leaseRoot),
        config: validatePiSandboxConfig({ tmpNamespace: namespace, filesystem: { allowWrite: ["."] } }),
        ...createTemporaryLeaseOptions(leaseRoot),
    });
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    try {
        await writeFile(join(hostTmp, "from-host"), "from host");
        await service.startBashSession(cwd);
        for (const profile of ["bash-general", "think-strict", "analysis-strict"] as const) {
            const events: object[] = [];
            let dispose: (() => Promise<void>) | undefined;
            const operations = createBashOperations({
                onExecution: event => events.push(event),
                prepareSpawn: async ({ command }) => {
                    const input = { file: PRIVATE_BASH, args: ["-c", command], cwd };
                    if (profile === "bash-general") return service.prepareBash(input);
                    if (profile === "think-strict") return service.prepareThinkBash(input);
                    const handle = await service.prepareAnalysis(input, [cwd]);
                    dispose = () => handle.dispose();
                    return handle.spawn;
                },
                afterClose: async () => { await dispose?.(); },
            });
            const command = profile === "bash-general" && namespace === "host"
                ? `test "$(cat ${quote(join(hostTmp, "from-host"))})" = 'from host' && printf 'from shell' > ${quote(join(hostTmp, "from-shell"))}`
                : `test "$TMPDIR" = /tmp && test ! -e ${quote(join(hostTmp, "from-host"))} && test ! -e ${quote(sibling.markerPath)} && printf private > /tmp/own && test "$(cat /tmp/own)" = private`;
            let output = "";
            const result = await operations.exec(command, cwd, {
                onData: (chunk) => { output += chunk.toString(); }, timeout: 10,
            });
            expect(result.exitCode, `${profile}: ${output}`).toBe(0);
            expect(events.at(-1)).toMatchObject({
                status: "sandboxed", profile, backend: "zerobox", outcome: "succeeded", exitCode: 0,
                tmpNamespace: profile === "bash-general" ? namespace : "lease-private",
            });
        }
        if (namespace === "host") expect(await readFile(join(hostTmp, "from-shell"), "utf8")).toBe("from shell");
        else await expect(readFile(join(hostTmp, "from-shell"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await service.shutdown();
        await sibling.dispose();
        await rm(hostTmp, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
        await rm(siblingRoot, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test.skipIf(
    !hasCandidateRuntime(),
)("external filesystem denials are enforced by Zerobox and lifted only inside the protected project", async () => {
    const root = await mkdtemp("/var/tmp/pi-external-project-");
    const agentDir = join(root, "agent");
    const projects = join(root, "projects");
    const protectedProject = join(projects, "Foundry-AI");
    const siblingProject = join(projects, "sibling");
    const protectedFile = join(protectedProject, "protected.txt");
    const externalWrite = join(protectedProject, "external.txt");
    const currentWrite = join(protectedProject, "current.txt");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const machineId = localMachineId();
    const run = async (cwd: string, command: string) => {
        const service = createSandboxService({
            backend: createCandidateBackend(leaseRoot),
            config: loadSandboxConfig(cwd, { agentDir, machineId }).config,
            ...createTemporaryLeaseOptions(leaseRoot),
        });
        const supervisor = createBashProcessSupervisor();
        let output = "";
        try {
            await service.startBashSession(cwd);
            const result = await createSandboxedBashOps(
                service,
                supervisor,
            ).exec(command, cwd, {
                timeout: 10,
                onData: (chunk) => {
                    output += chunk.toString();
                },
            });
            return { result, output };
        } finally {
            supervisor.shutdown();
            await service.shutdown();
        }
    };
    try {
        await mkdir(agentDir, { recursive: true });
        await mkdir(protectedProject, { recursive: true });
        await mkdir(siblingProject, { recursive: true });
        await writeFile(protectedFile, "protected");
        await writeFile(
            join(agentDir, "sandbox.json"),
            JSON.stringify({
                version: 2,
                machineId,
                filesystem: {
                    allowRead: [projects],
                    allowWrite: [projects],
                    denyReadWhenExternal: [protectedProject],
                    denyWriteWhenExternal: [protectedProject],
                },
            }),
            { mode: 0o600 },
        );

        const external = await run(
            siblingProject,
            `test ! -e ${JSON.stringify(protectedFile)} && if { printf blocked > ${JSON.stringify(externalWrite)}; } 2>/dev/null; then exit 41; fi`,
        );
        expect(external.result.exitCode, external.output).toBe(0);
        await expect(readFile(externalWrite, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });

        const current = await run(
            protectedProject,
            `test "$(cat ${JSON.stringify(protectedFile)})" = protected && printf allowed > ${JSON.stringify(currentWrite)}`,
        );
        expect(current.result.exitCode, current.output).toBe(0);
        expect(await readFile(currentWrite, "utf8")).toBe("allowed");
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 60_000);

test.skipIf(
    !hasCandidateRuntime(),
)("global and project tmp layers control Bash while Think stays private", async () => {
    const root = await mkdtemp(join(import.meta.dir, ".tmp-layered-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const hostTmp = await mkdtemp("/tmp/pi-tmp-layered-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const marker = join(hostTmp, "from-host");
    const hostOutput = join(hostTmp, "from-bash");
    const globalPath = join(agentDir, "sandbox.json");
    const projectPath = join(cwd, ".pi", "sandbox.json");
    const machineId = localMachineId();
    const run = async (config: ReturnType<typeof loadSandboxConfig>["config"], command: string, thinkCommand: string) => {
        const service = createSandboxService({
            backend: createCandidateBackend(leaseRoot),
            config,
            ...createTemporaryLeaseOptions(leaseRoot),
        });
        const supervisor = createBashProcessSupervisor();
        let output = "";
        try {
            await service.startBashSession(cwd);
            const bash = await createSandboxedBashOps(service, supervisor).exec(command, cwd, { timeout: 10, onData: chunk => { output += chunk.toString(); } });
            const think = createBashOperations({
                prepareSpawn: ({ command: value }) => service.prepareThinkBash({ file: PRIVATE_BASH, args: ["-c", value], cwd }),
            });
            const strictThink = await think.exec(thinkCommand, cwd, { timeout: 10, onData: () => {} });
            return { bash, strictThink, output };
        } finally {
            supervisor.shutdown();
            await service.shutdown();
        }
    };
    try {
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await mkdir(agentDir, { recursive: true });
        await writeFile(marker, "host");
        await writeFile(globalPath, JSON.stringify({ version: 2, machineId, tmpNamespace: "host" }), { mode: 0o600 });
        await writeFile(projectPath, "{}");
        const globalHost = loadSandboxConfig(cwd, { agentDir, machineId });
        expect(globalHost.config.tmpNamespace).toBe("host");
        const host = await run(
            globalHost.config,
            `test "$(cat ${JSON.stringify(marker)})" = host && printf bash > ${JSON.stringify(hostOutput)}`,
            `test ! -e ${JSON.stringify(marker)}`,
        );
        expect(host.bash.exitCode, host.output).toBe(0);
        expect(host.strictThink.exitCode).toBe(0);
        expect(await readFile(hostOutput, "utf8")).toBe("bash");

        await writeFile(projectPath, JSON.stringify({ tmpNamespace: "lease-private" }));
        const projectPrivate = loadSandboxConfig(cwd, { agentDir, machineId });
        expect(projectPrivate.config.tmpNamespace).toBe("lease-private");
        const restricted = await run(
            projectPrivate.config,
            `test ! -e ${JSON.stringify(marker)} && test ! -e ${JSON.stringify(hostOutput)}`,
            `test ! -e ${JSON.stringify(marker)}`,
        );
        expect(restricted.bash.exitCode, restricted.output).toBe(0);
        expect(restricted.strictThink.exitCode).toBe(0);

        await writeFile(globalPath, JSON.stringify({ version: 2, machineId, tmpNamespace: "lease-private" }), { mode: 0o600 });
        await writeFile(projectPath, JSON.stringify({ tmpNamespace: "host" }));
        expect(() => loadSandboxConfig(cwd, { agentDir, machineId })).toThrow("outside the global ceiling");
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(hostTmp, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 60_000);

test.skipIf(
    !hasCandidateRuntime(),
)("a project containing lease control keeps its own caches writable without exposing a sibling lease", async () => {
    const root = await mkdtemp("/var/tmp/p");
    const cwd = root;
    const leaseRoot = join(cwd, ".z");
    const sibling = await createPrivateTempLease({ rootDir: leaseRoot });
    const siblingSecret = join(sibling.homeDir, "sibling-secret");
    const service = createSandboxService({
        backend: createCandidateBackend(leaseRoot),
        config: validatePiSandboxConfig({ filesystem: { allowWrite: ["."] } }),
        ...createTemporaryLeaseOptions(leaseRoot),
    });
    const supervisor = createBashProcessSupervisor();
    try {
        await mkdir(cwd, { recursive: true });
        await writeFile(siblingSecret, "must remain private");
        await service.startBashSession(cwd);
        let output = "";
        const result = await createSandboxedBashOps(service, supervisor).exec(
            `mkdir -p "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" && printf cache > "$XDG_CACHE_HOME/probe" && test -f "$XDG_CACHE_HOME/probe" && test ! -e ${JSON.stringify(sibling.markerPath)} && test ! -e ${JSON.stringify(siblingSecret)}`,
            cwd,
            { timeout: 10, onData: chunk => { output += chunk.toString(); } },
        );
        expect(result.exitCode, output).toBe(0);
    } finally {
        supervisor.shutdown();
        await service.shutdown();
        await sibling.dispose();
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test.skipIf(
    !hasCandidateRuntime(),
)("development uses a private logical HOME without granting host home writes", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".tmp-home-"));
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const outside = join(homedir(), `.pi-home-write-probe-${process.pid}`);
    const service = createSandboxService({ backend: createCandidateBackend(leaseRoot), config: validatePiSandboxConfig({ filesystem: { allowWrite: ["."], denyRead: [join(cwd, "denied.txt")] } }), ...createTemporaryLeaseOptions(leaseRoot) });
    const supervisor = createBashProcessSupervisor();
    try {
        await writeFile(join(cwd, "denied.txt"), "private fixture");
        await service.startBashSession(cwd);
        const operations = createSandboxedBashOps(service, supervisor);
        let output = "";
        const command = 'printf "%s:%s" "$HOME" "$PWD"';
        const result = await operations.exec(command, cwd, { timeout: 10, onData: chunk => { output += chunk.toString(); } });
        expect({ code: result.exitCode, output }).toEqual({
            code: 0,
            output: `${SANDBOX_PRIVATE_HOME}:${cwd}`,
        });
        let cacheOutput = "";
        const cache = await operations.exec('test -n "$XDG_CACHE_HOME" && test -n "$BUN_INSTALL_CACHE_DIR" && test -n "$npm_config_cache" && mkdir -p "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" && printf cache > "$XDG_CACHE_HOME/probe"', cwd, { timeout: 10, onData: chunk => { cacheOutput += chunk.toString(); } });
        expect(cache.exitCode, cacheOutput).toBe(0);
        for (const blocked of [`printf forbidden > ${outside}`, "cat denied.txt"]) {
            const denied = await operations.exec(blocked, cwd, { timeout: 10, onData: () => {} });
            expect(denied.exitCode).not.toBe(0);
        }
    } finally {
        supervisor.shutdown();
        await service.shutdown();
        await rm(cwd, { recursive: true, force: true });
        await rm(outside, { force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 30_000);

test.skipIf(
    !hasCandidateRuntime(),
)("Sandbox shell reports an upstream failure even when the final pipeline command succeeds", async () => {
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const service = createSandboxService({ backend: createCandidateBackend(leaseRoot), config: validatePiSandboxConfig({}), ...createTemporaryLeaseOptions(leaseRoot) });
    const supervisor = createBashProcessSupervisor();
    try {
        await service.startBashSession(import.meta.dir);
        const events: object[] = [];
        const contexts: object[] = [];
        const operations = createSandboxedBashOps(service, supervisor, {
            onExecution: value => events.push(value),
            onSandboxContext: value => contexts.push(value),
        });
        const result = await operations.exec("(printf failed; exit 7) | tail -n 1", import.meta.dir, { timeout: 10, onData: () => {} });
        expect(result.exitCode).toBe(7);
        expect(events.at(-1)).toMatchObject({ outcome: "failed", exitCode: 7 });
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toMatchObject({
            version: 3,
            profile: "bash-general",
        });
    } finally { supervisor.shutdown(); await service.shutdown(); await rm(leaseRoot, { recursive: true, force: true }); }
}, 30_000);
