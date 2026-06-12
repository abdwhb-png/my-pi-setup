/**
 * format.ts — Rendering engine for usage reports
 *
 * Converts UsageReport into ANSI-colored strings for widget display.
 * Pure functions, no side effects, no external imports.
 */

import type { UsageReport, TimeWindowReport, ModelUsageAggregate } from "./types";

// ── ANSI color constants (like pi-subagents-overview) ──

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

// ── Column widths ──────────────────────────────────────

const COL_SOURCE = 16;
const COL_MODEL = 20;
const COL_MSGS = 8;
const COL_INPUT = 12;
const COL_OUTPUT = 12;
const COL_CACHED = 10;
const COL_TOTAL = 14;
const COL_PRICE = 14;

// ── Helpers ────────────────────────────────────────────

/**
 * Format a number with commas: 15302 → "15,302"
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format USD amount. Uses 4 decimals for small amounts (< $1),
 * 2 decimals for larger amounts.
 */
export function formatUSD(amount: number): string {
  if (amount < 1) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

/**
 * Right-pad a string to at least `width` characters.
 */
function padLeft(s: string, width: number): string {
  return s.padStart(width);
}

/**
 * Left-pad a string to at least `width` characters.
 */
function padRight(s: string, width: number): string {
  return s.padEnd(width);
}

// ── Separator line ─────────────────────────────────────

function separatorLine(columnCount: number): string {
  const totalWidth =
    columnCount +
    COL_SOURCE +
    COL_MODEL +
    COL_MSGS +
    COL_INPUT +
    COL_OUTPUT +
    COL_CACHED +
    COL_TOTAL +
    COL_PRICE;
  return `  ${DIM}${"─".repeat(totalWidth)}${RESET}`;
}

// ── Table header ───────────────────────────────────────

function tableHeaderRow(): string {
  const src = padRight("Source", COL_SOURCE);
  const mdl = padRight("Model", COL_MODEL);
  const msg = padLeft("Msgs", COL_MSGS);
  const inp = padLeft("Input", COL_INPUT);
  const out = padLeft("Output", COL_OUTPUT);
  const cah = padLeft("Cached", COL_CACHED);
  const tot = padLeft("Total", COL_TOTAL);
  const prc = padLeft("Price", COL_PRICE);
  return `  ${BOLD}${src}  ${mdl}  ${msg}  ${inp}  ${out}  ${cah}  ${tot}  ${prc}${RESET}`;
}

// ── Model row ──────────────────────────────────────────

function modelRow(m: ModelUsageAggregate): string {
  const src = padRight(m.provider, COL_SOURCE);
  const mdl = padRight(m.model, COL_MODEL);
  const msg = padLeft(formatNumber(m.messageCount), COL_MSGS);
  const inp = padLeft(formatNumber(m.input), COL_INPUT);
  const out = padLeft(formatNumber(m.output), COL_OUTPUT);
  const cah = padLeft(formatNumber(m.cacheRead), COL_CACHED);
  const tot = padLeft(formatNumber(m.totalTokens), COL_TOTAL);
  const prc = padLeft(formatUSD(m.cost), COL_PRICE);
  return `  ${src}  ${mdl}  ${msg}  ${inp}  ${out}  ${cah}  ${tot}  ${prc}`;
}

// ── Totals row ─────────────────────────────────────────

function totalsRow(w: TimeWindowReport): string {
  const src = padRight("TOTAL", COL_SOURCE);
  const mdl = padRight("", COL_MODEL);
  const msg = padLeft(formatNumber(w.totalMessages), COL_MSGS);
  const inp = padLeft(formatNumber(w.totalInput), COL_INPUT);
  const out = padLeft(formatNumber(w.totalOutput), COL_OUTPUT);
  const cah = padLeft(formatNumber(w.totalCacheRead), COL_CACHED);
  const tot = padLeft(formatNumber(w.totalTokens), COL_TOTAL);
  const prc = padLeft(formatUSD(w.totalCost), COL_PRICE);
  return `  ${BOLD}${src}  ${mdl}  ${msg}  ${inp}  ${out}  ${cah}  ${tot}  ${prc}${RESET}`;
}

// ── Window renderer ────────────────────────────────────

/**
 * Render a single time window table.
 */
export function renderWindow(window: TimeWindowReport): string[] {
  const lines: string[] = [];

  // Header
  lines.push(`  ${CYAN}${BOLD}📈 ${window.label}${RESET}`);

  if (window.models.length === 0) {
    lines.push(`  ${DIM}No usage data in this period.${RESET}`);
    lines.push("");
    return lines;
  }

  // Sort models by cost descending
  const sorted = [...window.models].sort((a, b) => b.cost - a.cost);

  // Table
  lines.push(tableHeaderRow());
  lines.push(separatorLine(0));

  for (const m of sorted) {
    lines.push(modelRow(m));
  }

  lines.push(separatorLine(0));
  lines.push(totalsRow(window));
  lines.push("");

  return lines;
}

// ── Full report renderer ───────────────────────────────

/**
 * Render a complete usage report into an array of ANSI-colored strings
 * suitable for widget display.
 */
export function renderReport(report: UsageReport): string[] {
  const lines: string[] = [];

  // Title box
  lines.push(`  ${BOLD}╔══════════════════════════════════════════════════╗${RESET}`);
  const title = "📊  Pi Usage Report";
  // Center title in the box (50 chars wide, minus 2 for borders)
  const padLeftBox = Math.max(0, Math.floor((50 - title.length) / 2));
  lines.push(`  ${BOLD}║${RESET}${" ".repeat(padLeftBox)}${title}${" ".repeat(50 - title.length - padLeftBox)}${BOLD}║${RESET}`);
  lines.push(`  ${BOLD}╚══════════════════════════════════════════════════╝${RESET}`);
  lines.push("");

  // Each window
  for (const window of report.windows) {
    lines.push(...renderWindow(window));
  }

  // Pricing notes (only if present)
  if (report.pricingNotes.length > 0) {
    lines.push(`  ${DIM}${"─".repeat(50)}${RESET}`);
    lines.push(`  ${YELLOW}📝 Pricing Notes${RESET}`);
    for (const note of report.pricingNotes) {
      lines.push(`  ${DIM}•${RESET} ${note}`);
    }
    lines.push("");
  }

  return lines;
}