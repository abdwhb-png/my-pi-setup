import { describe, expect, it } from "bun:test";
import {
    belowMinTokens,
    countCodePoints,
    countUtf8Bytes,
    estimateTokens,
    fitsTokenBudget,
    isDenseScriptCodePoint,
    isSymbolCodePoint,
} from "./token-estimator";

describe("token-estimator", () => {
    describe("countCodePoints", () => {
        it("counts Unicode code points, not UTF-16 units", () => {
            expect(countCodePoints("")).toBe(0);
            expect(countCodePoints("hello")).toBe(5);
            // 😀 is U+1F600, a surrogate pair (2 UTF-16 units, 1 code point)
            expect(countCodePoints("😀")).toBe(1);
            expect(countCodePoints("😀😀")).toBe(2);
            // é is U+00E9, a single BMP code point
            expect(countCodePoints("café")).toBe(4);
        });
    });

    describe("countUtf8Bytes", () => {
        it("measures UTF-8 byte length, distinct from code points", () => {
            expect(countUtf8Bytes("")).toBe(0);
            expect(countUtf8Bytes("hello")).toBe(5);
            // 😀 encodes to 4 UTF-8 bytes
            expect(countUtf8Bytes("😀")).toBe(4);
            // é encodes to 2 UTF-8 bytes
            expect(countUtf8Bytes("café")).toBe(5);
        });
    });

    describe("isDenseScriptCodePoint", () => {
        it("classifies dense CJK/Kana/Hangul scripts", () => {
            expect(isDenseScriptCodePoint("你".codePointAt(0)!)).toBe(true);
            expect(isDenseScriptCodePoint("あ".codePointAt(0)!)).toBe(true);
            expect(isDenseScriptCodePoint("한".codePointAt(0)!)).toBe(true);
            expect(isDenseScriptCodePoint("Ａ".codePointAt(0)!)).toBe(true); // U+FF21 fullwidth
            expect(isDenseScriptCodePoint("a".codePointAt(0)!)).toBe(false);
            expect(isDenseScriptCodePoint("é".codePointAt(0)!)).toBe(false);
            expect(isDenseScriptCodePoint("😀".codePointAt(0)!)).toBe(false);
        });
    });

    describe("isSymbolCodePoint", () => {
        it("classifies astral emoji as symbols", () => {
            expect(isSymbolCodePoint("😀".codePointAt(0)!)).toBe(true);
            expect(isSymbolCodePoint("🚀".codePointAt(0)!)).toBe(true);
        });

        it("classifies BMP dingbats and misc symbols as symbols", () => {
            expect(isSymbolCodePoint("✅".codePointAt(0)!)).toBe(true); // U+2705
            expect(isSymbolCodePoint("❌".codePointAt(0)!)).toBe(true); // U+274C
            expect(isSymbolCodePoint("⚠".codePointAt(0)!)).toBe(true); // U+26A0
        });

        it("classifies variation selectors as symbols", () => {
            expect(isSymbolCodePoint(0xfe0f)).toBe(true);
        });

        it("does not classify ordinary text or dense CJK as symbols", () => {
            expect(isSymbolCodePoint("a".codePointAt(0)!)).toBe(false);
            expect(isSymbolCodePoint("你".codePointAt(0)!)).toBe(false);
            expect(isSymbolCodePoint("→".codePointAt(0)!)).toBe(false); // U+2192 arrow is not in symbol blocks
        });
    });

    describe("estimateTokens", () => {
        it("returns 0 for empty text", () => {
            expect(estimateTokens("")).toBe(0);
        });

        it("returns at least 1 for any non-empty text", () => {
            expect(estimateTokens("a")).toBe(1);
            expect(estimateTokens(" ")).toBe(1);
        });

        it("estimates ordinary ASCII at 3 code points per token", () => {
            // 11 ordinary code points -> ceil(11 / 3) = 4
            expect(estimateTokens("hello world")).toBe(4);
            // 3 ordinary code points -> ceil(3 / 3) = 1
            expect(estimateTokens("abc")).toBe(1);
            // 4 ordinary code points -> ceil(4 / 3) = 2
            expect(estimateTokens("abcd")).toBe(2);
        });

        it("treats accented Latin as ordinary code points", () => {
            // 4 ordinary code points (c,a,f,é) -> ceil(4 / 3) = 2
            expect(estimateTokens("café")).toBe(2);
        });

        it("prices dense CJK at 0.8 code points per token", () => {
            // 4 CJK code points -> ceil(4 / 0.8) = 5
            expect(estimateTokens("你好世界")).toBe(5);
        });

        it("prices Kana and Hangul as dense", () => {
            // 5 Kana -> ceil(5 / 0.8) = 7
            expect(estimateTokens("こんにちは")).toBe(7);
            // 5 Hangul -> ceil(5 / 0.8) = 7
            expect(estimateTokens("안녕하세요")).toBe(7);
        });

        it("prices each astral emoji as two tokens without splitting surrogates", () => {
            expect(estimateTokens("😀")).toBe(2);
            expect(estimateTokens("😀😀")).toBe(4);
        });

        it("prices BMP emoji as two tokens each", () => {
            expect(estimateTokens("✅")).toBe(2);
            expect(estimateTokens("✅✅")).toBe(4);
        });

        it("combines ordinary, dense, and emoji conservatively", () => {
            // "hello" (5 ordinary) + "😀" (1 symbol × 2)
            // = ceil(5/3 + 2) = ceil(3.666...) = 4
            expect(estimateTokens("hello😀")).toBe(4);
            // "你" (1 dense) + "a" (1 ordinary)
            // = ceil(1/0.8 + 1/3) = ceil(1.583...) = 2
            expect(estimateTokens("你a")).toBe(2);
        });
    });

    describe("fitsTokenBudget", () => {
        it("fits when tokens and bytes are both under budget", () => {
            expect(fitsTokenBudget("hello world", 100)).toBe(true);
            expect(fitsTokenBudget("hello world", 100, 1000)).toBe(true);
        });

        it("does not fit when tokens exceed the budget", () => {
            expect(fitsTokenBudget("hello world", 1)).toBe(false);
        });

        it("does not fit when bytes exceed the byte guard", () => {
            expect(fitsTokenBudget("hello world", 100, 3)).toBe(false);
        });

        it("fits without a byte guard regardless of byte size", () => {
            expect(fitsTokenBudget("😀😀😀😀😀", 100)).toBe(true);
        });
    });

    describe("belowMinTokens", () => {
        it("is true when estimated tokens are below the threshold", () => {
            expect(belowMinTokens("hello", 10)).toBe(true);
            expect(belowMinTokens("", 0)).toBe(false);
        });

        it("is false when estimated tokens reach or exceed the threshold", () => {
            expect(belowMinTokens("hello world", 4)).toBe(false);
            expect(belowMinTokens("hello world", 5)).toBe(true);
        });

        it("counts dense CJK against the same token threshold", () => {
            // 4 CJK code points → ceil(4 / 0.8) = 5 tokens
            expect(belowMinTokens("你好世界", 5)).toBe(false);
            expect(belowMinTokens("你好世界", 6)).toBe(true);
        });
    });

    describe("conservativeness against tiktoken", () => {
        // Ground truth captured from tiktoken 0.13.0 (cl100k_base + o200k_base).
        // The estimator must never under-count: a cap budget expressed in
        // estimated tokens must not exceed the model's real token cost.
        const cases: Array<{ text: string; cl100k: number; o200k: number }> = [
            { text: "你好世界", cl100k: 5, o200k: 2 },
            {
                text: "压缩层在替换之前归档原始输出，并保留恢复路径以便模型检索完整内容",
                cl100k: 37,
                o200k: 24,
            },
            { text: "✅ done 🚀 deployed 🎉 pass", cl100k: 11, o200k: 8 },
            { text: "⚠️ warn ❌ fail ✨ sparkle", cl100k: 11, o200k: 10 },
            { text: "hello😀你", cl100k: 4, o200k: 3 },
            {
                text: "result 0: ✅ done 🚀 deployed 🎉 pass ⚠️ warn ❌ fail 🔍 trace 🧪 test",
                cl100k: 30,
                o200k: 26,
            },
        ];

        for (const { text, cl100k, o200k } of cases) {
            it(`never under-counts ${JSON.stringify(text)}`, () => {
                const estimate = estimateTokens(text);
                expect(estimate).toBeGreaterThanOrEqual(cl100k);
                expect(estimate).toBeGreaterThanOrEqual(o200k);
            });
        }
    });
});
