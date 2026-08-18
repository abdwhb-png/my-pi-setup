/**
 * Unicode-safe token estimation for deterministic local capping.
 *
 * This is a deliberate, self-contained estimator — it is NOT a copy of the
 * Headroom estimator, though the dense-script code-point ranges mirror
 * Headroom's `is_dense_script` / `CJK_PATTERN` so the two agree on which
 * scripts are "dense".
 *
 * The ratios are calibrated against tiktoken (`cl100k_base` + `o200k_base`)
 * so the estimator is conservative (≥) on dense CJK and emoji — the two
 * content classes that plain character counting under-counts the most. See
 * `benchmarks/reports/token-calibration.md`.
 *
 * Everything iterates by Unicode code point (`for...of`), never by UTF-16
 * code unit (`String.prototype.length` / `slice`), so surrogate pairs are
 * never split.
 */

/** Ordinary text/code/path/JSON: ~3 Unicode code points per token. */
export const ORDINARY_CODE_POINTS_PER_TOKEN = 3;

/**
 * CJK / Kana / Hangul / full-width: ~0.8 code points per token.
 *
 * Calibrated against `cl100k_base`, which prices common CJK ideographs at up
 * to ~1.25 tokens per code point — the most token-hungry of the measured
 * tokenizers. This deliberately over-counts relative to `o200k_base` (~2×
 * cheaper) so a cap budget is never under-estimated for dense scripts.
 */
export const DENSE_CODE_POINTS_PER_TOKEN = 0.8;

/**
 * Emoji and symbols are priced at a flat 2 tokens per code point, matching
 * tiktoken's typical 2+ tokens for a single emoji (BMP or astral).
 */
export const SYMBOL_TOKENS_PER_CODE_POINT = 2;

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

/**
 * True for a code point that tokenizers price as an emoji/symbol — i.e.
 * multiple BPE tokens each — rather than as ordinary text.
 *
 * Covers every non-dense astral code point (emoji, pictographs, transport, and
 * other symbol planes; CJK Ext B is already classified dense and never reaches
 * this branch) plus the BMP symbol/dingbat blocks and variation selectors.
 */
export function isSymbolCodePoint(codePoint: number): boolean {
    if (codePoint > 0xffff) return true;
    return (
        // Miscellaneous Symbols (☀ ⚠ ☂ ☎ …)
        (codePoint >= 0x2600 && codePoint <= 0x26ff) ||
        // Dingbats (✅ ❌ ✨ ⭐ …)
        (codePoint >= 0x2700 && codePoint <= 0x27bf) ||
        // Variation selectors (emoji presentation)
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
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
 * Estimated token count, calibrated to be conservative (≥) against tiktoken's
 * `cl100k_base` on dense CJK and emoji.
 *
 * ```text
 * estimatedTokens = max(1, ceil(
 *     denseCodePoints / 0.8   // CJK/Kana/Hangul/full-width
 *   + symbolCodePoints * 2    // emoji/symbols (BMP + astral)
 *   + ordinaryCodePoints / 3  // everything else (ASCII + Latin + other BMP)
 * ))
 * ```
 *
 * Iteration is by code point, so surrogate pairs never split.
 */
export function estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    let dense = 0;
    let symbol = 0;
    let ordinary = 0;
    for (const ch of text) {
        const codePoint = ch.codePointAt(0) ?? 0;
        if (isDenseScriptCodePoint(codePoint)) {
            dense += 1;
        } else if (isSymbolCodePoint(codePoint)) {
            symbol += 1;
        } else {
            ordinary += 1;
        }
    }
    const estimate = Math.ceil(
        dense / DENSE_CODE_POINTS_PER_TOKEN +
            symbol * SYMBOL_TOKENS_PER_CODE_POINT +
            ordinary / ORDINARY_CODE_POINTS_PER_TOKEN,
    );
    return Math.max(1, estimate);
}

/**
 * True when `text` fits both an estimated-token budget and (optionally) a
 * UTF-8 byte ceiling. Single source of truth for the "does this fit?" checks
 * shared by the deterministic cap and the input threshold, so they never drift.
 */
export function fitsTokenBudget(
    text: string,
    budgetTokens: number,
    maxBytes?: number,
): boolean {
    if (estimateTokens(text) > budgetTokens) return false;
    return maxBytes === undefined || countUtf8Bytes(text) <= maxBytes;
}

/**
 * True when `text` is below the minimum estimated-token threshold — i.e. too
 * small to be worth compressing.
 */
export function belowMinTokens(text: string, minTokens: number): boolean {
    return estimateTokens(text) < minTokens;
}
