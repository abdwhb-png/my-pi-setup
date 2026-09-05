import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import type { AnalysisRequest } from "../../_shared/sandbox-runtime/analysis-protocol.ts";

type PythonWorkerResponse =
    | { ok: true; result: { output: string; stderr: string } }
    | { ok: false; error: string };

const workerPath = fileURLToPath(
    new URL("./python-worker.mjs", import.meta.url),
);
const loaderPath = fileURLToPath(
    new URL("./eryx-loader.mjs", import.meta.url),
);

async function runPythonWorker(
    request: AnalysisRequest,
): Promise<PythonWorkerResponse> {
    const child = Bun.spawn(
        [
            "node",
            "--experimental-wasm-jspi",
            "--experimental-loader",
            loaderPath,
            workerPath,
        ],
        {
            cwd: import.meta.dir,
            env: { PATH: process.env.PATH ?? "" },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout) as PythonWorkerResponse;
}

describe("Eryx Python analysis worker", () => {
    it("executes Python with explicit bindings", async () => {
        const response = await runPythonWorker({
            id: "python-1",
            language: "python",
            program: "result = int(INPUT) * 2",
            bindings: { INPUT: "21" },
        });

        expect(response).toEqual({
            ok: true,
            result: {
                output: "42",
                stderr: "",
            },
        });
    });

    it("maps every public JSON binding type to immutable Python values", async () => {
        const response = await runPythonWorker({
            id: "python-json-bindings",
            language: "python",
            program: [
                "result = {",
                "    'truth': TRUTH,",
                "    'falsehood': FALSEHOOD,",
                "    'nothing': NOTHING,",
                "    'nested': NESTED,",
                "    'tuple': isinstance(NESTED, tuple),",
                "    'mapping': isinstance(NESTED[1], __import__('collections.abc').abc.Mapping),",
                "    'ior': 'pending',",
                "    'descriptor': 'pending',",
                "}",
                "try:",
                "    NESTED[1] |= {'extra': True}",
                "except Exception:",
                "    result['ior'] = 'blocked'",
                "try:",
                "    dict.__setitem__(NESTED[1], 'extra', True)",
                "except Exception:",
                "    result['descriptor'] = 'blocked'",
            ].join("\n"),
            bindings: {
                TRUTH: true,
                FALSEHOOD: false,
                NOTHING: null,
                NESTED: [1, { value: null }],
            },
        });

        expect(response).toEqual({
            ok: true,
            result: {
                output: JSON.stringify({
                    truth: true,
                    falsehood: false,
                    nothing: null,
                    nested: [1, { value: null }],
                    tuple: true,
                    mapping: true,
                    ior: "blocked",
                    descriptor: "blocked",
                }),
                stderr: "",
            },
        });
    });

    it("cannot access host files or subprocesses", async () => {
        const response = await runPythonWorker({
            id: "python-isolation",
            language: "python",
            program: [
                "checks = {}",
                "try:",
                "    open('/etc/passwd').read()",
                "    checks['filesystem'] = 'exposed'",
                "except Exception:",
                "    checks['filesystem'] = 'blocked'",
                "try:",
                "    import subprocess",
                "    subprocess.run(['/bin/true'])",
                "    checks['subprocess'] = 'exposed'",
                "except Exception:",
                "    checks['subprocess'] = 'blocked'",
                "result = checks",
            ].join("\n"),
        });

        expect(response).toEqual({
            ok: true,
            result: {
                output: JSON.stringify({
                    filesystem: "blocked",
                    subprocess: "blocked",
                }),
                stderr: "",
            },
        });
    });

    it("fails closed on network access", async () => {
        const response = await runPythonWorker({
            id: "python-network",
            language: "python",
            program: [
                "import urllib.request",
                "result = urllib.request.urlopen('http://127.0.0.1:9', timeout=0.1).read()",
            ].join("\n"),
        });

        expect(response.ok).toBe(false);
        if (response.ok) throw new Error("network access unexpectedly passed");
        expect(response.error).toMatch(/resource|network|not valid/i);
    });

    it("enforces the UTF-8 output budget before serializing a response", async () => {
        const response = await runPythonWorker({
            id: "python-output-cap",
            language: "python",
            program: "result = 'abc'",
            limits: { outputBytes: 2 },
        });

        expect(response).toEqual({
            ok: false,
            error: "Analysis output exceeds 2 bytes",
        });
    });

    it("interrupts streamed output as soon as it crosses the cap", async () => {
        const response = await runPythonWorker({
            id: "python-streaming-output-cap",
            language: "python",
            program: "print('abc')\nraise Exception('execution continued')",
            limits: { outputBytes: 2 },
        });

        expect(response).toEqual({
            ok: false,
            error: "Analysis output exceeds 2 bytes",
        });
    });

    it("bounds structured result serialization inside Python", async () => {
        const response = await runPythonWorker({
            id: "python-structured-output-cap",
            language: "python",
            program: "result = ['x'] * 10000",
            limits: { outputBytes: 32 },
        });

        expect(response).toEqual({
            ok: false,
            error: "Analysis output exceeds 32 bytes",
        });
    });

    it("applies one global cap across streamed logs and the result", async () => {
        const response = await runPythonWorker({
            id: "python-combined-output-cap",
            language: "python",
            program: "print('a', end='')\nresult = 'bc'",
            limits: { outputBytes: 2 },
        });

        expect(response).toEqual({
            ok: false,
            error: "Analysis output exceeds 2 bytes",
        });
    });
});
