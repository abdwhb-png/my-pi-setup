import { describe, expect, it } from "bun:test";
import { headTailCapTokens } from "./core";
import { countUtf8Bytes, estimateTokens } from "./token-estimator";

const HEAD_TAIL_SOURCE = [
    "HEAD",
    ...Array.from({ length: 100 }, (_, index) => `line-${index}`),
    "TAIL",
].join("\n");

function hasLoneSurrogate(text: string): boolean {
    for (const ch of text) {
        const codePoint = ch.codePointAt(0) ?? 0;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
    }
    return false;
}

describe("headTailCapTokens", () => {
    it("returns the original text unchanged when it fits the budget and byte guard", () => {
        const text = "short output";
        expect(headTailCapTokens(text, 100)).toBe(text);
        expect(headTailCapTokens(text, 100, 1000)).toBe(text);
    });

    it("keeps head and tail lines with an omission marker", () => {
        const result = headTailCapTokens(HEAD_TAIL_SOURCE, 40);
        expect(result).toContain("HEAD");
        expect(result).toContain("TAIL");
        expect(result).toContain("omitted by head/tail cap");
    });

    it("enforces the estimated-token budget on the final result", () => {
        const budget = 40;
        const result = headTailCapTokens(HEAD_TAIL_SOURCE, budget);
        expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    });

    it("cuts on whole lines, never mid-line", () => {
        const result = headTailCapTokens(HEAD_TAIL_SOURCE, 40);
        const sourceLines = new Set(HEAD_TAIL_SOURCE.split("\n"));
        for (const line of result.split("\n")) {
            // Empty lines are artefacts of the marker's surrounding newlines.
            if (line === "" || line.includes("omitted by head/tail cap"))
                continue;
            expect(sourceLines.has(line)).toBe(true);
        }
    });

    it("never splits Unicode surrogate pairs", () => {
        const emojiLine = `before 😀 after`;
        const source = [
            emojiLine,
            ...Array.from({ length: 80 }, (_, index) => `line-${index}`),
            emojiLine,
        ].join("\n");
        const result = headTailCapTokens(source, 40);
        expect(hasLoneSurrogate(result)).toBe(false);
        expect(result).toContain("😀");
    });

    it("treats maxBytes as a hard UTF-8 byte guard", () => {
        const maxBytes = 120;
        const result = headTailCapTokens(HEAD_TAIL_SOURCE, 1000, maxBytes);
        expect(countUtf8Bytes(result)).toBeLessThanOrEqual(maxBytes);
    });

    it("caps dense CJK text by token budget, not byte length", () => {
        // 60 CJK lines of 10 chars each: dense script prices at 1.5 code
        // points per token, so the token budget drives the cap even though
        // UTF-8 bytes per line are ~30.
        const cjk = Array.from(
            { length: 60 },
            (_, index) => `行${index}${"日本語のテスト"}${index}`,
        ).join("\n");
        const budget = 50;
        const result = headTailCapTokens(cjk, budget);
        expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    });
});
