import { describe, expect, it } from "bun:test";

import {
    ANALYSIS_LIMITS,
    normalizeAnalysisRequest,
    parseAnalysisHostResponse,
    parseAnalysisRequest,
} from "./protocol.ts";

describe("analysis protocol", () => {
    it("maps languages to fixed workers and downward-clamps limits", () => {
        const javascript = normalizeAnalysisRequest({
            id: "call-1",
            language: "javascript",
            program: "export default INPUT.length",
            bindings: { INPUT: "hello" },
            limits: {
                wallTimeMs: 120_000,
                cpuSeconds: 90,
                memoryBytes: 4 * 1024 ** 3,
                outputBytes: 64 * 1024 ** 2,
            },
        });
        const python = normalizeAnalysisRequest({
            id: "call-2",
            language: "python",
            program: "result = len(INPUT)",
            bindings: { INPUT: "hello" },
        });

        expect(javascript.worker).toBe("quickjs");
        expect(javascript.limits).toEqual(ANALYSIS_LIMITS);
        expect(python.worker).toBe("python");
        expect(python.limits).toEqual(ANALYSIS_LIMITS);
    });

    it("preserves stricter caller limits", () => {
        const normalized = normalizeAnalysisRequest({
            id: "call-1",
            language: "typescript",
            program: "const answer: number = 42; export default answer",
            limits: {
                wallTimeMs: 1_000,
                cpuSeconds: 2,
                memoryBytes: 128 * 1024 ** 2,
                outputBytes: 4_096,
            },
        });

        expect(normalized.worker).toBe("quickjs");
        expect(normalized.limits).toEqual({
            wallTimeMs: 1_000,
            cpuSeconds: 2,
            memoryBytes: 128 * 1024 ** 2,
            outputBytes: 4_096,
            inputBytes: ANALYSIS_LIMITS.inputBytes,
        });
    });

    it("rejects malformed identities, bindings, and excessive input", () => {
        expect(() =>
            normalizeAnalysisRequest({
                id: "../escape",
                language: "javascript",
                program: "export default 1",
            }),
        ).toThrow("request id");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-1",
                language: "javascript",
                program: "export default 1",
                bindings: { "bad-key": "value" },
            }),
        ).toThrow("binding name");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-js-internal",
                language: "javascript",
                program: "export default 1",
                bindings: { env: 1 },
            }),
        ).toThrow("binding name");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-python-internal",
                language: "python",
                program: "result = 1",
                bindings: { __analysis_output: 1 },
            }),
        ).toThrow("binding name");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-js-keyword",
                language: "typescript",
                program: "export default 1",
                bindings: { class: 1 },
            }),
        ).toThrow("binding name");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-python-keyword",
                language: "python",
                program: "result = 1",
                bindings: { def: 1 },
            }),
        ).toThrow("binding name");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-1",
                language: "javascript",
                program: "x".repeat(ANALYSIS_LIMITS.inputBytes + 1),
            }),
        ).toThrow("input exceeds");
    });

    it("parses untrusted JSON without unsafe casts", () => {
        expect(
            parseAnalysisRequest({
                id: "call-1",
                language: "python",
                program: "result = 1",
                bindings: { INPUT: "value" },
            }),
        ).toMatchObject({ worker: "python", bindings: { INPUT: "value" } });
        expect(() => parseAnalysisRequest(null)).toThrow("request object");
        expect(
            parseAnalysisRequest({
                id: "call-1",
                language: "python",
                program: "result = 1",
                bindings: { INPUTS: [{ id: "one", payload: { value: 42 } }] },
            }),
        ).toMatchObject({
            bindings: { INPUTS: [{ id: "one", payload: { value: 42 } }] },
        });
        expect(() =>
            parseAnalysisRequest({
                id: "call-1",
                language: "python",
                program: "result = 1",
                bindings: { INPUT: (() => undefined) as unknown as string },
            }),
        ).toThrow("JSON-compatible");
    });

    it("validates untrusted host responses", () => {
        expect(
            parseAnalysisHostResponse({
                ok: true,
                result: {
                    output: "42",
                    stderr: "",
                    runtime: "quickjs",
                    durationMs: 10,
                    truncated: false,
                },
            }),
        ).toMatchObject({ ok: true, result: { output: "42" } });
        expect(() =>
            parseAnalysisHostResponse({ ok: true, result: { output: 42 } }),
        ).toThrow("host response");
    });

    it("rejects unsupported languages and non-positive limits", () => {
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-1",
                language: "ruby" as never,
                program: "puts 1",
            }),
        ).toThrow("language");
        expect(() =>
            normalizeAnalysisRequest({
                id: "call-1",
                language: "python",
                program: "result = 1",
                limits: { wallTimeMs: 0 },
            }),
        ).toThrow("wallTimeMs");
    });
});
