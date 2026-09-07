import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
    claimSandboxRuntime,
    createSandboxBashOperations,
    createSandboxThinkBashOperations,
    getSandboxAnalysisPort,
    getSandboxRuntime,
    isSandboxUnavailableError,
    ownsSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    type AnalysisSandboxPort,
} from "./index.ts";

const owners: symbol[] = [];

function claim(label: string): symbol {
    const owner = Symbol(label);
    owners.push(owner);
    claimSandboxRuntime(owner);
    return owner;
}

afterEach(() => {
    for (const owner of owners.splice(0)) releaseSandboxRuntime(owner);
});

describe("sandbox runtime v2", () => {
    test("waits through reconfiguration and resolves previously created operations against the new runtime", async () => {
        const owner = claim("reconfigure");
        const calls: string[] = [];
        const snapshot = (label: string) => ({
            state: "enabled" as const,
            createBashOperations: () => ({ exec: async () => { calls.push(label); return { exitCode: 0 }; } }),
            createThinkBashOperations: () => ({ exec: async () => { calls.push(`think-${label}`); return { exitCode: 0 }; } }),
            analysis: { run: async () => ({ output: label, stderr: "", runtime: "quickjs" as const, durationMs: 1, truncated: false }), shutdown: async () => undefined },
        });
        publishSandboxRuntime(owner, snapshot("old"));
        const bash = createSandboxBashOperations();
        const think = createSandboxThinkBashOperations();
        const analysis = getSandboxAnalysisPort();
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        const pending = Promise.all([
            bash.exec("true", "/tmp", { onData() {} }),
            think.exec("true", "/tmp", { onData() {} }),
            analysis.run({ id: "wait", language: "javascript", program: "return 1" }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(calls).toEqual([]);
        publishSandboxRuntime(owner, snapshot("new"));
        const result = await pending;
        expect(calls).toEqual(["new", "think-new"]);
        expect(result[2]).toMatchObject({ output: "new" });
    });

    test("publishes Bash and analysis through one enabled snapshot", async () => {
        const owner = claim("enabled");
        const analysis: AnalysisSandboxPort = {
            run: async () => ({
                output: "derived",
                stderr: "",
                runtime: "quickjs",
                durationMs: 1,
                truncated: false,
            }),
            shutdown: async () => undefined,
        };
        const exec = async () => ({ exitCode: 0 });

        expect(
            publishSandboxRuntime(owner, {
                state: "enabled",
                createBashOperations: () => ({ exec }),
                createThinkBashOperations: () => ({ exec }),
                analysis,
            }),
        ).toBe(true);

        const snapshot = getSandboxRuntime();
        expect(snapshot.state).toBe("enabled");
        expect(await createSandboxBashOperations().exec("true", "/tmp", {
            onData: () => undefined,
        }))
            .toEqual({ exitCode: 0 });
        expect(await getSandboxAnalysisPort().run({ id: "analysis", language: "javascript", program: "1" })).toMatchObject({ output: "derived" });
    });

    test("rejects stale publication and stale release", () => {
        const stale = claim("stale");
        const current = claim("current");

        expect(ownsSandboxRuntime(stale)).toBe(false);
        expect(
            publishSandboxRuntime(stale, { state: "disabled" }),
        ).toBe(false);
        expect(releaseSandboxRuntime(stale)).toBe(false);
        expect(ownsSandboxRuntime(current)).toBe(true);
        expect(getSandboxRuntime()).toEqual({ state: "uninitialized" });
    });

    test.each(["disabled", "error", "session", "abort", "timeout"] as const)("settles a pending request on %s without executing", async (ending) => {
        const owner = claim("pending");
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        const abort = new AbortController();
        const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {}, signal: abort.signal, timeout: ending === "timeout" ? 0.015 : 1 });
        const rejected = pending.catch((error: Error) => error);
        if (ending === "disabled" || ending === "error") publishSandboxRuntime(owner, { state: ending });
        if (ending === "session") claim("replacement");
        if (ending === "abort") abort.abort();
        expect(await rejected).toBeInstanceOf(Error);
        expect((await rejected as Error).message).toContain({
            disabled: "disabled", error: "initialization failed", session: "session changed", abort: "aborted", timeout: "did not finish in time",
        }[ending]);
    });

    test("subtracts reconfiguration time from the command deadline and survives successive transitions", async () => {
        const owner = claim("deadline");
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        let timeout = 0;
        let runs = 0;
        const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {}, timeout: 1 });
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        await new Promise((resolve) => setTimeout(resolve, 15));
        publishSandboxRuntime(owner, {
            state: "enabled",
            createBashOperations: () => ({ exec: async (_command, _cwd, options) => { timeout = options.timeout ?? 0; runs++; return { exitCode: 0 }; } }),
            createThinkBashOperations: () => { throw new Error("wrong profile"); },
            analysis: { run: async () => { throw new Error("wrong path"); }, shutdown: async () => undefined },
        });
        await pending;
        expect(runs).toBe(1);
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThan(0.99);
    });

    test("invalidates old adapters when the same extension binds a different session", async () => {
        const owner = claim("same extension");
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {}, timeout: 0.03 }).catch((error: Error) => error);
        claimSandboxRuntime(owner);
        expect((await pending as Error).message).toContain("session changed");
    });

    test("does not dispatch after the 30 second reconfiguration limit even if activation just completed", async () => {
        const owner = claim("expired activation");
        const now = spyOn(performance, "now").mockReturnValue(0);
        let runs = 0;
        try {
            publishSandboxRuntime(owner, { state: "reconfiguring" });
            const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {} }).catch((error: Error) => error);
            now.mockReturnValue(30_001);
            publishSandboxRuntime(owner, {
                state: "enabled",
                createBashOperations: () => ({ exec: async () => { runs++; return { exitCode: 0 }; } }),
                createThinkBashOperations: () => { throw new Error("wrong profile"); },
                analysis: { run: async () => { throw new Error("wrong path"); }, shutdown: async () => undefined },
            });
            expect(await pending).toBeInstanceOf(Error);
            expect(runs).toBe(0);
        } finally { now.mockRestore(); }
    });

    test("reports interruption of an engaged process without replaying it", async () => {
        const owner = claim("interruption");
        let finish!: (result: { exitCode: null }) => void;
        let runs = 0;
        publishSandboxRuntime(owner, {
            state: "enabled",
            createBashOperations: () => ({ exec: () => { runs++; return new Promise((resolve) => { finish = resolve; }); } }),
            createThinkBashOperations: () => { throw new Error("wrong profile"); },
            analysis: { run: async () => { throw new Error("wrong path"); }, shutdown: async () => undefined },
        });
        const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {} });
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        finish({ exitCode: null });
        await expect(pending).rejects.toThrow("interrupted by reconfiguration; it was not retried");
        expect(runs).toBe(1);
    });

    test("waits again if another transition starts between readiness and dispatch", async () => {
        const owner = claim("overlapping");
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        let runs = 0;
        const enabled = { state: "enabled" as const,
            createBashOperations: () => ({ exec: async () => { runs++; return { exitCode: 0 }; } }),
            createThinkBashOperations: () => { throw new Error("wrong profile"); },
            analysis: { run: async () => { throw new Error("wrong path"); }, shutdown: async () => undefined },
        };
        const pending = createSandboxBashOperations().exec("true", "/tmp", { onData() {}, timeout: 1 }).catch((error: Error) => error);
        publishSandboxRuntime(owner, enabled);
        queueMicrotask(() => {
            publishSandboxRuntime(owner, { state: "reconfiguring" });
            setTimeout(() => publishSandboxRuntime(owner, enabled), 5);
        });
        expect(await pending).toEqual({ exitCode: 0 });
        expect(runs).toBe(1);
    });

    test("disabled carries no local adapter and fails closed by default", async () => {
        const owner = claim("disabled");
        expect(
            publishSandboxRuntime(owner, { state: "disabled" }),
        ).toBe(true);
        expect(getSandboxRuntime()).toEqual({ state: "disabled" });

        try {
            await createSandboxBashOperations().exec("true", "/tmp", {
                onData: () => undefined,
            });
            throw new Error("expected disabled runtime to reject");
        } catch (error) {
            expect(isSandboxUnavailableError(error)).toBe(true);
            if (isSandboxUnavailableError(error)) {
                expect(error.getKind()).toBe("disabled");
                expect(error.message).toBe(
                    "Sandbox execution unavailable: disabled",
                );
            }
        }
    });

    test("keeps initialization diagnostics private", async () => {
        const owner = claim("error");
        expect(
            publishSandboxRuntime(
                owner,
                { state: "error" },
                "secret initialization details",
            ),
        ).toBe(true);
        expect(JSON.stringify(getSandboxRuntime())).toBe('{"state":"error"}');

        try {
            await createSandboxBashOperations().exec("true", "/tmp", {
                onData: () => undefined,
            });
            throw new Error("expected failed runtime to reject");
        } catch (error) {
            expect(isSandboxUnavailableError(error)).toBe(true);
            if (isSandboxUnavailableError(error)) {
                expect(error.getKind()).toBe("initialization-failed");
                expect(error.message).not.toContain("secret");
                expect(error.getDiagnostic()).toBe(
                    "secret initialization details",
                );
                expect(JSON.stringify(error)).not.toContain("secret");
            }
        }
    });
});
