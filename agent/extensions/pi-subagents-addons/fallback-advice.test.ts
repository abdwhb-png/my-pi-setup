import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFailedModelAdvice, parseFallbackAdviceConfig } from "./fallback-advice.ts";

test("advises ordered alternatives only for a child provider error before useful work", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-advice-"));
    const parentFile = join(root, "parent.jsonl");
    const sessionFile = join(root, "parent", "run-123", "run-0", "session.jsonl");
    mkdirSync(join(root, "parent", "run-123", "run-0"), { recursive: true });
    writeFileSync(parentFile, "");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", provider: "test-provider", model: "broken-model", stopReason: "error", errorMessage: "upstream unavailable", content: [] } })}\n`);
    try {
        const advice = findFailedModelAdvice({ mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", exitCode: 1, error: "upstream unavailable", model: "test-provider/broken-model", progressSummary: { toolCount: 0 }, sessionFile }] }, parentFile, { worker: ["test-provider/second", "test-provider/third"] });
        expect(advice).toEqual([{ runId: "run-123", index: 0, agent: "worker", failedModel: "test-provider/broken-model", candidates: ["test-provider/second", "test-provider/third"] }]);
        expect(findFailedModelAdvice({ mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", exitCode: 0, model: "test-provider/broken-model", progressSummary: { toolCount: 0 }, sessionFile }] }, parentFile, { worker: ["test-provider/second"] })).toEqual([]);
        expect(findFailedModelAdvice({ mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", error: "failure", runner: { type: "external-cli" }, progressSummary: { toolCount: 0 }, sessionFile }] }, parentFile, { worker: ["test-provider/second"] })).toEqual([]);
        expect(findFailedModelAdvice({ mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", error: "failure", progressSummary: { toolCount: 0 }, sessionFile }] }, parentFile, { worker: ["test-provider/second"] })).toEqual([]);
        expect(findFailedModelAdvice({ mode: "single", runId: "run-123", sessionId: "parent-id", results: [{ index: 0, agent: "worker", success: false, error: "failure", outputState: "absent", model: "test-provider/broken-model", sessionFile }] }, parentFile, { worker: ["test-provider/second", "test-provider/third"] })).toEqual([{ runId: "run-123", index: 0, agent: "worker", failedModel: "test-provider/broken-model", candidates: ["test-provider/second", "test-provider/third"] }]);
        expect(findFailedModelAdvice({ mode: "workflow", runId: "run-123", sessionId: "parent-id", results: [{ index: 0, agent: "worker", success: false, error: "failure", outputState: "absent", model: "test-provider/broken-model" }] }, parentFile, { worker: ["test-provider/second"] })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("does not advise after partial assistant reasoning or tool activity", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-unsafe-"));
    const parentFile = join(root, "parent.jsonl");
    const sessionFile = join(root, "parent", "run-123", "run-0", "session.jsonl");
    mkdirSync(join(root, "parent", "run-123", "run-0"), { recursive: true });
    writeFileSync(parentFile, "");
    const failed = { type: "message", message: { role: "assistant", provider: "p", model: "broken", stopReason: "error", errorMessage: "provider unavailable", content: [] } };
    const details = { mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", exitCode: 1, error: "failure", progressSummary: { toolCount: 0 }, sessionFile }] };
    try {
        for (const earlier of [
            { type: "message", message: { role: "assistant", provider: "p", model: "broken", stopReason: "error", errorMessage: "partial", content: [{ type: "thinking", thinking: "I made a decision" }] } },
            { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "changed files" }] } },
        ]) {
            writeFileSync(sessionFile, `${JSON.stringify(earlier)}\n${JSON.stringify(failed)}\n`);
            expect(findFailedModelAdvice(details, parentFile, { worker: ["p/second"] })).toEqual([]);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test.each(["parallel", "workflow"] as const)("%s uses stable child index, not result row position", mode => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-fanout-"));
    const parentFile = join(root, "parent.jsonl");
    const sessionFile = join(root, "parent", "run-123", "run-1", "session.jsonl");
    mkdirSync(join(root, "parent", "run-123", "run-1"), { recursive: true });
    writeFileSync(parentFile, "");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "failed", stopReason: "error", errorMessage: "request failed", content: [] } })}\n`);
    try {
        const results = [
            { index: 0, agent: "worker", exitCode: 0, progressSummary: { toolCount: 0 } },
            { index: 1, workflowKey: "review", agent: "reviewer", exitCode: 1, error: "request failed", model: "p/failed", progressSummary: { toolCount: 0 }, sessionFile },
        ];
        expect(findFailedModelAdvice({ mode, runId: "run-123", results }, parentFile, { worker: ["p/worker"], reviewer: ["p/second"] })).toEqual([
            { runId: "run-123", index: 1, agent: "reviewer", failedModel: "p/failed", candidates: ["p/second"] },
        ]);
        expect(findFailedModelAdvice({ mode, runId: "../escape", results }, parentFile, { reviewer: ["p/second"] })).toEqual([]);
        expect(findFailedModelAdvice({ mode, runId: "run-123", results: [{ ...results[1], sessionFile: parentFile }] }, parentFile, { reviewer: ["p/second"] })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("rejects dot-segment run identifiers before deriving transcript path", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-path-"));
    const parentFile = join(root, "parent.jsonl");
    const escapedFile = join(root, "run-0", "session.jsonl");
    mkdirSync(join(root, "run-0"), { recursive: true });
    writeFileSync(parentFile, "");
    writeFileSync(escapedFile, `${JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "broken", stopReason: "error", errorMessage: "failed", content: [] } })}\n`);
    try {
        expect(findFailedModelAdvice({ mode: "single", runId: "..", results: [{ index: 0, agent: "worker", exitCode: 1, error: "failed", progressSummary: { toolCount: 0 }, sessionFile: escapedFile }] }, parentFile, { worker: ["p/second"] })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validates ordered fallback lists without selecting a model", () => {
    expect(parseFallbackAdviceConfig({ enabled: true, fallbackModels: { worker: ["p/one", "p/two"] } })).toEqual({ enabled: true, fallbackModels: { worker: ["p/one", "p/two"] } });
    expect(() => parseFallbackAdviceConfig({ enabled: true, fallbackModels: { worker: ["p/one", "p/one"] } })).toThrow();
    expect(() => parseFallbackAdviceConfig({ enabled: true, fallbackModels: { worker: [""] } })).toThrow();
});
