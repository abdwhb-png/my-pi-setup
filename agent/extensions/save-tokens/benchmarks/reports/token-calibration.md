# Token-estimator calibration

Ground truth: `tiktoken` 0.13.0 (`cl100k_base` + `o200k_base`).
Estimator: local `estimateTokens` (ordinary /3, dense /0.8, symbol *2).

## Per-fixture

| fixture | category | utf8 bytes | estimate | cl100k | o200k | est/bytes | cl100k/bytes | o200k/bytes | est÷cl100k | est÷o200k |
|---|---|---|---|---|---|---|---|---|---|---|
| ascii_code_ts | ascii_code | 66689 | 22230 | 16800 | 16800 | 0.333 | 0.252 | 0.252 | 1.323 | 1.323 |
| latin_prose_en | latin_prose | 11219 | 3740 | 1800 | 1800 | 0.333 | 0.160 | 0.160 | 2.078 | 2.078 |
| latin_prose_fr | latin_prose | 9599 | 3140 | 1920 | 1620 | 0.327 | 0.200 | 0.169 | 1.635 | 1.938 |
| cjk_zh | cjk | 34499 | 14350 | 12600 | 8400 | 0.416 | 0.365 | 0.243 | 1.139 | 1.708 |
| emoji_heavy | emoji | 6869 | 2823 | 2479 | 2159 | 0.411 | 0.361 | 0.314 | 1.139 | 1.308 |
| mixed_code_cjk_emoji | mixed | 7309 | 2717 | 2519 | 2160 | 0.372 | 0.345 | 0.296 | 1.079 | 1.258 |
| json_output | json | 15599 | 5200 | 4861 | 4861 | 0.333 | 0.312 | 0.312 | 1.070 | 1.070 |
| logs_mixed | logs | 16445 | 5482 | 6357 | 6357 | 0.333 | 0.387 | 0.387 | 0.862 | 0.862 |
| find_listing | find_listing | 32289 | 10763 | 7599 | 7199 | 0.333 | 0.235 | 0.223 | 1.416 | 1.495 |

## Per-category (mean estimator ÷ real)

`> 1.0` = estimator is conservative (over-counts) → safe.

| category | est÷cl100k | est÷o200k |
|---|---|---|
| ascii_code | 1.323 | 1.323 |
| latin_prose | 1.857 | 2.008 |
| cjk | 1.139 | 1.708 |
| emoji | 1.139 | 1.308 |
| mixed | 1.079 | 1.258 |
| json | 1.070 | 1.070 |
| logs | 0.862 | 0.862 |
| find_listing | 1.416 | 1.495 |

## Default derivation

Old byte thresholds ÷3 (the established ASCII equivalence, where 1 token ≈ 3 bytes) → rounded token thresholds:

| group | old bytes | ÷3 | rounded default |
|---|---|---|---|
| shell | 4096 | 1365 | 1400 |
| read | 8192 | 2731 | 2700 |
| search | 4096 | 1365 | 1400 |

For ASCII tool output the estimator over-counts (est÷real ≥ 1.07 across code/prose/json/find), so these token thresholds trigger compression at ≥ the old byte thresholds — no regression in eagerness for the dominant case.

## Findings and recommendations

The estimator is **conservative (≥)** against `cl100k_base` for every
content class except digit/punctuation-dense logs:

- **Conservative:** ascii_code (1.32×), latin_prose (1.86–2.0×), cjk (1.14×), emoji (1.14×), mixed (1.08×), json (1.07×), find_listing (1.42–1.50×).
- **Under-counts:** logs_mixed (0.86×) — timestamps, ids, and status codes price more token-dense than plain letters, and the estimator does not yet special-case digits/punctuation.

The CJK and emoji gaps (previously 0.61× and 0.80×) are closed by pricing dense scripts at 0.8 code points per token and symbols at 2 tokens each. The remaining logs gap (~14% on digit-heavy ASCII) is a known, smaller residual: fixing it would require a digit/punctuation-dense heuristic that risks over-counting JSON and code.

**Decision:** freeze `minTokensByGroup` defaults at `1400 / 2700 / 1400`. Track the logs residual as a separate follow-up rather than fold a digit heuristic into this estimator.