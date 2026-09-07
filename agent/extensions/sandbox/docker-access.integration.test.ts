import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectDockerAccess } from "./docker-access.ts";

test("the real broker excludes a bind-mounted target until its explicit exception is enabled", async () => {
    const root = await mkdtemp("/tmp/pi-docker-access-");
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
            response.end(JSON.stringify({ Id: id, Name: "/cliproxy-fixture", HostConfig: { Binds: ["/fixture/config:/app/config:ro"] }, Mounts: [{ Type: "bind", Destination: "/app/config", RW: false }] })); return;
        }
        response.statusCode = 404; response.end("{}");
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
        for (const allowUnsafeTarget of [false, true]) {
            const result = await inspectDockerAccess(import.meta.dir, { mode: "targeted", endpoint: `unix://${socket}`, targets: [{ selector: { type: "compose-service", project: "fixture", service: "api" }, operations: ["ps"], allowUnsafeTarget }] });
            expect(result[0].containers[0]).toMatchObject({ id, access: allowUnsafeTarget ? "accessible" : "excluded", facts: ["Host bind mount: /app/config (read-only)"] });
        }
        expect(methods.every(method => method === "GET" || method === "HEAD")).toBe(true);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
