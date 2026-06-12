# Usage Extension

Created: 2026-06-12
Location: `extensions/usage/`
Old file deleted: `extensions/usage.ts`

## Architecture
- **Programmatic** — zero LLM involvement. All pure TypeScript/Node.js.
- **Widget display** — uses `ctx.ui.setWidget()` (not `sendUserMessage`), auto-dismisses after 30s.
- **4 time windows**: 1/7/30/90 days.

## Files
| File | Purpose |
|------|---------|
| `types.ts` | UsageRecord, TimeWindowReport, ModelRates interfaces |
| `scanner.ts` | Walks session dirs, parses JSONL, extracts assistant messages with usage |
| `aggregator.ts` | Filters by time windows, groups by model key, sums tokens/costs |
| `pricing.ts` | Looks up model pricing from models.dev API with local cache |
| `format.ts` | Renders ANSI-colored tables for widget display |
| `session.ts` | UsageReportWidget Component for TUI widget |
| `index.ts` | Extension entry: registers `/usage` command |
| `usage.test.ts` | 28 tests, all passing |

## Key Design Decisions
- Widget not message: `ctx.ui.setWidget()` avoids triggering an LLM turn
- Cost data comes from session JSONL (already computed by pi), not recomputed from pricing
- Pricing from models.dev is secondary info (shown in notes, not used for cost calculation)
- ANSI color constants like pi-subagents-overview, not theme-based
