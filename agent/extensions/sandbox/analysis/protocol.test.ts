import { describe, expect, it } from "bun:test";

import {
    ANALYSIS_AGGREGATE_INPUT_BYTES,
    ANALYSIS_LIMITS,
    ANALYSIS_PROGRAM_ALLOWANCE_BYTES,
    ANALYSIS_REQUEST_OVERHEAD_BYTES,
    ANALYSIS_SERIALIZED_REQUEST_BYTES,
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

    it("accepts an exact 64 MiB FILE_CONTENT payload but rejects one byte more", () => {
        const exact = "A".repeat(ANALYSIS_LIMITS.inputBytes);
        const programPrefix = "export default FILE_CONTENT.length;";
        const program = `${programPrefix}/*${"x".repeat(
            ANALYSIS_PROGRAM_ALLOWANCE_BYTES -
                Buffer.byteLength(programPrefix, "utf8") -
                4,
        )}*/`;
        expect(Buffer.byteLength(program, "utf8")).toBe(
            ANALYSIS_PROGRAM_ALLOWANCE_BYTES,
        );
        const normalized = normalizeAnalysisRequest({
            id: "file-exact",
            language: "javascript",
            program,
            bindings: {
                FILE_CONTENT: exact,
                FILE_PATH: `/${"p".repeat(4095)}`,
            },
        });
        expect(normalized.bindings.FILE_CONTENT).toBe(exact);
        expect(() =>
            normalizeAnalysisRequest({
                id: "file-over",
                language: "javascript",
                program: "export default FILE_CONTENT.length",
                bindings: {
                    FILE_CONTENT: `${exact}A`,
                    FILE_PATH: "/project/file.txt",
                },
            }),
        ).toThrow("input exceeds");
    });

    it("rejects multiple large bindings at the aggregate request boundary", () => {
        const large = "A".repeat(40 * 1024 * 1024);
        expect(() =>
            normalizeAnalysisRequest({
                id: "aggregate-over",
                language: "javascript",
                program: "export default [LEFT.length, RIGHT.length]",
                bindings: {
                    LEFT: large,
                    RIGHT: large,
                },
            }),
        ).toThrow("aggregate input exceeds");
    });

    it("bounds the fully serialized worker request including JSON escaping and framing", () => {
        expect(ANALYSIS_SERIALIZED_REQUEST_BYTES).toBe(
            ANALYSIS_AGGREGATE_INPUT_BYTES * 6 +
                ANALYSIS_REQUEST_OVERHEAD_BYTES,
        );
        const escaped = "\u0000".repeat(1024);
        const normalized = normalizeAnalysisRequest({
            id: "serialized-bound",
            language: "javascript",
            program: "export default CONTROL.length",
            bindings: { CONTROL: escaped },
        });
        const logicalBytes = Buffer.byteLength(escaped, "utf8");
        const serializedBytes = Buffer.byteLength(
            JSON.stringify(normalized),
            "utf8",
        );
        expect(serializedBytes).toBeGreaterThan(logicalBytes * 5);
        expect(serializedBytes).toBeLessThanOrEqual(
            ANALYSIS_SERIALIZED_REQUEST_BYTES,
        );
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
