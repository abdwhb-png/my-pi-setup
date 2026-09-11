import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectDockerAccess } from "./docker-access.ts";
import { validatePiSandboxConfig, type PiSandboxConfig } from "./runtime/policies.ts";
import { createSandboxService } from "./runtime/service.ts";
import { createZeroboxBackend } from "./runtime/zerobox-backend.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./runtime/private-temp.ts";

test.skipIf(process.platform !== "linux" || !process.env.PI_SANDBOX_ZEROBOX_BINARY || !process.env.PI_SANDBOX_ZEROBOX_SHA256)("the real broker respects explicit CLI reads and excludes a bind-mounted target until its explicit exception is enabled", async () => {
    const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
    const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
    if (!binaryPath || !binarySha256) throw new Error("Explicit candidate binary and SHA256 required");
    const root = await mkdtemp("/var/tmp/d-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const dockerClient = await realpath("/usr/bin/docker");
    const socket = join(root, "engine.sock");
    const id = "a".repeat(64);
    const methods: string[] = [];
    const summary = { Id: id, Names: ["/cliproxy-fixture"], Image: "fixture", Command: "fixture", Created: 1, State: "running", Status: "Up", Ports: [], Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "api" }, Mounts: [] };
    const server = createServer((request, response) => {
        methods.push(request.method ?? "");
        const path = (request.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0];
        if (path === "/_ping") { response.setHeader("API-Version", "1.52"); response.end("OK"); return; }
        response.setHeader("Content-Type", "application/json");
        if (path === "/version") { response.end(JSON.stringify({ ApiVersion: "1.52", MinAPIVersion: "1.24" })); return; }
        if (path === "/containers/json") { response.end(JSON.stringify([summary])); return; }
        if (path === `/containers/${id}/json`) {
            response.end(JSON.stringify({ Id: id, Name: "/cliproxy-fixture", HostConfig: { Binds: ["/fixture/config:/app/config:ro"] }, Mounts: [{ Type: "bind", Source: "/fixture/config", Destination: "/app/config", RW: false }] })); return;
        }
        response.statusCode = 404; response.end("{}");
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    let cliReadAllowed = true;
    const createService = (config: PiSandboxConfig) => {
        expect(config.filesystem.allowRead.includes(dockerClient)).toBe(cliReadAllowed);
        expect(config.resources).toEqual({ unixSockets: [], tcpPublications: [] });
        expect(config.environment.variables).toEqual({ DIAGNOSTIC_FIXTURE: "retained" });
        expect(config.environment.path).toEqual(["/usr/bin"]);
        expect(config.filesystem.denyWrite).toContain(".env");
        return createSandboxService({
            config,
            backend: createZeroboxBackend({ binaryPath, expectedProvenance: { version: "0.3.3-fork.17", binarySha256 }, probeRoot: join(root, "probe") }),
            createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
            recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
        });
    };
    let effectiveConfig: PiSandboxConfig | undefined;
    try {
        for (const allowUnsafeTarget of [false, true]) {
            const config = validatePiSandboxConfig({
                filesystem: { allowRead: [".", dockerClient], denyWrite: [".env"] },
                environment: { variables: { DIAGNOSTIC_FIXTURE: "retained" }, path: ["/usr/bin"] },
                resources: { unixSockets: [socket], tcpPublications: [{ transport: "tcp", scope: "host", listen: "127.0.0.1:34567", target: "127.0.0.1:34568" }] },
            }, { mode: "targeted", endpoint: `unix://${socket}`, targets: [{ selector: { type: "compose-service", project: "fixture", service: "api" }, operations: ["logs"], allowUnsafeTarget }] });
            const result = await inspectDockerAccess(root, config, { createService });
            effectiveConfig = config;
            expect(result).toHaveLength(1);
            expect(result[0].containers[0]).toMatchObject({ id, access: allowUnsafeTarget ? "accessible" : "excluded", mounts: [{ source: "/fixture/config", destination: "/app/config", writable: false }] });
        }
        if (!effectiveConfig) throw new Error("Missing effective fixture config");
        cliReadAllowed = false;
        await expect(inspectDockerAccess(root, {
            ...effectiveConfig,
            filesystem: { ...effectiveConfig.filesystem, allowRead: ["."] },
        }, { createService })).rejects.toThrow("Docker broker inspection failed");
        expect(methods.every(method => method === "GET" || method === "HEAD")).toBe(true);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 30_000);
