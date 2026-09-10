import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import { DOCKER_ACCESS_PROFILES } from "./docker-presentation.ts";
import { createSandboxService } from "./runtime/service.ts";
import { createZeroboxBackend } from "./runtime/zerobox-backend.ts";
import { validatePiSandboxConfig } from "./runtime/policies.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { createSandboxedBashOps } from "./index.ts";

test("real Docker and Compose clients enforce Administration, inspection, and break-glass", async () => {
    // Keep the project visible while Bash overlays the host /tmp namespace.
    const root = await mkdtemp(join(import.meta.dir, ".pi-docker-exec-"));
    const socketRoot = await mkdtemp("/tmp/pi-docker-exec-");
    const endpoint = join(socketRoot, "engine.sock");
    const id = "a".repeat(64), execId = "b".repeat(64);
    const labels = { "com.docker.compose.project": "fixtureexec", "com.docker.compose.service": "api", "com.docker.compose.oneoff": "False" };
    const summary = { Id: id, Names: ["/fixture-api"], Image: "fixture", Command: "fixture", Created: 1, State: "running", Status: "Up", Ports: [], Labels: labels, Mounts: [] };
    const sockets = new Set<Socket>();
    const bodies: unknown[] = [];
    const unexpected: string[] = [];
    const requests: string[] = [];
    let hostAccessTarget = false;
    // A raw Engine fixture preserves Docker's HTTP-to-stream upgrade exactly.
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        let received = Buffer.alloc(0);
        const readRequest = (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            const headerEnd = received.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const head = received.subarray(0, headerEnd).toString();
            const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
            if (received.length < headerEnd + 4 + length) return;
            socket.off("data", readRequest);
            const [method, url] = head.split("\r\n")[0].split(" ");
            const path = url.replace(/^\/v[\d.]+/, "").split("?")[0];
            requests.push(`${method} ${path}`);
            const respond = (value: unknown, status = "200 OK", headers = "") => {
                const body = method === "HEAD" ? "" : JSON.stringify(value);
                socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${headers}\r\n${body}`);
            };
            if (path === "/_ping") return respond("OK", "200 OK", "API-Version: 1.52\r\n");
            if (path === "/version") return respond({ ApiVersion: "1.52", MinAPIVersion: "1.24" });
            if (path === "/containers/json") return respond([summary]);
            if (path === `/containers/${id}/json`) return respond({ Id: id, Name: "/fixture-api", Config: { User: "", Tty: false, Labels: labels }, State: { Running: true }, HostConfig: {}, Mounts: hostAccessTarget ? [{ Type: "bind", Source: "/host/auths", Destination: "/auths", RW: true }] : [] });
            if (path === `/containers/${id}/exec`) {
                bodies.push(JSON.parse(received.subarray(headerEnd + 4, headerEnd + 4 + length).toString()));
                return respond({ Id: execId }, "201 Created");
            }
            if (path === `/exec/${execId}/json`) return respond({ Id: execId, Running: false, ExitCode: 0 });
            if (path === `/exec/${execId}/start`) {
                const body = Buffer.from("fixture exec ok\n");
                const frame = Buffer.alloc(8); frame[0] = 1; frame.writeUInt32BE(body.length, 4);
                socket.end(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"), frame, body]));
                return;
            }
            unexpected.push(`${method} ${path}`);
            respond({}, "404 Not Found");
        };
        socket.on("data", readRequest);
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    await writeFile(join(root, "compose.yaml"), "name: fixtureexec\nservices:\n  api:\n    image: fixture\n");
    try {
        for (const profile of DOCKER_ACCESS_PROFILES) {
            const service = createSandboxService({ backend: createZeroboxBackend(), config: validatePiSandboxConfig({}, {
                mode: "targeted", endpoint: `unix://${endpoint}`,
                targets: [{ selector: { type: "compose-service", project: "fixtureexec", service: "api" }, operations: profile.operations, allowUnsafeTarget: false }],
            }) });
            const supervisor = createBashProcessSupervisor();
            try {
                await service.startBashSession(root);
                const operations = createSandboxedBashOps(service, supervisor);
                for (const command of ["docker exec fixture-api true", "docker compose exec -T api true"]) {
                    const executionsBefore = bodies.length;
                    let output = "";
                    const result = await operations.exec(command, root, { onData: (chunk) => { output += chunk.toString(); }, timeout: 15 }).catch((error) => { throw new Error(`${String(error)}; ${JSON.stringify({ requests, unexpected, output })}`); });
                    if (profile.label === "Administration") {
                        expect({ output, requests, unexpected }).toMatchObject({ output: expect.stringContaining("fixture exec ok") });
                        expect(result.exitCode).toBe(0);
                    } else {
                        expect(output).toMatch(/Docker operation (?:is not granted|forbidden)/);
                        expect(result.exitCode).not.toBe(0);
                        expect(bodies.length).toBe(executionsBefore);
                    }
                }
            } finally { supervisor.shutdown(); await service.shutdown(); }
        }

        hostAccessTarget = true;
        const restrictedService = createSandboxService({ backend: createZeroboxBackend(), config: validatePiSandboxConfig({}, {
            mode: "targeted", endpoint: `unix://${endpoint}`,
            targets: [{ selector: { type: "compose-service", project: "fixtureexec", service: "api" }, operations: [...DOCKER_ACCESS_PROFILES.find((profile) => profile.label === "Administration")!.operations], allowUnsafeTarget: true }],
        }) });
        const restrictedSupervisor = createBashProcessSupervisor();
        try {
            await restrictedService.startBashSession(root);
            const operations = createSandboxedBashOps(restrictedService, restrictedSupervisor);
            let output = "";
            const probe = await operations.exec("docker exec fixture-api test -r /auths/main.log", root, { onData: (chunk) => { output += chunk.toString(); }, timeout: 15 });
            expect(probe.exitCode).toBe(0);
            expect(output).toContain("fixture exec ok");

            output = "";
            const mutation = await operations.exec("docker compose exec -T api chmod 0644 /auths/main.log", root, { onData: (chunk) => { output += chunk.toString(); }, timeout: 15 });
            expect(mutation.exitCode).not.toBe(0);
            expect(output).toContain("Docker exec is restricted to read-only inspection");
        } finally { restrictedSupervisor.shutdown(); await restrictedService.shutdown(); }

        const breakGlassExpiresAtMs = Date.now() + 2_000;
        const breakGlassService = createSandboxService({ backend: createZeroboxBackend(), config: validatePiSandboxConfig({}, {
            mode: "targeted", endpoint: `unix://${endpoint}`,
            targets: [
                { selector: { type: "compose-service", project: "fixtureexec", service: "api" }, operations: [...DOCKER_ACCESS_PROFILES.find((profile) => profile.label === "Administration")!.operations], allowUnsafeTarget: true },
                { selector: { type: "ephemeral-container", id, unsafeExecExpiresAtMs: breakGlassExpiresAtMs }, operations: ["exec"], allowUnsafeTarget: true },
            ],
        }) });
        const breakGlassSupervisor = createBashProcessSupervisor();
        try {
            await breakGlassService.startBashSession(root);
            const operations = createSandboxedBashOps(breakGlassService, breakGlassSupervisor);
            let output = "";
            const mutation = await operations.exec("docker compose exec -T api chmod 0644 /auths/main.log", root, { onData: (chunk) => { output += chunk.toString(); }, timeout: 15 });
            expect(mutation.exitCode).toBe(0);
            expect(output).toContain("fixture exec ok");

            await Bun.sleep(Math.max(0, breakGlassExpiresAtMs - Date.now() + 50));
            output = "";
            const expired = await operations.exec("docker exec fixture-api true", root, { onData: (chunk) => { output += chunk.toString(); }, timeout: 15 });
            expect(expired.exitCode).not.toBe(0);
            expect(output).toContain("Docker break-glass exec expired");
        } finally { breakGlassSupervisor.shutdown(); await breakGlassService.shutdown(); }

        expect(bodies).toHaveLength(4);
        expect(bodies[0]).toMatchObject({ DetachKeys: "", Privileged: false });
        expect(unexpected).toEqual([]);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        await rm(socketRoot, { recursive: true, force: true });
    }
}, 60_000);
