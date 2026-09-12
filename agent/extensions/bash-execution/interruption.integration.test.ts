import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { emptyGrants } from "../sandbox/capabilities/authority.ts";
import { publishShellRuntime, releaseShellRuntime } from "../sandbox/capabilities/runtime.ts";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import bashExecution from "./index.ts";

async function fixture() {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".interruption-"));
    const owner = Symbol("interruption-fixture");
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: "disabled" });
    publishShellRuntime(owner, () => ({
        state: "ready", projectRoot: cwd, mode: "host", requestedMode: "host",
        requestedProfile: "host", profile: "host", grants: emptyGrants(),
        requestedGrants: emptyGrants(), authorityPath: "/unused",
    }));
    const session = await createTestSession({ cwd, extensionFactories: [bashExecution] });
    return {
        session,
        async dispose() {
            session.dispose();
            releaseSandboxRuntime(owner);
            releaseShellRuntime(owner);
            await rm(cwd, { recursive: true, force: true });
        },
    };
}

test("safe_bash returns a normalized fractional timeout without restoring raw output", async () => {
    const f = await fixture();
    try {
        const realTools = f.session.session.agent.state.tools;
        const running = f.session.run(when("Run the bounded fixture", [
            calls("safe_bash", { command: "printf RAW_TIMEOUT_FIXTURE; sleep 2", timeout: 0.08000000001 }),
            says("done"),
        ]));
        // Observe Pi's native thrown-error result; the harness collection wrapper reformats errors.
        f.session.session.agent.state.tools = realTools;
        await running;
        const result = f.session.events.toolResultsFor("safe_bash").at(-1)!;
        expect(result.isError).toBe(true);
        expect(result.text).toBe("Command timed out after 0.08 seconds");
        expect(result.details).toMatchObject({ execution: { outcome: "timed-out" } });
    } finally {
        await f.dispose();
    }
}, 30_000);

test("real Pi distinguishes local exit from external work that continues after timeout", async () => {
    const sockets = new Set<Socket>();
    const serviceState = { value: "idle" };
    const finishWork = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", async () => {
            serviceState.value = "running";
            await finishWork.promise;
            serviceState.value = "completed";
            completed.resolve();
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const f = await fixture();
    try {
        const running = f.session.run(when("Run one service request", [
            calls("safe_bash", { command: `/usr/bin/curl --noproxy '*' -s http://127.0.0.1:${address.port}/attempt-1`, timeout: 0.3 }),
            says("done"),
        ]));
        const inputs: string[] = [];
        const original = f.session.session.agent.streamFunction;
        f.session.session.agent.streamFunction = (model, context, options) => {
            inputs.push(JSON.stringify(context.messages));
            return original(model, context, options);
        };
        await running;
        expect(serviceState.value).toBe("running");
        const result = f.session.events.toolResultsFor("safe_bash").at(-1)!;
        expect(result.details).toMatchObject({ execution: { outcome: "timed-out", localProcess: "exited" } });
        expect(inputs.at(-1)).toContain("Local command process exit: confirmed");
        expect(inputs.at(-1)).toContain("External service work: not confirmed stopped");
        expect(inputs.at(-1)).toContain("unique attempt ID and separate result files");
        // The service can finish independently after its client has been killed.
        finishWork.resolve();
        await completed.promise;
        expect(serviceState.value).toBe("completed");
    } finally {
        finishWork.resolve();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await f.dispose();
    }
}, 30_000);
