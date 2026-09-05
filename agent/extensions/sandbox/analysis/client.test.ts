/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";

import {
    analysisHostResponseBudget,
    createAnalysisSandboxService,
    type AnalysisHostRunner,
} from "./client.ts";
import type {
    AnalysisResult,
    NormalizedAnalysisRequest,
} from "./protocol.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

const result: AnalysisResult = {
    output: "ok",
    stderr: "",
    runtime: "quickjs",
    durationMs: 1,
    truncated: false,
};

describe("analysis sandbox client", () => {
    it("budgets the worst-case JSON escaping around logical worker output", () => {
        expect(analysisHostResponseBudget(2)).toBe(64 * 1024 + 12);
    });

    it("preflights TypeScript and Python through the bounded host queue once", async () => {
        const languages: string[] = [];
        const service = createAnalysisSandboxService({
            runHost: async (request) => {
                languages.push(request.language);
                return {
                    ...result,
                    runtime: request.worker,
                };
            },
        });

        await Promise.all([service.preflight(), service.preflight()]);

        expect(languages.sort()).toEqual(["python", "typescript"]);
        await service.shutdown();
    });

    it("runs at most two requests concurrently and preserves queue order", async () => {
        const pending = [deferred<AnalysisResult>(), deferred<AnalysisResult>()];
        const started: string[] = [];
        const runHost: AnalysisHostRunner = mock(async (request: NormalizedAnalysisRequest) => {
            started.push(request.id);
            if (request.id === "call-1") return pending[0].promise;
            if (request.id === "call-2") return pending[1].promise;
            return result;
        });
        const service = createAnalysisSandboxService({ runHost });

        const first = service.run({
            id: "call-1",
            language: "javascript",
            program: "export default 1",
        });
        const second = service.run({
            id: "call-2",
            language: "javascript",
            program: "export default 2",
        });
        const third = service.run({
            id: "call-3",
            language: "python",
            program: "result = 3",
        });
        await Bun.sleep(10);
        expect(started).toEqual(["call-1", "call-2"]);

        pending[0].resolve(result);
        await first;
        await Bun.sleep(10);
        expect(started).toEqual(["call-1", "call-2", "call-3"]);

        pending[1].resolve(result);
        await Promise.all([second, third]);
        await service.shutdown();
    });

    it("aborts active and queued requests on shutdown", async () => {
        const signals: AbortSignal[] = [];
        const runHost: AnalysisHostRunner = (
            _request: NormalizedAnalysisRequest,
            signal: AbortSignal,
        ) => {
            signals.push(signal);
            return new Promise((_resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("aborted")),
                    { once: true },
                );
            });
        };
        const service = createAnalysisSandboxService({ runHost });
        const active = service.run({
            id: "active",
            language: "javascript",
            program: "while (true) {}",
        });
        const secondActive = service.run({
            id: "second-active",
            language: "python",
            program: "while True: pass",
        });
        const queued = service.run({
            id: "queued",
            language: "javascript",
            program: "export default 1",
        });
        await Bun.sleep(10);

        await service.shutdown();

        await expect(active).rejects.toThrow("aborted");
        await expect(secondActive).rejects.toThrow("aborted");
        await expect(queued).rejects.toThrow("shut down");
        expect(signals).toHaveLength(2);
    });

    it("waits for aborted host runs to settle before shutdown resolves", async () => {
        const released = deferred<AnalysisResult>();
        let aborted = false;
        const service = createAnalysisSandboxService({
            runHost: async (_request, signal) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                    },
                    { once: true },
                );
                return released.promise;
            },
        });
        const active = service.run({
            id: "slow-host",
            language: "javascript",
            program: "export default 1",
        });
        await Bun.sleep(10);

        const shutdown = service.shutdown();
        let shutdownResolved = false;
        void shutdown.then(() => {
            shutdownResolved = true;
        });
        await Bun.sleep(10);
        expect(aborted).toBe(true);
        expect(shutdownResolved).toBe(false);

        released.reject(new Error("aborted"));
        await expect(active).rejects.toThrow("aborted");
        await shutdown;
        expect(shutdownResolved).toBe(true);
    });
});
