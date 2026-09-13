import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import {
    lstat,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { SandboxExecutionError, type SandboxCommand, type PrivateTempLease } from "./contracts.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./private-temp.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService as createRuntimeService, type SandboxService } from "./service.ts";
import { createZeroboxBackend as createBackend } from "./zerobox-backend.ts";
import { candidateBackendOptions, hasCandidateRuntime, hostToolReadClosure } from "./integration-fixtures.ts";
import { PRIVATE_ANALYSIS_ROOT, PRIVATE_BASH, PRIVATE_SHELL_PATH } from "./shell-baseline.ts";

const fixtures: string[] = [];
const services: SandboxService[] = [];
let leaseDirectory: string;
let probeRoot: string;
let createdLeases: PrivateTempLease[];
const enabled = process.platform === "linux" && hasCandidateRuntime();

beforeEach(async () => {
    if (!enabled) return;
    createdLeases = [];
    leaseDirectory = await mkdtemp("/var/tmp/z-");
    probeRoot = await mkdtemp("/var/tmp/p-");
    fixtures.push(leaseDirectory, probeRoot);
});

function createZeroboxBackend() {
    return createBackend(candidateBackendOptions(probeRoot));
}

function createSandboxService(options: Parameters<typeof createRuntimeService>[0]) {
    return createRuntimeService({ ...options,
        createLease: async () => {
            const lease = await createPrivateTempLease({ rootDir: leaseDirectory });
            createdLeases.push(lease);
            return lease;
        },
        recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseDirectory }); },
    });
}

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceFixture(): Promise<string> {
    const fixture = await mkdtemp(
        "/var/tmp/pi-linux-",
    );
    fixtures.push(fixture);
    return fixture;
}

function collectExecution(
    operations: BashOperations,
    command: string,
    cwd: string,
    options: { timeout?: number } = {},
): Promise<{ exitCode: number | null; output: string }> {
    let output = "";
    return operations
        .exec(command, cwd, {
            timeout: options.timeout,
            onData: (chunk) => {
                output += chunk.toString();
            },
        })
        .then((result) => ({ exitCode: result.exitCode, output }));
}

function bashOperations(service: SandboxService, stdin?: string): BashOperations {
    return createBashOperations({
        stdin,
        detached: true,
        prepareSpawn: ({ command, cwd }) =>
            service.prepareBash({
                file: PRIVATE_BASH,
                args: ["-c", command],
                cwd,
            }),
    });
}

function listen(server: ReturnType<typeof createServer>, port = 0, host = "::") {
    return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host, ipv6Only: false }, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("server did not expose a TCP port"));
                return;
            }
            resolve(address.port);
        });
    });
}

function close(server: ReturnType<typeof createServer>) {
    (
        server as ReturnType<typeof createServer> & {
            closeAllConnections?: () => void;
        }
    ).closeAllConnections?.();
    return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe.skipIf(!enabled)("Pi Zerobox Linux contract", () => {
    it("enforces Bash filesystem, private environment, stdin, and process-tree limits", async () => {
        const cwd = await workspaceFixture();
        const ptraceProbe = "$p=fork(); if(!$p){sleep 2;exit}; $r=syscall(101,16,$p,0,0); kill 9,$p; wait; exit($r==0?0:1)";
        expect(Bun.spawnSync(["/usr/bin/perl", "-e", ptraceProbe]).exitCode).toBe(0);
        // These host tools are intentionally exposed only to prove that the
        // nested-kernel and ptrace failures come from Zerobox enforcement.
        const [perlRead, unshareRead, bwrapRead, nodeRead] = await Promise.all([
            hostToolReadClosure("/usr/bin/perl"),
            hostToolReadClosure("/usr/bin/unshare"),
            hostToolReadClosure("/usr/bin/bwrap"),
            hostToolReadClosure("/usr/bin/node"),
        ]);
        const sibling = await createPrivateTempLease({ rootDir: leaseDirectory });
        const hostTmp = join("/tmp", `pi-zbx-host-${process.pid}`);
        await writeFile(hostTmp, "host temp secret");
        await writeFile(join(cwd, ".env"), "protected");
        await writeFile(join(cwd, "replacement"), "replacement");
        await symlink(".env", join(cwd, "env-link"));
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: {
                    allowRead: [...perlRead, ...unshareRead, ...bwrapRead, ...nodeRead],
                    denyRead: [hostTmp],
                    allowWrite: ["."],
                    denyWrite: [".env"],
                },
                network: { allowedDomains: [], deniedDomains: [] },
            }),
        });
        services.push(service);
        try {
            await service.startBashSession(cwd);
            const operations = bashOperations(service, "stdin-exact");
            for (const command of [
                "/usr/bin/perl -e 'exit 0'",
                "/usr/bin/unshare --version >/dev/null",
                "/usr/bin/bwrap --version >/dev/null",
                "/usr/bin/node -e 'process.exit(0)'",
            ]) {
                expect((await collectExecution(bashOperations(service), command, cwd)).exitCode, command).toBe(0);
            }
            const allowed = await collectExecution(
                operations,
                "IFS= read -r value || true; printf '%s' \"$value\"; printf writable > allowed.txt",
                cwd,
            );
            expect(allowed).toEqual({ exitCode: 0, output: "stdin-exact" });
            expect(await readFile(join(cwd, "allowed.txt"), "utf8")).toBe("writable");

            for (const command of [
                "printf changed > .env",
                "printf changed > env-link",
                "mv replacement .env",
                `cat ${JSON.stringify(sibling.markerPath)}`,
                `ls ${JSON.stringify(probeRoot)}`,
                `cat ${JSON.stringify(hostTmp)}`,
                `cat /proc/1/root${hostTmp}`,
                `/usr/bin/unshare --user ${PRIVATE_SHELL_PATH}/true`,
                `/usr/bin/bwrap --ro-bind / / / ${PRIVATE_SHELL_PATH}/true`,
                `/usr/bin/perl -e '${ptraceProbe}'`,
            ]) {
                expect(
                    (await collectExecution(bashOperations(service), command, cwd))
                        .exitCode,
                    command,
                ).not.toBe(0);
            }
            expect(await readFile(join(cwd, ".env"), "utf8")).toBe("protected");

            const environment = await collectExecution(
                bashOperations(service),
                "/usr/bin/node -e 'process.stdout.write(JSON.stringify({HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,ZEROBOX_HOME:process.env.ZEROBOX_HOME,PATH:process.env.PATH}))'",
                cwd,
            );
            expect(environment.exitCode, environment.output).toBe(0);
            const parsed = JSON.parse(environment.output);
            expect(parsed.HOME).toBe("/home/sandbox");
            expect(parsed.TMPDIR).toBe("/tmp");
            expect(parsed.ZEROBOX_HOME).toBeUndefined();
            expect(parsed.PATH).not.toContain("/mnt/c");

        } finally {
            await sibling.dispose();
            await rm(hostTmp, { force: true });
        }
    }, 30_000);

    it("keeps lease control files immutable from Bash commands", async () => {
        const cwd = await workspaceFixture();
        const hostTarget = join("/tmp", `pi-zbx-profile-target-${process.pid}`);
        await writeFile(hostTarget, "protected");
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
            }),
        });
        services.push(service);
        try {
            await service.startBashSession(cwd);
            const replace = await collectExecution(
                bashOperations(service),
                `ln -sfn ${JSON.stringify(hostTarget)} "$DOCKER_CONFIG/../zerobox-home/profiles/bash-general.json"`,
                cwd,
            );
            expect(replace.exitCode).not.toBe(0);
            expect(
                await collectExecution(bashOperations(service), "true", cwd),
            ).toEqual({ exitCode: 0, output: "" });
            expect(await readFile(hostTarget, "utf8")).toBe("protected");
        } finally {
            await rm(hostTarget, { force: true });
        }
    }, 30_000);

    it("keeps leases created after child_started unreadable", async () => {
        const cwd = await workspaceFixture();
        const siblingRoot = join(
            leaseDirectory,
            "l-f0a1b2",
        );
        const siblingMarker = join(siblingRoot, ".pi-sandbox-lease.json");
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
            }),
        });
        services.push(service);
        await service.startBashSession(cwd);

        const execution = collectExecution(
            bashOperations(service),
            `printf ready > ready; while [ ! -f go ]; do sleep 0.01; done; cat ${JSON.stringify(siblingMarker)}`,
            cwd,
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await readFile(join(cwd, "ready"), "utf8").catch(() => "")) {
                break;
            }
            await Bun.sleep(10);
        }
        const sibling = await createPrivateTempLease({ rootDir: leaseDirectory, randomId: "f0a1b2" });
        try {
            await writeFile(join(cwd, "go"), "go");
            expect((await execution).exitCode).not.toBe(0);
        } finally {
            await sibling.dispose();
        }
    }, 30_000);

    it("enforces the analysis allowlist, private temp, env filtering, and no network", async () => {
        const project = await workspaceFixture();
        const projectSecret = join(project, "project-secret.txt");
        const hostTmp = join("/tmp", `pi-zbx-analysis-${process.pid}`);
        await writeFile(projectSecret, "project secret");
        await writeFile(hostTmp, "host temp secret");
        const sibling = await createPrivateTempLease({ rootDir: leaseDirectory });
        const unixPath = join(project, "host.sock");
        const unixServer = createServer(socket => socket.end("fixture"));
        await new Promise<void>(resolve => unixServer.listen(unixPath, resolve));
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({}),
        });
        services.push(service);

        const script = [
            "const fs = require('node:fs'); const net = require('node:net'); const dgram = require('node:dgram');",
            "const result = {};",
            "try { fs.writeFileSync(process.env.HOME + '/own.txt', 'ok'); result.ownWrite = 'allowed'; } catch { result.ownWrite = 'blocked'; }",
            `for (const [name,path] of Object.entries(${JSON.stringify({ project: projectSecret, hostTmp, sibling: sibling.markerPath })})) { try { fs.readFileSync(path); result[name] = 'exposed'; } catch { result[name] = 'blocked'; } }`,
            "result.env = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ZEROBOX_HOME: process.env.ZEROBOX_HOME, SECRET: process.env.PI_ZBX_SECRET };",
            "await new Promise((resolve) => { const socket = net.createConnection({host:'127.0.0.1',port:9}); socket.once('connect',()=>{result.tcp='exposed';socket.destroy();resolve();}); socket.once('error',()=>{result.tcp='blocked';resolve();}); });",
            "await new Promise((resolve) => { try { const server = net.createServer(); server.once('error',()=>{result.binding='blocked';resolve();}); server.listen(0,'127.0.0.1',()=>{result.binding='exposed';server.close(resolve);}); } catch { result.binding='blocked'; resolve(); } });",
            "await new Promise((resolve) => { let done=false; const finish=(value,socket)=>{if(done)return;done=true;result.udp=value;try{socket?.close();}catch{}resolve();}; try { const socket=dgram.createSocket('udp4'); socket.once('error',()=>finish('blocked',socket)); socket.send('x',9,'127.0.0.1',(error)=>finish(error?'blocked':'exposed',socket)); } catch { finish('blocked'); } });",
            `await new Promise((resolve) => { try { const socket = net.createConnection({path:${JSON.stringify(unixPath)}}); socket.once('connect',()=>{result.unix='exposed';socket.destroy();resolve();}); socket.once('error',()=>{result.unix='blocked';resolve();}); } catch { result.unix='blocked'; resolve(); } });`,
            "console.log(JSON.stringify(result));",
        ].join("\n");
        const command = {
            file: join(PRIVATE_ANALYSIS_ROOT, "bin/node"),
            args: [
                "--input-type=commonjs",
                "--eval",
                `(async()=>{${script}})().catch(error=>{console.error(error);process.exitCode=1})`,
            ],
            cwd: import.meta.dir,
        };
        process.env.PI_ZBX_SECRET = "must-not-pass";
        try {
            const handle = await service.prepareAnalysis(command, [
                import.meta.dir,
            ]);
            const operations = createBashOperations({
                detached: true,
                prepareSpawn: () => handle.spawn,
                afterClose: () => handle.dispose(),
            });
            const execution = await collectExecution(operations, "ignored", command.cwd);
            expect(execution.exitCode, execution.output).toBe(0);
            const result = JSON.parse(execution.output);
            expect(result).toMatchObject({
                ownWrite: "allowed",
                project: "blocked",
                hostTmp: "blocked",
                sibling: "blocked",
                tcp: "blocked",
                binding: "blocked",
                udp: "blocked",
                unix: "blocked",
            });
            expect(result.env.HOME).toBe("/home/sandbox");
            expect(result.env.TMPDIR).toBe("/tmp");
            expect(result.env.ZEROBOX_HOME).toBeUndefined();
            expect(result.env.SECRET).toBeUndefined();
        } finally {
            delete process.env.PI_ZBX_SECRET;
            await sibling.dispose();
            await close(unixServer);
            await rm(hostTmp, { force: true });
        }
    }, 30_000);

    it("applies the port-scoped loopback class and deny-by-default network", async () => {
        const cwd = await workspaceFixture();
        // curl is an explicit host test instrument. Its successful version
        // probe prevents ENOENT from being mistaken for network enforcement.
        const curlRead = await hostToolReadClosure("/usr/bin/curl");
        const allowedServer = createServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
        const deniedServer = createServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\ndenied"));
        const allowedPort = await listen(allowedServer);
        const deniedPort = await listen(deniedServer);
        const redirectServer = createServer((socket) =>
            socket.end(
                `HTTP/1.1 302 Found\r\nLocation: http://localhost:${deniedPort}\r\nContent-Length: 0\r\n\r\n`,
            ),
        );
        const redirectPort = await listen(redirectServer);
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowRead: curlRead, allowWrite: ["."] },
                network: {
                    allowedDomains: [
                        `localhost:${allowedPort}`,
                        `localhost:${redirectPort}`,
                    ],
                    deniedDomains: [],
                },
            }),
        });
        services.push(service);
        try {
            await service.startBashSession(cwd);
            expect((await collectExecution(bashOperations(service), "/usr/bin/curl --version >/dev/null", cwd)).exitCode).toBe(0);
            for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
                const result = await collectExecution(
                    bashOperations(service),
                    `/usr/bin/curl -fsS --max-time 5 http://${host}:${allowedPort}`,
                    cwd,
                );
                expect(result).toEqual({ exitCode: 0, output: "ok" });
            }
            expect(
                (
                    await collectExecution(
                        bashOperations(service),
                        `/usr/bin/curl -fsS --max-time 2 http://localhost:${deniedPort}`,
                        cwd,
                    )
                ).exitCode,
            ).not.toBe(0);
            expect(
                (
                    await collectExecution(
                        bashOperations(service),
                        `/usr/bin/curl -fsSL --max-time 2 http://localhost:${redirectPort}`,
                        cwd,
                    )
                ).exitCode,
            ).not.toBe(0);
        } finally {
            await Promise.all([
                close(allowedServer),
                close(deniedServer),
                close(redirectServer),
            ]);
        }
    }, 30_000);

    it("removes the private lease and managed-network artifacts after shutdown", async () => {
        const cwd = await workspaceFixture();
        const curlRead = [...await hostToolReadClosure("/usr/bin/curl"), "/etc/ssl/certs/ca-certificates.crt"];
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowRead: curlRead, allowWrite: ["."] },
                network: {
                    allowedDomains: ["example.com:443"],
                    deniedDomains: [],
                },
            }),
        });
        services.push(service);
        await service.startBashSession(cwd);
        const execution = await collectExecution(
            bashOperations(service),
            "printf '%s' \"$DOCKER_CONFIG\"; /usr/bin/curl -fsS --max-time 5 https://example.com >/dev/null",
            cwd,
        );
        expect(execution.exitCode, execution.output).toBe(0);
        expect(createdLeases).toHaveLength(1);
        const leaseRoot = createdLeases[0]!.root;

        await service.shutdown();
        services.splice(services.indexOf(service), 1);
        expect(await lstat(leaseRoot).catch(() => null)).toBeNull();

        const processReferences = await Promise.all(
            (await readdir("/proc", { withFileTypes: true }))
                .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
                .map((entry) =>
                    readFile(join("/proc", entry.name, "cmdline"), "utf8").catch(
                        () => "",
                    ),
                ),
        );
        expect(processReferences.some((command) => command.includes(leaseRoot))).toBe(
            false,
        );
    }, 30_000);

    it("enforces public-domain ports and deny precedence", async () => {
        expect(
            Bun.spawnSync([
                "/usr/bin/curl",
                "-fsS",
                "--max-time",
                "5",
                "https://example.com",
            ]).exitCode,
        ).toBe(0);
        const cwd = await workspaceFixture();
        const curlRead = [...await hostToolReadClosure("/usr/bin/curl"), "/etc/ssl/certs/ca-certificates.crt"];
        const allowed = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowRead: curlRead, allowWrite: ["."] },
                network: {
                    allowedDomains: ["example.com:443"],
                    deniedDomains: [],
                },
            }),
        });
        services.push(allowed);
        await allowed.startBashSession(cwd);
        expect((await collectExecution(bashOperations(allowed), "/usr/bin/curl --version >/dev/null", cwd)).exitCode).toBe(0);
        expect(
            await collectExecution(
                bashOperations(allowed),
                "/usr/bin/curl -fsS --max-time 5 https://example.com >/dev/null",
                cwd,
            ),
        ).toEqual({ exitCode: 0, output: "" });
        expect(
            (
                await collectExecution(
                    bashOperations(allowed),
                    "/usr/bin/curl -fsS --max-time 2 http://example.com >/dev/null",
                    cwd,
                )
            ).exitCode,
        ).not.toBe(0);

        const denied = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowRead: curlRead, allowWrite: ["."] },
                network: {
                    allowedDomains: ["example.com:443"],
                    deniedDomains: ["example.com:443"],
                },
            }),
        });
        services.push(denied);
        await denied.startBashSession(cwd);
        expect(
            (
                await collectExecution(
                    bashOperations(denied),
                    "/usr/bin/curl -fsS --max-time 2 https://example.com >/dev/null",
                    cwd,
                )
            ).exitCode,
        ).not.toBe(0);
    }, 30_000);

    it("blocks DNS-to-private, direct IP, UDP, and host Unix sockets", async () => {
        const cwd = await workspaceFixture();
        // Node and curl exercise Unix/TCP/UDP paths that the public runtime
        // deliberately omits. Grant only their inspected executable closures.
        const [curlRead, nodeRead] = await Promise.all([
            hostToolReadClosure("/usr/bin/curl"),
            hostToolReadClosure("/usr/bin/node"),
        ]);
        const openSockets = new Set<Socket>();
        const respond = (socket: Socket): void => {
            openSockets.add(socket);
            socket.once("close", () => openSockets.delete(socket));
            socket.end(
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            );
        };
        const tcpServer = createServer(respond);
        const tcpPort = await listen(tcpServer);
        const localtestAddresses = await lookup("localtest.me", { all: true });
        expect(
            localtestAddresses.some(
                ({ address }) => address === "127.0.0.1" || address === "::1",
            ),
        ).toBe(true);
        expect(
            await (
                await fetch(`http://localtest.me:${tcpPort}`)
            ).text(),
        ).toBe("ok");
        const unixPath = join(cwd, "host.sock");
        const unixServer = createServer(respond);
        await new Promise<void>((resolve, reject) => {
            unixServer.once("error", reject);
            unixServer.listen(unixPath, resolve);
        });
        const hostUnix = await new Promise<string>((resolve, reject) => {
            const socket = Bun.connect({
                unix: unixPath,
                socket: {
                    data(_socket, data) {
                        resolve(data.toString());
                    },
                    error(_socket, error) {
                        reject(error);
                    },
                },
            });
            void socket;
        });
        expect(hostUnix).toContain("200 OK");
        const udp4 = createSocket("udp4");
        const udp6 = createSocket("udp6");
        await Promise.all([
            new Promise<void>(resolve => udp4.bind(0, "127.0.0.1", resolve)),
            new Promise<void>(resolve => udp6.bind(0, "::1", resolve)),
        ]);
        const udpProbe = (family: "udp4" | "udp6", address: string) =>
            `const d=require('node:dgram');const t=setTimeout(()=>process.exit(43),2000);try{const s=d.createSocket('${family}');s.once('error',()=>{clearTimeout(t);s.close();process.exit(0)});s.send('x',${family === "udp4" ? udp4.address().port : udp6.address().port},'${address}',e=>{clearTimeout(t);s.close();process.exit(e?0:42)})}catch{clearTimeout(t);process.exit(0)}`;
        for (const [family, address] of [
            ["udp4", "127.0.0.1"],
            ["udp6", "::1"],
        ] as const) {
            expect(
                Bun.spawnSync(["/usr/bin/node", "-e", udpProbe(family, address)])
                    .exitCode,
                `${family} host precondition`,
            ).toBe(42);
        }
        const bindingProbe =
            "const n=require('node:net');const s=n.createServer();s.once('error',()=>process.exit(0));setTimeout(()=>process.exit(43),2000);s.listen(0,'127.0.0.1',()=>process.exit(42))";
        expect(
            Bun.spawnSync(["/usr/bin/node", "-e", bindingProbe]).exitCode,
            "host TCP binding precondition",
        ).toBe(42);

        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowRead: [...curlRead, ...nodeRead], allowWrite: ["."] },
                network: {
                    allowedDomains: [`localtest.me:${tcpPort}`],
                    deniedDomains: [],
                },
            }),
        });
        services.push(service);
        try {
            await service.startBashSession(cwd);
            for (const command of ["/usr/bin/curl --version >/dev/null", "/usr/bin/node -e 'process.exit(0)'"]) {
                expect((await collectExecution(bashOperations(service), command, cwd)).exitCode, command).toBe(0);
            }
            for (const command of [
                `/usr/bin/curl -fsS --max-time 2 http://localtest.me:${tcpPort}`,
                `/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:${tcpPort}`,
                `/usr/bin/node -e \"const n=require('node:net');const s=n.createConnection(${JSON.stringify(unixPath)});s.once('connect',()=>process.exit(0));s.once('error',()=>process.exit(1))\"`,
            ]) {
                expect(
                    (await collectExecution(bashOperations(service), command, cwd))
                        .exitCode,
                    command,
                ).not.toBe(0);
            }
            for (const [family, address] of [
                ["udp4", "127.0.0.1"],
                ["udp6", "::1"],
            ] as const) {
                const udpResult = await collectExecution(
                    bashOperations(service),
                    `/usr/bin/node -e ${JSON.stringify(udpProbe(family, address))}`,
                    cwd,
                );
                expect(
                    udpResult.exitCode,
                    `${family} must be rejected by seccomp: ${udpResult.output}`,
                ).toBe(0);
            }
            expect(
                (
                    await collectExecution(
                        bashOperations(service),
                        `/usr/bin/node -e ${JSON.stringify(bindingProbe)}`,
                        cwd,
                    )
                ).exitCode,
                "local test listeners must work inside the private network namespace",
            ).toBe(42);
            const controlSecret = join(createdLeases[0]!.zeroboxHome, "control-secret");
            await writeFile(controlSecret, "fixture control secret");
            const bridgeReadOnly = await collectExecution(
                bashOperations(service),
                `bridge=${JSON.stringify(createdLeases[0]!.proxyRunsDir)}; test ! -e "$bridge" && test -d /dev/.zerobox-proxy && ! touch /dev/.zerobox-proxy/target-write && ! cat ${JSON.stringify(controlSecret)}`,
                cwd,
            );
            expect(bridgeReadOnly.exitCode, bridgeReadOnly.output).toBe(0);
            expect(await readFile(controlSecret, "utf8")).toBe("fixture control secret");
        } finally {
            for (const socket of openSockets) socket.destroy();
            udp4.close();
            udp6.close();
            await Promise.all([close(tcpServer), close(unixServer)]);
        }
    }, 30_000);

    it("terminates the Bash process tree on timeout and keeps the shared service usable", async () => {
        const cwd = await workspaceFixture();
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
            }),
        });
        services.push(service);
        await service.startBashSession(cwd);

        const controller = new AbortController();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let ready = false;
        const timeoutExecution = bashOperations(service).exec(
            "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; printf READY; wait", cwd,
            { signal: controller.signal, timeout: 10, onData: chunk => {
                if (!ready && chunk.toString().includes("READY")) {
                    ready = true;
                    deadline = setTimeout(() => controller.abort(), 200);
                }
            } },
        );
        try { await expect(timeoutExecution).rejects.toThrow(/abort/i); }
        finally { if (deadline) clearTimeout(deadline); }
        expect(ready).toBe(true);
        const childPid = Number(await readFile(join(cwd, "child.pid"), "utf8"));
        await Bun.sleep(50);
        expect(() => process.kill(childPid, 0)).toThrow();
        expect(
            await collectExecution(bashOperations(service), "printf recovered", cwd),
        ).toEqual({ exitCode: 0, output: "recovered" });
    }, 30_000);

    it("distinguishes setup failure from target exit 125 and blocks nested kernels in analysis", async () => {
        const cwd = await workspaceFixture();
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({}),
        });
        services.push(service);

        const runAnalysisCommand = async (command: SandboxCommand, readable: string[] = []) => {
            const handle = await service.prepareAnalysis(command, [
                cwd,
                ...readable,
            ]);
            const operations = createBashOperations({
                detached: true,
                prepareSpawn: () => handle.spawn,
                afterClose: () => handle.dispose(),
            });
            return collectExecution(operations, "ignored", command.cwd);
        };

        const target125 = await runAnalysisCommand({
            file: PRIVATE_BASH,
            args: ["-c", "exit 125"],
            cwd,
        });
        expect(target125.exitCode).toBe(125);

        let setupFailure: unknown;
        try {
            await runAnalysisCommand({
                file: "/definitely/missing/pi-zbx-target",
                args: [],
                cwd,
            });
        } catch (error) {
            setupFailure = error;
        }
        expect(setupFailure).toBeInstanceOf(SandboxExecutionError);
        expect((setupFailure as SandboxExecutionError).code).toBe("setup-failed");

        const [unshareRead, bwrapRead, mountRead] = await Promise.all([
            hostToolReadClosure("/usr/bin/unshare"),
            hostToolReadClosure("/usr/bin/bwrap"),
            hostToolReadClosure("/usr/bin/mount"),
        ]);
        for (const command of [
            { file: "/usr/bin/unshare", args: ["--user", PRIVATE_SHELL_PATH + "/true"], cwd, readable: unshareRead },
            { file: "/usr/bin/bwrap", args: ["--ro-bind", "/", "/", PRIVATE_SHELL_PATH + "/true"], cwd, readable: bwrapRead },
            { file: "/usr/bin/mount", args: ["-t", "tmpfs", "tmpfs", "/tmp"], cwd, readable: mountRead },
        ]) {
            const preflight = await runAnalysisCommand({ ...command, args: ["--version"] }, command.readable);
            expect(preflight.exitCode, `${command.file} must execute before its sandbox denial is asserted`).toBe(0);
            expect((await runAnalysisCommand(command, command.readable)).exitCode).not.toBe(0);
        }
    }, 30_000);
});
