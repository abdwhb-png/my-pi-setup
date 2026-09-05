import { afterEach, describe, expect, it } from "bun:test";

import {
    createAnalysisSandboxService,
    type AnalysisSandboxService,
} from "./client.ts";

let service: AnalysisSandboxService | undefined;

afterEach(async () => {
    await service?.shutdown();
    service = undefined;
});

describe("strict analysis sandbox integration", () => {
    it("executes QuickJS and Eryx only through the outer sandbox", async () => {
        service = createAnalysisSandboxService();

        const javascript = await service.run({
            id: "integration-js",
            language: "javascript",
            program: "export default INPUT.length",
            bindings: { INPUT: "abcdef" },
            limits: { wallTimeMs: 15_000 },
        });
        const python = await service.run({
            id: "integration-python",
            language: "python",
            program: "result = int(INPUT) * 2",
            bindings: { INPUT: "21" },
            limits: { wallTimeMs: 15_000 },
        });

        expect(javascript).toMatchObject({
            output: "6",
            runtime: "quickjs",
            truncated: false,
        });
        expect(python).toMatchObject({
            output: "42",
            runtime: "python",
            truncated: false,
        });
    }, 20_000);

    it("executes TypeScript through the outer sandbox", async () => {
        service = createAnalysisSandboxService();

        const result = await service.run({
            id: "integration-typescript",
            language: "typescript",
            program:
                "const value: number = Number(INPUT) * 2; export default value",
            bindings: { INPUT: "21" },
            limits: { wallTimeMs: 15_000 },
        });

        expect(result).toMatchObject({
            output: "42",
            runtime: "quickjs",
            truncated: false,
        });
    }, 20_000);

    it("accepts logical output exactly at the configured byte cap", async () => {
        service = createAnalysisSandboxService();

        const result = await service.run({
            id: "integration-exact-output-cap",
            language: "typescript",
            program: "export default 'x'",
            limits: { wallTimeMs: 15_000, outputBytes: 1 },
        });

        expect(result.output).toBe("x");
    }, 20_000);

    it("exposes immutable structured INPUTS to TypeScript and Python", async () => {
        service = createAnalysisSandboxService();
        const inputs = [
            { id: "one", payload: { value: "original" } },
        ] as unknown as string;

        const typescript = await service.run({
            id: "integration-structured-typescript",
            language: "typescript",
            program: [
                "const item = INPUTS[0];",
                "try { item.payload.value = 'mutated'; } catch {}",
                "export default JSON.stringify({",
                "  array: Array.isArray(INPUTS),",
                "  frozenArray: Object.isFrozen(INPUTS),",
                "  frozenItem: Object.isFrozen(item),",
                "  frozenPayload: Object.isFrozen(item.payload),",
                "  value: item.payload.value,",
                "});",
            ].join("\n"),
            bindings: { INPUTS: inputs },
            limits: { wallTimeMs: 15_000 },
        });
        const python = await service.run({
            id: "integration-structured-python",
            language: "python",
            program: [
                "mutation = 'allowed'",
                "try:",
                "    INPUTS[0]['payload']['value'] = 'mutated'",
                "except Exception:",
                "    mutation = 'blocked'",
                "result = {",
                "    'tuple': isinstance(INPUTS, tuple),",
                "    'mutation': mutation,",
                "    'value': INPUTS[0]['payload']['value'],",
                "}",
            ].join("\n"),
            bindings: { INPUTS: inputs },
            limits: { wallTimeMs: 5_000 },
        });

        expect(JSON.parse(typescript.output)).toEqual(
            JSON.parse(
                '{"array":true,"frozenArray":true,"frozenItem":true,"frozenPayload":true,"value":"original"}',
            ),
        );
        expect(JSON.parse(python.output)).toEqual(
            JSON.parse(
                '{"tuple":true,"mutation":"blocked","value":"original"}',
            ),
        );
    }, 20_000);

    it("kills infinite loops and oversized output", async () => {
        service = createAnalysisSandboxService();

        await expect(
            service.run({
                id: "integration-timeout",
                language: "python",
                program: "while True: pass",
                limits: { wallTimeMs: 200, cpuSeconds: 1 },
            }),
        ).rejects.toThrow(/wall time|timed out|aborted|signal|killed/i);
        await expect(
            service.run({
                id: "integration-output",
                language: "javascript",
                program: "export default 'x'.repeat(10_000)",
                limits: { wallTimeMs: 5_000, outputBytes: 1_024 },
            }),
        ).rejects.toThrow(/output exceeds/i);
    }, 20_000);
});
