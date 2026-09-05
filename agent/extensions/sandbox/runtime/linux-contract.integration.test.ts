import { afterEach, describe, expect, it } from "bun:test";
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
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { SandboxExecutionError, type SandboxCommand } from "./contracts.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService, type SandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

const fixtures: string[] = [];
const services: SandboxService[] = [];

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceFixture(): Promise<string> {
    const fixture = await mkdtemp(
        join(import.meta.dir, "../../../.zbx-linux-"),
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
                file: "/bin/bash",
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

describe("Pi Zerobox Linux contract", () => {
    it("enforces Bash filesystem, private environment, stdin, and process-tree limits", async () => {
        const cwd = await workspaceFixture();
        const ptraceProbe = "$p=fork(); if(!$p){sleep 2;exit}; $r=syscall(101,16,$p,0,0); kill 9,$p; wait; exit($r==0?0:1)";
        expect(Bun.spawnSync(["/usr/bin/perl", "-e", ptraceProbe]).exitCode).toBe(0);
        const sibling = await createPrivateTempLease();
        const hostTmp = join("/tmp", `pi-zbx-host-${process.pid}`);
        await writeFile(hostTmp, "host temp secret");
        await writeFile(join(cwd, ".env"), "protected");
        await writeFile(join(cwd, "replacement"), "replacement");
        await symlink(".env", join(cwd, "env-link"));
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: {
                    denyRead: ["~/.ssh", "~/.gnupg"],
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
                `cat ${JSON.stringify(hostTmp)}`,
                `cat ${JSON.stringify(sibling.markerPath)}`,
                "ls /mnt/c",
                `cat /proc/1/root${hostTmp}`,
                "unshare --user /bin/true",
                "bwrap --ro-bind / / /bin/true",
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
            expect(parsed.HOME).toMatch(/^\/home\/[^/]+\/\.pi\/zbx\/l-[a-f0-9]{6}\/home$/);
            expect(parsed.TMPDIR).toBe(parsed.HOME.replace(/\/home$/, "/tmp"));
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
                `ln -sfn ${JSON.stringify(hostTarget)} "$HOME/../zerobox-home/profiles/bash-general.json"`,
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
            homedir(),
            ".pi",
            "zbx",
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
        const sibling = await createPrivateTempLease({ randomId: "f0a1b2" });
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
        const sibling = await createPrivateTempLease();
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
            `await new Promise((resolve) => { try { const socket = net.createConnection({path:${JSON.stringify(`/run/user/${process.getuid?.() ?? 1000}/bus`)}}); socket.once('connect',()=>{result.unix='exposed';socket.destroy();resolve();}); socket.once('error',()=>{result.unix='blocked';resolve();}); } catch { result.unix='blocked'; resolve(); } });`,
            "console.log(JSON.stringify(result));",
        ].join("\n");
        const command = {
            file: "/usr/bin/node",
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
                "/usr/bin/node",
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
            expect(result.env.HOME).toMatch(/^\/home\/[^/]+\/\.pi\/zbx\/l-[a-f0-9]{6}\/home$/);
            expect(result.env.TMPDIR).toBe(result.env.HOME.replace(/\/home$/, "/tmp"));
            expect(result.env.ZEROBOX_HOME).toBeUndefined();
            expect(result.env.SECRET).toBeUndefined();
        } finally {
            delete process.env.PI_ZBX_SECRET;
            await sibling.dispose();
            await rm(hostTmp, { force: true });
        }
    }, 30_000);

    it("applies the port-scoped loopback class and deny-by-default network", async () => {
        const cwd = await workspaceFixture();
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
                filesystem: { allowWrite: ["."] },
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
            for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
                const result = await collectExecution(
                    bashOperations(service),
                    `curl -fsS --max-time 5 http://${host}:${allowedPort}`,
                    cwd,
                );
                expect(result).toEqual({ exitCode: 0, output: "ok" });
            }
            expect(
                (
                    await collectExecution(
                        bashOperations(service),
                        `curl -fsS --max-time 2 http://localhost:${deniedPort}`,
                        cwd,
                    )
                ).exitCode,
            ).not.toBe(0);
            expect(
                (
                    await collectExecution(
                        bashOperations(service),
                        `curl -fsSL --max-time 2 http://localhost:${redirectPort}`,
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
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
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
            "printf '%s' \"$HOME\"; curl -fsS --max-time 5 https://example.com >/dev/null",
            cwd,
        );
        expect(execution.exitCode, execution.output).toBe(0);
        const leaseRoot = dirname(execution.output);

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
        const allowed = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
                network: {
                    allowedDomains: ["example.com:443"],
                    deniedDomains: [],
                },
            }),
        });
        services.push(allowed);
        await allowed.startBashSession(cwd);
        expect(
            await collectExecution(
                bashOperations(allowed),
                "curl -fsS --max-time 5 https://example.com >/dev/null",
                cwd,
            ),
        ).toEqual({ exitCode: 0, output: "" });
        expect(
            (
                await collectExecution(
                    bashOperations(allowed),
                    "curl -fsS --max-time 2 http://example.com >/dev/null",
                    cwd,
                )
            ).exitCode,
        ).not.toBe(0);

        const denied = createSandboxService({
            backend: createZeroboxBackend(),
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
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
                    "curl -fsS --max-time 2 https://example.com >/dev/null",
                    cwd,
                )
            ).exitCode,
        ).not.toBe(0);
    }, 30_000);

    it("blocks DNS-to-private, direct IP, UDP, and host Unix sockets", async () => {
        const cwd = await workspaceFixture();
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
        const udpProbe = (family: "udp4" | "udp6", address: string) =>
            `const d=require('node:dgram');const t=setTimeout(()=>process.exit(43),2000);try{const s=d.createSocket('${family}');s.once('error',()=>{clearTimeout(t);s.close();process.exit(0)});s.send('x',9,'${address}',e=>{clearTimeout(t);s.close();process.exit(e?0:42)})}catch{clearTimeout(t);process.exit(0)}`;
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
                filesystem: { allowWrite: ["."] },
                network: {
                    allowedDomains: [`localtest.me:${tcpPort}`],
                    deniedDomains: [],
                },
            }),
        });
        services.push(service);
        try {
            await service.startBashSession(cwd);
            for (const command of [
                `curl -fsS --max-time 2 http://localtest.me:${tcpPort}`,
                `curl -fsS --max-time 2 http://127.0.0.1:${tcpPort}`,
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
                "ProxyRouted must reject inbound TCP binding",
            ).toBe(0);
            const bridgeReadOnly = await collectExecution(
                bashOperations(service),
                `bridge="$HOME/../zerobox-home/tmp/runs"; test -d "$bridge" && test -r "$bridge" && ! touch "$bridge/target-write"`,
                cwd,
            );
            expect(bridgeReadOnly.exitCode, bridgeReadOnly.output).toBe(0);
        } finally {
            for (const socket of openSockets) socket.destroy();
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

        const timeoutExecution = collectExecution(
            bashOperations(service),
            "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; wait",
            cwd,
            { timeout: 0.2 },
        );
        await expect(timeoutExecution).rejects.toThrow("timeout:0.2");
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

        const runAnalysisCommand = async (command: SandboxCommand) => {
            const handle = await service.prepareAnalysis(command, [
                "/bin",
                "/lib",
                "/lib64",
                "/usr",
            ]);
            const operations = createBashOperations({
                detached: true,
                prepareSpawn: () => handle.spawn,
                afterClose: () => handle.dispose(),
            });
            return collectExecution(operations, "ignored", command.cwd);
        };

        const target125 = await runAnalysisCommand({
            file: "/bin/sh",
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

        for (const command of [
            { file: "/usr/bin/unshare", args: ["--user", "/bin/true"], cwd },
            { file: "/usr/bin/bwrap", args: ["--ro-bind", "/", "/", "/bin/true"], cwd },
            { file: "/usr/bin/mount", args: ["-t", "tmpfs", "tmpfs", "/tmp"], cwd },
        ]) {
            expect((await runAnalysisCommand(command)).exitCode).not.toBe(0);
        }
    }, 30_000);
});
