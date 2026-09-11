import { expect, spyOn, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { localMachineId } from "./capabilities/authority.ts";
import { currentShellPolicy } from "./capabilities/runtime.ts";

const enabled = process.platform === "linux" &&
    process.env.PI_SANDBOX_LOCAL_RESOURCES_CONTRACT === "1";

type PiSession = Awaited<ReturnType<typeof createTestSession>>;
type BashResult = Awaited<ReturnType<PiSession["session"]["executeBash"]>>;

function quote(value: string): string {
    return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function listen(server: Server, address: string | number): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        const ready = () => {
            server.off("error", reject);
            resolvePromise();
        };
        if (typeof address === "number") server.listen(address, "127.0.0.1", ready);
        else server.listen(address, ready);
    });
}

async function closeServer(server: Server, connections: Set<Socket>): Promise<void> {
    for (const connection of connections) connection.destroy();
    if (server.listening) await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
    });
}

function portOf(server: Server): number {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP listener address");
    return address.port;
}

async function freePort(): Promise<number> {
    const reservation = createServer();
    try {
        await listen(reservation, 0);
        return portOf(reservation);
    } finally {
        await closeServer(reservation, new Set());
    }
}

async function exchange(port: number, request: string): Promise<string> {
    return new Promise<string>((resolvePromise, reject) => {
        const client = createConnection({ host: "127.0.0.1", port });
        let output = "";
        client.setTimeout(1_500, () => client.destroy(new Error(`Fixture exchange timeout; received ${JSON.stringify(output)}`)));
        client.once("connect", () => client.write(request));
        client.on("data", (chunk) => {
            output += chunk.toString();
            const newline = output.indexOf("\n");
            if (newline !== -1) {
                resolvePromise(output.slice(0, newline));
                client.destroy();
            }
        });
        client.once("error", reject);
        client.once("end", () => resolvePromise(output));
        client.once("close", () => client.destroy());
    });
}

async function publishedPing(port: number): Promise<string> {
    const deadline = Date.now() + 8_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return await exchange(port, "ping");
        } catch (error) {
            lastError = error;
            await delay(40);
        }
    }
    throw new Error("TCP publication never became reachable", { cause: lastError });
}

async function fixture() {
    const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
    const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
    if (!binaryPath || !binarySha256) throw new Error("Explicit Zerobox binary and SHA256 are required");
    const root = await mkdtemp("/var/tmp/pi-res-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const analysisRequests: string[] = [];
    const registryKey = `pi.test.local-resources.analysis:${root}`;
    const registrySymbol = Symbol.for(registryKey);
    Object.defineProperty(globalThis, registrySymbol, { value: analysisRequests, configurable: true });
    const errors = spyOn(ExtensionRunner.prototype, "emitError");
    let session: PiSession | undefined;
    const pending = new Set<Promise<BashResult>>();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { mode: 0o700 });
    const projectConfig = join(cwd, ".pi/sandbox.json");
    return {
        root, cwd, projectConfig,
        async start(resources: object) {
            await writeFile(join(agentDir, "sandbox.json"), JSON.stringify({
                version: 2, machineId: localMachineId(), resources,
            }), { mode: 0o600 });
            await writeFile(projectConfig, "{}", { mode: 0o600 });
            const sandboxSource = await realpath(resolve(import.meta.dir, "index.ts"));
            const bashSource = await realpath(resolve(import.meta.dir, "../bash-execution/index.ts"));
            expect(sandboxSource).toBe(resolve(import.meta.dir, "index.ts"));
            expect(bashSource).toBe(resolve(import.meta.dir, "../bash-execution/index.ts"));
            const entrypoint = join(agentDir, "sandbox-entrypoint.ts");
            await writeFile(entrypoint, [
                `import { createSandboxExtension } from ${JSON.stringify(sandboxSource)};`,
                `import { createPrivateTempLease, recoverStalePrivateTempLeases } from ${JSON.stringify(resolve(import.meta.dir, "runtime/private-temp.ts"))};`,
                "export default (pi) => createSandboxExtension(pi, {",
                `zeroboxBackend: ${JSON.stringify({ binaryPath, expectedProvenance: {
                    version: "0.3.3-fork.17", binarySha256,
                }, probeRoot: join(root, "probe") })},`,
                "sandboxServiceOptions: {",
                `createLease: () => createPrivateTempLease({ rootDir: ${JSON.stringify(leaseRoot)} }),`,
                `recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: ${JSON.stringify(leaseRoot)} }); },`,
                "},",
                // Analysis is outside this transport contract and must not spawn
                // its independent host process or touch a personal lease root.
                "analysisServiceOptions: { runHost: async (request) => {",
                "if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request');",
                `globalThis[Symbol.for(${JSON.stringify(registryKey)})].push(request.id);`,
                "return { output: '1', stderr: '', runtime: request.worker, durationMs: 0, truncated: false };",
                "} },",
                "});",
            ].join("\n"));
            process.chdir(cwd);
            process.env.PI_CODING_AGENT_DIR = agentDir;
            session = await createTestSession({ cwd, extensions: [entrypoint, bashSource] });
            expect(currentShellPolicy()).toMatchObject({ mode: "sandbox", profile: "custom", state: "ready" });
        },
        async run(command: string, onChunk?: (chunk: string) => void) {
            if (!session) throw new Error("Fixture session was not started");
            const event = await session.session.extensionRunner.emitUserBash({
                type: "user_bash", command, cwd, excludeFromContext: false,
            });
            expect(event?.operations).toBeDefined();
            const execution = session.session.executeBash(command, onChunk, { operations: event?.operations });
            pending.add(execution);
            try { return await execution; }
            finally { pending.delete(execution); }
        },
        abort() { session?.session.abortBash(); },
        receipts() {
            return session?.session.sessionManager.getBranch().filter(
                (entry) => entry.type === "custom" && entry.customType === "pi.execution.user-bash.v1",
            ) ?? [];
        },
        async dispose() {
            try {
                session?.session.abortBash();
                await Promise.allSettled(pending);
                await session?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            } finally {
                session?.dispose();
                process.chdir(previousCwd);
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
                Reflect.deleteProperty(globalThis, registrySymbol);
                const extensionErrors = errors.mock.calls.map(([error]) => error);
                errors.mockRestore();
                await rm(root, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
                expect(extensionErrors).toEqual([]);
                expect(analysisRequests).toContain("sandbox-preflight-typescript");
                expect(analysisRequests).toContain("sandbox-preflight-python");
            }
        },
    };
}

const UNIX_CLIENT = `const net = require('node:net');
const client = net.createConnection(process.argv[2]);
client.setTimeout(800, () => client.destroy(new Error('client timeout')));
client.once('connect', () => client.write('ping'));
client.on('data', chunk => process.stdout.write(chunk));
client.once('error', error => { process.stderr.write(error.code || error.message); process.exitCode = 23; });
`;

test.skipIf(!enabled)("real Pi inherits an exact Unix socket and closes the next admission when project resources are empty", async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const exchanges: string[] = [];
    const neighbourExchanges: string[] = [];
    const server = createServer((socket) => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket));
        socket.once("data", (chunk) => { exchanges.push(chunk.toString()); socket.end("pong"); });
    });
    const neighbour = createServer((socket) => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket));
        socket.once("data", (chunk) => { neighbourExchanges.push(chunk.toString()); socket.end("neighbour"); });
    });
    try {
        const serviceDirectory = join(f.root, "services");
        await mkdir(serviceDirectory, { mode: 0o700 });
        const allowedSocket = join(serviceDirectory, "allowed.sock");
        const neighbourSocket = join(serviceDirectory, "neighbour.sock");
        await writeFile(join(serviceDirectory, "private.txt"), "host-private");
        await writeFile(join(f.cwd, "unix-client.cjs"), UNIX_CLIENT);
        await listen(server, allowedSocket);
        await listen(neighbour, neighbourSocket);
        await f.start({ unixSockets: [allowedSocket] });
        const command = `/usr/bin/node unix-client.cjs ${quote(allowedSocket)}`;
        const admitted = await f.run(command);
        expect(admitted.exitCode, admitted.output).toBe(0);
        expect(admitted.output).toBe("pong");
        expect(exchanges).toEqual(["ping"]);
        const denied = await f.run(`/usr/bin/node unix-client.cjs ${quote(neighbourSocket)}`);
        expect(denied.exitCode, denied.output).toBe(23);
        expect(neighbourExchanges).toEqual([]);
        expect((await f.run(`cat ${quote(join(serviceDirectory, "private.txt"))}`)).exitCode).not.toBe(0);
        await writeFile(f.projectConfig, JSON.stringify({ resources: { unixSockets: [] } }));
        const removed = await f.run(command);
        expect(removed.exitCode, removed.output).toBe(23);
        expect(exchanges).toEqual(["ping"]);
        expect(f.receipts()[0]).toMatchObject({ data: { command, execution: {
            status: "sandboxed", backend: "zerobox", mode: "sandbox", shellProfile: "custom", exitCode: 0,
        } } });
    } finally {
        try { await f.dispose(); }
        finally { await closeServer(server, sockets); await closeServer(neighbour, sockets); }
    }
}, 45_000);

const TCP_SERVER = `const net = require('node:net');
const sockets = new Set();
const server = net.createServer(socket => {
  process.stdout.write('accepted\\n');
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.setTimeout(1000, () => socket.destroy());
  socket.once('data', data => {
    process.stdout.write('received:' + data.toString() + '\\n');
    if (data.toString() === 'stop') socket.end('stopped\\n', () => server.close());
    else socket.end(data.toString() === 'ping' ? 'pong\\n' : 'unexpected\\n');
  });
});
const watchdog = setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(); process.exitCode = 29; }, 15000);
server.once('close', () => clearTimeout(watchdog));
server.once('error', error => { process.stderr.write(error.message); clearTimeout(watchdog); process.exitCode = 27; });
server.listen(Number(process.argv[2]), '127.0.0.1', () => {
  process.stdout.write('ready\\n');
  const outgoing = net.createConnection({ host: '127.0.0.1', port: Number(process.argv[3]) });
  outgoing.setTimeout(500, () => outgoing.destroy(new Error('blocked timeout')));
  outgoing.once('connect', () => { process.stdout.write('outbound-connected\\n'); outgoing.end('forbidden'); });
  outgoing.once('error', () => process.stdout.write('outbound-blocked\\n'));
});
`;

test.skipIf(!enabled)("real Pi publishes a private TCP listener lazily without granting outbound traffic or future removed publications", async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const outboundConnections: Socket[] = [];
    const outbound = createServer((socket) => {
        sockets.add(socket); outboundConnections.push(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.resume();
    });
    try {
        await listen(outbound, 0);
        const listenPort = await freePort();
        const targetPort = await freePort();
        expect(targetPort).not.toBe(listenPort);
        await writeFile(join(f.cwd, "server.cjs"), TCP_SERVER);
        await f.start({ tcpPublications: [{
            transport: "tcp", scope: "host", listen: `127.0.0.1:${listenPort}`, target: `127.0.0.1:${targetPort}`,
        }] });
        // Declaring a resource alone must not reserve its host port.
        const firstPwd = await f.run("pwd");
        expect(firstPwd.exitCode, firstPwd.output).toBe(0);
        await expect(exchange(listenPort, "ping")).rejects.toThrow();
        const command = `/usr/bin/node server.cjs ${targetPort} ${portOf(outbound)}`;
        let serverOutput = "";
        const serving = f.run(command, (chunk) => { serverOutput += chunk; });
        const firstPing = await Promise.race([
            publishedPing(listenPort),
            serving.then((result) => {
                throw new Error(`Server exited before host ping: ${JSON.stringify(result)}`);
            }),
        ]).catch((error) => {
            throw new Error(`Publication failed; private server output: ${serverOutput}`, { cause: error });
        });
        expect(firstPing).toBe("pong");
        const concurrentPwd = await f.run("pwd");
        expect(concurrentPwd.exitCode, concurrentPwd.output).toBe(0);
        expect(concurrentPwd.output.trim()).toBe(f.cwd);
        expect(await exchange(listenPort, "ping")).toBe("pong");
        expect(await exchange(listenPort, "stop")).toBe("stopped");
        const completed = await serving;
        expect(completed.exitCode, completed.output).toBe(0);
        expect(serverOutput).toContain("outbound-blocked");
        expect(serverOutput).not.toContain("outbound-connected");
        expect(outboundConnections).toHaveLength(0);
        await expect(exchange(listenPort, "ping")).rejects.toThrow();

        // This checks the next admission after completion, not revocation of an
        // existing listener or the lifetime of previously admitted connections.
        await writeFile(f.projectConfig, JSON.stringify({ resources: { tcpPublications: [] } }));
        let removedOutput = "";
        let removedFailure: unknown;
        const unexposed = f.run(command, (chunk) => { removedOutput += chunk; });
        void unexposed.catch((error) => { removedFailure = error; });
        const deadline = Date.now() + 5_000;
        while (!removedOutput.includes("ready") && Date.now() < deadline) await delay(40);
        expect(removedFailure).toBeUndefined();
        expect(removedOutput).toContain("ready");
        await expect(exchange(listenPort, "ping")).rejects.toThrow();
        f.abort();
        expect((await unexposed).cancelled).toBe(true);
        expect(f.receipts()).toEqual(expect.arrayContaining([
            expect.objectContaining({ data: expect.objectContaining({ command, execution: expect.objectContaining({
                status: "sandboxed", backend: "zerobox", mode: "sandbox", shellProfile: "custom", exitCode: 0,
            }) }) }),
        ]));
    } finally {
        try { await f.dispose(); }
        finally { await closeServer(outbound, sockets); }
    }
}, 60_000);

// Keep each target alive for much longer than the revocation bound so natural
// exit cannot make a missing revocation mechanism pass.
const REVOCATION_BOUND_MS = 8_000;

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function tcpIsOpen(port: number): Promise<boolean> {
    return new Promise<boolean>((resolvePromise) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const finish = (open: boolean) => { socket.destroy(); resolvePromise(open); };
        socket.setTimeout(250, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
    });
}

function requestLine(socket: Socket, request: string): Promise<string> {
    return new Promise<string>((resolvePromise, reject) => {
        let output = "";
        const timer = setTimeout(() => finish(new Error(`No framed reply to ${request}`)), 1_500);
        function finish(error?: Error, line?: string) {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
            if (error) reject(error);
            else resolvePromise(line ?? "");
        }
        function onData(chunk: Buffer) {
            output += chunk.toString();
            const end = output.indexOf("\n");
            if (end !== -1) finish(undefined, output.slice(0, end));
        }
        function onError(error: Error) { finish(error); }
        function onClose() { finish(new Error("Connection closed before reply")); }
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
        socket.write(`${request}\n`);
    });
}

const HELD_TCP_SERVER = `const net = require('node:net');
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.on('error', error => process.stderr.write(error.message));
  let input = '';
  socket.on('data', chunk => {
    input += chunk.toString();
    let end;
    while ((end = input.indexOf('\\n')) !== -1) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      socket.write('pong:' + line + '\\n');
    }
  });
});
const watchdog = setTimeout(() => {
  for (const socket of sockets) socket.destroy(); server.close(); process.exitCode = 29;
}, 30000);
server.once('close', () => clearTimeout(watchdog));
server.once('error', error => { process.stderr.write(error.message); clearTimeout(watchdog); process.exitCode = 27; });
server.listen(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('ready\\n'));
`;

test.skipIf(!enabled)("live TCP revocation closes the listener and held connection within eight seconds", async () => {
    const f = await fixture();
    let held: Socket | undefined;
    let targetDone = false;
    let targetFailure: unknown;
    let targetResult: BashResult | undefined;
    const connectionErrors: string[] = [];
    let connectionClosed = false;
    try {
        const listenPort = await freePort();
        const targetPort = await freePort();
        expect(targetPort).not.toBe(listenPort);
        await writeFile(join(f.cwd, "held-server.cjs"), HELD_TCP_SERVER);
        await f.start({ tcpPublications: [{
            transport: "tcp", scope: "host", listen: `127.0.0.1:${listenPort}`, target: `127.0.0.1:${targetPort}`,
        }] });
        let output = "";
        const target = f.run(`/usr/bin/node held-server.cjs ${targetPort}`, (chunk) => { output += chunk; });
        void target.then(
            (result) => { targetResult = result; targetDone = true; },
            (error) => { targetFailure = error; targetDone = true; },
        );
        const startupDeadline = Date.now() + 8_000;
        while (!(await tcpIsOpen(listenPort)) && Date.now() < startupDeadline && !targetDone) await delay(40);
        expect(targetDone, `${output}; ${String(targetFailure)}`).toBe(false);
        held = createConnection({ host: "127.0.0.1", port: listenPort });
        held.on("error", (error) => connectionErrors.push(error.message));
        held.once("close", () => { connectionClosed = true; });
        // The target deliberately keeps this connection alive after replying.
        expect(await requestLine(held, "before-revocation")).toBe("pong:before-revocation");
        expect(connectionClosed).toBe(false);
        expect(targetDone).toBe(false);

        const started = Date.now();
        await writeFile(f.projectConfig, JSON.stringify({ resources: { tcpPublications: [] } }));
        const admission = await bounded(f.run("pwd"), REVOCATION_BOUND_MS, "Policy refresh admission");
        expect(admission.exitCode, admission.output).toBe(0);
        expect(admission.output.trim()).toBe(f.cwd);
        expect(currentShellPolicy()).toMatchObject({ mode: "sandbox", profile: "default", state: "ready" });
        let listenerOpen = true;
        while (Date.now() - started < REVOCATION_BOUND_MS) {
            listenerOpen = await tcpIsOpen(listenPort);
            if (!listenerOpen && connectionClosed && targetDone) break;
            await delay(40);
        }
        const evidence = {
            listenerOpen, connectionClosed, targetDone,
            elapsedMs: Date.now() - started,
            targetResult, targetFailure: String(targetFailure), connectionErrors, output,
        };
        expect(evidence, JSON.stringify(evidence)).toMatchObject({
            listenerOpen: false, connectionClosed: true, targetDone: true,
        });
        expect(evidence.elapsedMs).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
        await expect(exchange(listenPort, "ping")).rejects.toThrow();
    } finally {
        held?.destroy();
        await f.dispose();
    }
}, 40_000);

const HELD_UNIX_CLIENT = `const fs = require('node:fs');
const net = require('node:net');
const sockets = new Set();
const held = net.createConnection(process.argv[2]);
sockets.add(held); held.once('close', () => sockets.delete(held));
held.once('connect', () => held.write('held\\n'));
held.on('data', chunk => process.stdout.write(chunk));
held.on('error', error => process.stdout.write('held-error:' + error.message + '\\n'));
let attempted = false;
const poll = setInterval(() => {
  if (attempted || !fs.existsSync('reconnect')) return;
  attempted = true;
  if (!held.destroyed) held.write('old-after\\n');
  const next = net.createConnection(process.argv[2]);
  sockets.add(next); next.once('close', () => sockets.delete(next));
  next.once('connect', () => next.write('new-after\\n'));
  next.on('data', chunk => process.stdout.write(chunk));
  next.on('error', error => process.stdout.write('new-blocked:' + error.message + '\\n'));
}, 50);
setTimeout(() => { clearInterval(poll); for (const socket of sockets) socket.destroy(); process.exitCode = 29; }, 30000);
`;

test.skipIf(!enabled)("live Unix revocation interrupts the old socket holder or blocks its subsequent connection within eight seconds", async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const exchanges: string[] = [];
    const serverErrors: string[] = [];
    const server = createServer((socket) => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket));
        socket.on("error", (error) => serverErrors.push(error.message));
        let input = "";
        socket.on("data", (chunk) => {
            input += chunk.toString();
            let end: number;
            while ((end = input.indexOf("\n")) !== -1) {
                const line = input.slice(0, end); input = input.slice(end + 1);
                exchanges.push(line);
                socket.write(`${line}:ack\n`);
            }
        });
    });
    let targetDone = false;
    let targetFailure: unknown;
    let targetResult: BashResult | undefined;
    let output = "";
    try {
        const socketPath = join(f.root, "held.sock");
        await listen(server, socketPath);
        await writeFile(join(f.cwd, "held-unix.cjs"), HELD_UNIX_CLIENT);
        await f.start({ unixSockets: [socketPath] });
        const target = f.run(`/usr/bin/node held-unix.cjs ${quote(socketPath)}`, (chunk) => { output += chunk; });
        void target.then(
            (result) => { targetResult = result; targetDone = true; },
            (error) => { targetFailure = error; targetDone = true; },
        );
        const startupDeadline = Date.now() + 8_000;
        while (!output.includes("held:ack") && Date.now() < startupDeadline && !targetDone) await delay(40);
        expect(output, String(targetFailure)).toContain("held:ack");
        expect(sockets.size).toBe(1);
        expect(targetDone).toBe(false);

        const started = Date.now();
        await writeFile(f.projectConfig, JSON.stringify({ resources: { unixSockets: [] } }));
        const admission = await bounded(f.run("pwd"), REVOCATION_BOUND_MS, "Unix policy refresh admission");
        expect(admission.exitCode, admission.output).toBe(0);
        expect(currentShellPolicy()).toMatchObject({ mode: "sandbox", profile: "default", state: "ready" });
        await writeFile(join(f.cwd, "reconnect"), "retry from the old admitted process");
        while (Date.now() - started < REVOCATION_BOUND_MS) {
            if (sockets.size === 0 && (targetDone || output.includes("new-blocked:"))) break;
            await delay(40);
        }
        const evidence = {
            activeConnections: sockets.size, targetDone,
            newConnectionBlocked: output.includes("new-blocked:"),
            elapsedMs: Date.now() - started,
            targetResult, targetFailure: String(targetFailure), exchanges, output, serverErrors,
        };
        expect(evidence.activeConnections, JSON.stringify(evidence)).toBe(0);
        expect(evidence.targetDone || evidence.newConnectionBlocked, JSON.stringify(evidence)).toBe(true);
        expect(evidence.elapsedMs).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
        expect(exchanges).not.toContain("new-after");
    } finally {
        try { await f.dispose(); }
        finally { await closeServer(server, sockets); }
    }
}, 40_000);
