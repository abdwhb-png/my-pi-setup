/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createSandboxBashOperations,
    getSandboxAnalysisPort,
    getSandboxRuntime,
    isSandboxUnavailableError,
} from "../_shared/sandbox-runtime/index.ts";
import sandboxExtension from "./index.ts";

type SessionHandler = (
    event: unknown,
    ctx: ExtensionContext,
) => Promise<void>;

function registerSandbox(options: { noSandbox?: boolean } = {}): {
    start: SessionHandler;
    stop?: SessionHandler;
} {
    let start: SessionHandler | undefined;
    let stop: SessionHandler | undefined;
    const pi = {
        registerFlag: () => undefined,
        registerTool: () => {
            throw new Error("sandbox must not register a tool");
        },
        registerCommand: () => undefined,
        on: (event: string, handler: SessionHandler) => {
            if (event === "session_start") start = handler;
            if (event === "session_shutdown") stop = handler;
        },
        getFlag: () => options.noSandbox ?? true,
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);
    if (!start) throw new Error("sandbox session_start was not registered");
    return { start, stop };
}

const context = {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify: mock(() => undefined) },
} as unknown as ExtensionContext;

describe("sandbox runtime publication", () => {
    it("publishes a disabled snapshot with no local execution adapter", async () => {
        const registered = registerSandbox({ noSandbox: true });
        await registered.start({}, context);

        expect(getSandboxRuntime()).toEqual({ state: "disabled" });
        await expect(
            getSandboxAnalysisPort().run({
                id: "disabled-analysis",
                language: "javascript",
                program: "export default 1",
            }),
        ).rejects.toThrow("Sandbox execution unavailable: disabled");
        await expect(
            createSandboxBashOperations().exec("true", context.cwd, {
                onData: () => undefined,
            }),
        ).rejects.toThrow("Sandbox execution unavailable: disabled");
    });

    it("publishes a bounded error snapshot for malformed config", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "sandbox-malformed-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(join(cwd, ".pi", "sandbox.json"), "{ invalid");
        const malformedContext = { ...context, cwd } as ExtensionContext;

        try {
            const registered = registerSandbox({ noSandbox: false });
            await registered.start({}, malformedContext);
            expect(getSandboxRuntime()).toEqual({ state: "error" });
            let captured: unknown;
            try {
                await createSandboxBashOperations().exec(
                    "printf should-not-run",
                    cwd,
                    { onData: () => undefined },
                );
            } catch (error) {
                captured = error;
            }
            expect(isSandboxUnavailableError(captured)).toBe(true);
            if (isSandboxUnavailableError(captured)) {
                expect(captured.getKind()).toBe("initialization-failed");
                expect(captured.message).not.toContain("sandbox.json");
                expect(JSON.stringify(captured)).not.toContain("sandbox.json");
            }
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("publishes executable Zerobox operations and analysis together", async () => {
        const cwd = await mkdtemp(join(import.meta.dir, ".sandbox-real-index-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({
                enabled: true,
                filesystem: { allowWrite: ["."], denyWrite: [".env"] },
                network: { allowedDomains: [], deniedDomains: [] },
            }),
        );
        const realContext = { ...context, cwd } as ExtensionContext;
        const registered = registerSandbox({ noSandbox: false });
        const chunks: string[] = [];
        try {
            await registered.start({}, realContext);
            expect(getSandboxRuntime().state).toBe("enabled");
            const result = await createSandboxBashOperations().exec(
                "printf zerobox-index",
                cwd,
                { onData: (chunk) => chunks.push(chunk.toString()) },
            );
            expect(result.exitCode).toBe(0);
            expect(chunks.join("")).toBe("zerobox-index");
        } finally {
            await registered.stop?.({}, realContext);
            await rm(cwd, { recursive: true, force: true });
        }
    }, 30_000);
});
