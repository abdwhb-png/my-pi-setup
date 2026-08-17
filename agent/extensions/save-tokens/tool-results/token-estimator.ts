/**
 * Unicode-safe token estimation for deterministic local capping.
 *
 * This is a deliberate, self-contained estimator — it is NOT a copy of the
 * Headroom estimator, though the dense-script code-point ranges mirror
 * Headroom's `is_dense_script` / `CJK_PATTERN` so the two agree on which
 * scripts are "dense". The ratio is more conservative (3 vs Headroom's 4)
 * so pre-backend caps stay safely under real tokenizer counts.
 *
 * Everything iterates by Unicode code point (`for...of`), never by UTF-16
 * code unit (`String.prototype.length` / `slice`), so surrogate pairs are
 * never split.
 */

/** Ordinary text/code/path/JSON: ~3 Unicode code points per token. */
export const ORDINARY_CODE_POINTS_PER_TOKEN = 3;

/** CJK / Kana / Hangul / full-width: ~1.5 code points per token. */
export const DENSE_CODE_POINTS_PER_TOKEN = 1.5;

/**
 * True for a "dense-script" code point (CJK ideographs + punctuation, Kana,
 * Hangul, CJK compatibility, half/full-width forms, CJK Ext-A/B). Ranges kept
 * byte-identical with Headroom's `is_dense_script` / `EstimatingTokenCounter.
 * CJK_PATTERN` so dense-script classification stays consistent across layers.
 */
export function isDenseScriptCodePoint(codePoint: number): boolean {
    return (
        (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK symbols and punctuation
        (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Ext A
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
        (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
        (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
        (codePoint >= 0xff00 && codePoint <= 0xffef) || // Half/full-width forms
        (codePoint >= 0x20000 && codePoint <= 0x2a6df) // CJK Unified Ideographs Ext B
    );
}

/** Number of Unicode code points (surrogate pairs counted once). */
export function countCodePoints(text: string): number {
    let count = 0;
    // `for...of` iterates by code point, not UTF-16 code unit.
    for (const _ch of text) {
        count += 1;
    }
    return count;
}

/** UTF-8 byte length — a storage/transport metric, distinct from token count. */
export function countUtf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Conservative estimated token count.
 *
 * ```text
 * estimatedTokens = max(1, ceil(
 *     denseCodePoints / 1.5        // CJK/Kana/Hangul/full-width
 *   + astralEmojiCodePoints * 1    // astral non-dense (emoji/symbols)
 *   + ordinaryCodePoints / 3       // everything else (BMP non-dense)
 * ))
 * ```
 *
 * Astral non-dense code points (emoji, misc symbols) are priced at a minimum
 * of one token each — conservative, and safe against grapheme-cluster
 * ambiguity. Iteration is by code point, so surrogate pairs never split.
 */
export function estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    let dense = 0;
    let astral = 0;
    let ordinary = 0;
    for (const ch of text) {
        const codePoint = ch.codePointAt(0) ?? 0;
        if (isDenseScriptCodePoint(codePoint)) {
            dense += 1;
        } else if (codePoint > 0xffff) {
            astral += 1;
        } else {
            ordinary += 1;
        }
    }
    const estimate = Math.ceil(
        dense / DENSE_CODE_POINTS_PER_TOKEN +
            astral +
            ordinary / ORDINARY_CODE_POINTS_PER_TOKEN,
    );
    return Math.max(1, estimate);
}
