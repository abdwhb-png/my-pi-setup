import { afterEach, describe, expect, test } from "bun:test";

import {
    claimSandboxRuntime,
    createSandboxBashOperations,
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
                analysis,
            }),
        ).toBe(true);

        const snapshot = getSandboxRuntime();
        expect(snapshot.state).toBe("enabled");
        expect(await createSandboxBashOperations().exec("true", "/tmp", {
            onData: () => undefined,
        }))
            .toEqual({ exitCode: 0 });
        expect(getSandboxAnalysisPort()).toBe(analysis);
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
