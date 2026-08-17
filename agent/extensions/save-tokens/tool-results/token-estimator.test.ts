import { describe, expect, it } from "bun:test";
import {
    countCodePoints,
    countUtf8Bytes,
    estimateTokens,
    isDenseScriptCodePoint,
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

        it("prices dense CJK at 1.5 code points per token", () => {
            // 4 CJK code points -> ceil(4 / 1.5) = 3
            expect(estimateTokens("你好世界")).toBe(3);
        });

        it("prices Kana and Hangul as dense", () => {
            // 5 Kana -> ceil(5 / 1.5) = 4
            expect(estimateTokens("こんにちは")).toBe(4);
            // 5 Hangul -> ceil(5 / 1.5) = 4
            expect(estimateTokens("안녕하세요")).toBe(4);
        });

        it("counts each astral emoji as one token without splitting surrogates", () => {
            expect(estimateTokens("😀")).toBe(1);
            expect(estimateTokens("😀😀")).toBe(2);
        });

        it("combines ordinary, dense, and emoji conservatively", () => {
            // "hello" (5 ordinary) + "😀" (1 emoji)
            // = ceil(5/3 + 1) = ceil(2.666...) = 3
            expect(estimateTokens("hello😀")).toBe(3);
            // "你" (1 dense) + "a" (1 ordinary)
            // = ceil(1/1.5 + 1/3) = ceil(1.0) = 1
            expect(estimateTokens("你a")).toBe(1);
        });
    });
});
