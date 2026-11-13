import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { loadSandboxConfig } from "../index.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
    hostToolReadClosure,
} from "./integration-fixtures.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService, type SandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

for (const mediated of [false, true])
    test.skipIf(
        process.platform !== "linux" ||
            process.env.PI_SANDBOX_HOST_LOOPBACK_CONTRACT !== "1",
    )(
        `global host alias preserves private listeners, dynamic ports and denials (mediated external TCP: ${mediated})`,
        async () => {
            expect(process.env.GITHUB_ACTIONS).toBe("true");
            expect(hasCandidateRuntime()).toBe(true);
            const root = await mkdtemp("/var/tmp/hl-");
            const leases = await mkdtemp("/var/tmp/z-");
            const services: SandboxService[] = [];
            const servers: Server[] = [];
            const requests: string[] = [];
            const cwd = join(root, "project"),
                agentDir = join(root, "agent");
            const quote = (value: string) =>
                "'" + value.replaceAll("'", "'\\''") + "'";
            let late: Promise<void> | undefined;
            async function host(reply: string, host = "127.0.0.1") {
                const server = createServer((socket) =>
                    socket.once("data", () => {
                        requests.push(reply);
                        socket.end(reply);
                    }),
                );
                servers.push(server);
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, host, () => {
                        server.removeListener("error", reject);
                        resolve();
                    });
                });
                const address = server.address();
                if (!address || typeof address === "string")
                    throw new Error("Missing host port");
                return address.port;
            }
            try {
                await mkdir(join(cwd, ".pi/config"), { recursive: true });
                await mkdir(join(agentDir, "config"), { recursive: true });
                if (mediated)
                    await writeFile(
                        join(cwd, ".pi/config/sandbox.json"),
                        JSON.stringify({
                            network: {
                                mediatedDirectTcp: {
                                    enabled: true,
                                    ports: [443],
                                },
                            },
                        }),
                    );
                new ProjectTrustStore(agentDir).set(cwd, true);
                const files = [
                    ...new Set([
                        ...(await hostToolReadClosure("/usr/bin/nc")),
                        ...(await hostToolReadClosure("/usr/bin/sleep")),
                        ...(await hostToolReadClosure("/usr/bin/curl")),
                    ]),
                ];
                async function client(allowed: boolean, deny: string[] = []) {
                    await writeFile(
                        join(agentDir, "config/sandbox.json"),
                        JSON.stringify({
                            version: 2,
                            machineId: "fixture",
                            network: {
                                hostLoopback: { allowed },
                                deniedDomains: deny,
                                ...(mediated
                                    ? {
                                          mediatedDirectTcp: {
                                              allowed: true,
                                              ports: [443],
                                          },
                                      }
                                    : {}),
                            },
                            environment: {
                                installations: {
                                    clients: [
                                        {
                                            root: "/",
                                            path: [],
                                            files: files.map((path) =>
                                                path.slice(1),
                                            ),
                                        },
                                    ],
                                },
                            },
                        }),
                        { mode: 0o600 },
                    );
                    const config = loadSandboxConfig(cwd, {
                        agentDir,
                        machineId: "fixture",
                    }).config;
                    const service = createSandboxService({
                        config,
                        backend: createZeroboxBackend(
                            candidateBackendOptions(join(root, "p")),
                        ),
                        createLease: () =>
                            createPrivateTempLease({ rootDir: leases }),
                        recoverStaleLeases: async () => {
                            await recoverStalePrivateTempLeases({
                                rootDir: leases,
                            });
                        },
                    });
                    services.push(service);
                    await service.startBashSession(cwd);
                    return createBashOperations({
                        detached: true,
                        prepareSpawn: ({ command, cwd }) =>
                            service.prepareBash({
                                file: PRIVATE_BASH,
                                args: ["-c", command],
                                cwd,
                            }),
                    });
                }
                const port = await host("HOST");
                const http = createHttpServer((_request, response) => {
                    requests.push("HTTP_HOST");
                    response.end("HTTP_HOST");
                });
                servers.push(http);
                await new Promise<void>((resolve, reject) => {
                    http.once("error", reject);
                    http.listen(0, "::1", () => {
                        http.removeListener("error", reject);
                        resolve();
                    });
                });
                const httpAddress = http.address();
                if (!httpAddress || typeof httpAddress === "string")
                    throw new Error("Missing HTTP host port");
                const enabled = await client(true);
                const ready = join(cwd, "late-port");
                let output = "";
                const script = `set -eu
(printf PRIVATE | /usr/bin/nc -N -l 127.0.0.1 ${port} >/dev/null) & private_server=$!
trap 'kill "$private_server" 2>/dev/null || true' EXIT
private_result=''
for attempt in {1..50}; do
 private_result=$(printf probe | /usr/bin/nc -N -w 1 127.0.0.1 ${port}) && test "$private_result" = PRIVATE && break
 /usr/bin/sleep 0.05
done
test "$private_result" = PRIVATE
wait "$private_server"
printf '%s\\n' "$private_result"
printf probe | /usr/bin/nc -N -w 5 host.localhost ${port}
printf '\\nHOST_ALIAS_READY\\n'
for attempt in {1..100}; do test -s ${quote(ready)} && break; /usr/bin/sleep 0.05; done
test -s ${quote(ready)}
late_port=$(< ${quote(ready)})
printf probe | /usr/bin/nc -N -w 5 host.localhost "$late_port"
printf '\\n'
/usr/bin/curl --fail --silent --show-error --max-time 5 http://host.localhost:${httpAddress.port}`;
                const result = await enabled.exec(script, cwd, {
                    timeout: 40,
                    onData: (chunk) => {
                        output += chunk.toString();
                        if (!late && output.includes("HOST_ALIAS_READY")) {
                            late = host("LATE_HOST", "::1").then((port) =>
                                writeFile(ready, String(port)),
                            );
                        }
                    },
                });
                await late;
                expect(result.exitCode, output).toBe(0);
                for (const reply of [
                    "PRIVATE",
                    "HOST",
                    "LATE_HOST",
                    "HTTP_HOST",
                ])
                    expect(output.split(/\r?\n/)).toContain(reply);
                expect(requests).toEqual(["HOST", "LATE_HOST", "HTTP_HOST"]);
                const denied = await client(true, [`localhost:${port}`]);
                let deniedOutput = "";
                await denied.exec(
                    `printf probe | /usr/bin/nc -N -w 2 host.localhost ${port}`,
                    cwd,
                    {
                        timeout: 10,
                        onData: (chunk) => {
                            deniedOutput += chunk.toString();
                        },
                    },
                );
                expect(deniedOutput).not.toContain("HOST");
                expect(requests).toEqual(["HOST", "LATE_HOST", "HTTP_HOST"]);
                const disabled = await client(false);
                await disabled.exec(
                    `printf probe | /usr/bin/nc -N -w 2 host.localhost ${port}`,
                    cwd,
                    { timeout: 10, onData: () => {} },
                );
                expect(requests).toEqual(["HOST", "LATE_HOST", "HTTP_HOST"]);
            } finally {
                const cleanup = [
                    ...(await Promise.allSettled(late ? [late] : [])),
                    ...(await Promise.allSettled(
                        services.map((service) => service.shutdown()),
                    )),
                ];
                cleanup.push(
                    ...(await Promise.allSettled(
                        servers
                            .filter((server) => server.listening)
                            .map(
                                (server) =>
                                    new Promise<void>((resolve, reject) =>
                                        server.close((error) =>
                                            error ? reject(error) : resolve(),
                                        ),
                                    ),
                            ),
                    )),
                );
                cleanup.push(
                    ...(await Promise.allSettled([
                        rm(root, { recursive: true, force: true }),
                        rm(leases, { recursive: true, force: true }),
                    ])),
                );
                const failed = cleanup
                    .filter((result) => result.status === "rejected")
                    .map((result) => result.reason);
                if (failed.length)
                    throw new AggregateError(
                        failed,
                        "Host loopback qualification cleanup failed",
                    );
            }
        },
        180000,
    );
