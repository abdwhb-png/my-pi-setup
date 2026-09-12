import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { candidateBackendOptions, hasCandidateRuntime, hostToolReadClosure } from "./integration-fixtures.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";

for (const scenario of [
    {
        name: "a completed WebSocket exchange",
        output: "",
        code: 0,
        truncated: false,
    },
    {
        name: "a completed WebSocket exchange with large output and a nonzero result",
        output: "x".repeat(256 * 1024),
        code: 37,
        truncated: false,
    },
    {
        name: "a response truncated by the upstream server",
        output: "response-status:200\nincomplete-response\n",
        code: 23,
        truncated: true,
    },
]) {
    test.skipIf(process.platform !== "linux" || !hasCandidateRuntime())(
        `${scenario.name} preserves output and the target result`,
        async () => {
            const cwd = await mkdtemp("/var/tmp/ws-");
            const leaseRoot = await mkdtemp("/var/tmp/z-");
            const bun = realpathSync(process.execPath);
            const closes: number[] = [];
            const host = await (async () => {
                if (scenario.truncated) {
                    let responseSocket: Socket | undefined;
                    const server = createServer((socket) => {
                        socket.once("data", (request) => {
                            if (request.toString().startsWith("GET /truncate ")) {
                                responseSocket?.end();
                                socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                return;
                            }
                            responseSocket = socket;
                            socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial");
                        });
                    });
                    await new Promise<void>((resolve, reject) => {
                        server.once("error", reject);
                        server.listen(0, "127.0.0.1", resolve);
                    });
                    const address = server.address();
                    if (!address || typeof address === "string")
                        throw new Error("Missing TCP listener address");
                    return {
                        port: address.port,
                        close: () =>
                            new Promise<void>((resolve, reject) =>
                                server.close((error) =>
                                    error ? reject(error) : resolve(),
                                ),
                            ),
                    };
                }
                const server = Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    fetch(request, listener) {
                        if (listener.upgrade(request)) return undefined;
                        return new Response("Upgrade required", {
                            status: 426,
                        });
                    },
                    websocket: {
                        message(socket) {
                            if (scenario.output) socket.send(scenario.output);
                            socket.send(
                                JSON.stringify({
                                    type: "exit",
                                    code: scenario.code,
                                }),
                            );
                        },
                        close(_socket, code) {
                            closes.push(code);
                        },
                    },
                });
                if (server.port === undefined)
                    throw new Error("Missing WebSocket listener port");
                return {
                    port: server.port,
                    close: async () => {
                        await server.stop(true);
                    },
                };
            })();
            const service = createSandboxService({
                config: validatePiSandboxConfig({
                    network: { allowedDomains: [`localhost:${host.port}`] },
                    // Expose the exact client and ELF closure only for this transport probe.
                    filesystem: { allowRead: [cwd, ...await hostToolReadClosure(bun)], allowWrite: [cwd] },
                }),
                backend: createZeroboxBackend(candidateBackendOptions(join(cwd,"probe"))),
                createLease: () =>
                    createPrivateTempLease({ rootDir: leaseRoot }),
                recoverStaleLeases: async () => {},
            });
            try {
                await writeFile(
                    join(cwd, "client.ts"),
                    scenario.truncated
                        ? `
const response = await fetch(process.argv[2]);
console.log('response-status:' + response.status);
// Close only after headers have arrived. Bun can reject text() or return an
// empty/partial body on early EOF, so verify the advertised length too.
await fetch(process.argv[2] + '/truncate');
let incomplete = false;
try {
    const body = await response.text();
    incomplete = response.headers.get('content-length') === '100' && body.length < 100;
} catch {
    incomplete = true;
}
if (incomplete) {
    console.log('incomplete-response');
    process.exitCode = 23;
} else {
    console.log('unexpected-complete-response');
    process.exitCode = 1;
}`
                        : String.raw`
const socket = new WebSocket(process.argv[2]);
let receivedExit = false;
let outputQueue = Promise.resolve();
const writeOutput = value => new Promise((resolve, reject) => process.stdout.write(value, error => error ? reject(error) : resolve()));
socket.addEventListener('open', () => socket.send('start'));
socket.addEventListener('message', event => {
    const data = String(event.data);
    outputQueue = outputQueue.then(async () => {
        if (!data.startsWith('{')) { await writeOutput(data); return; }
        const value = JSON.parse(data);
        if (value.type === 'exit') {
            await writeOutput('observed-exit:' + value.code + '\n');
            receivedExit = true;
            process.exitCode = value.code;
            socket.close();
        }
    }).catch(() => { process.exitCode = 23; socket.close(); });
});
socket.addEventListener('error', () => { process.exitCode = 23; });
socket.addEventListener('close', () => {
    if (!receivedExit) { console.error('missing-final-result'); process.exitCode = 23; }
});`,
                );
                await service.startBashSession(cwd);
                const operations = createBashOperations({
                    detached: true,
                    prepareSpawn: ({ command, cwd: commandCwd }) =>
                        service.prepareBash({
                            file: PRIVATE_BASH,
                            args: ["-c", command],
                            cwd: commandCwd,
                        }),
                });
                let output = "";
                const command = [
                    bun,
                    join(cwd, "client.ts"),
                    `${scenario.truncated ? "http" : "ws"}://127.0.0.1:${host.port}`,
                ]
                    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
                    .join(" ");
                const result = await operations.exec(command, cwd, {
                    timeout: 10,
                    onData: (chunk) => {
                        output += chunk.toString();
                    },
                });
                expect(result.exitCode, output).toBe(scenario.code);
                expect(closes).toEqual(scenario.truncated ? [] : [1000]);
                expect(output).toBe(
                    scenario.output +
                        (scenario.truncated
                            ? ""
                            : `observed-exit:${scenario.code}\n`),
                );
            } finally {
                await service.shutdown();
                await host.close();
                await rm(cwd, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
            }
        },
        20_000,
    );
}
