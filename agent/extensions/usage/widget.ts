import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageReport } from "./types";
import { renderBoxHeader, renderBoxFooter } from "../shared/box";

type Tab = "short" | "long";

interface UsageReportState {
  activeTab: Tab;
  scrollOffset: number;
}

export class UsageReportWidget implements Component {
  private state: UsageReportState;

  constructor(
    private config: {
      theme: Theme;
      report: UsageReport;
      done: () => void;
    }
  ) {
    this.state = {
      activeTab: "short",
      scrollOffset: 0,
    };
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.config.done();
      return;
    }

    const isLeft = data === "ArrowLeft" || data === "\x1b[D" || data === "h";
    const isRight = data === "ArrowRight" || data === "\x1b[C" || data === "l";

    if (data === "\t" || data === "1" || isLeft) {
      this.state = { ...this.state, activeTab: "short", scrollOffset: 0 };
      return;
    }
    if (data === "2" || isRight) {
      this.state = { ...this.state, activeTab: "long", scrollOffset: 0 };
      return;
    }

    const isUp = data === "ArrowUp" || data === "\x1b[A" || data === "\x1bOA" || data === "k";
    const isDown = data === "ArrowDown" || data === "\x1b[B" || data === "\x1bOB" || data === "j";
    const isPageUp = data === "PageUp" || data === "\x1b[5~";
    const isPageDown = data === "PageDown" || data === "\x1b[6~";

    if (isUp) {
      this.state = { ...this.state, scrollOffset: Math.max(0, this.state.scrollOffset - 1) };
      return;
    }
    if (isDown) {
      this.state = { ...this.state, scrollOffset: this.state.scrollOffset + 1 };
      return;
    }
    if (isPageUp) {
      this.state = { ...this.state, scrollOffset: Math.max(0, this.state.scrollOffset - 10) };
      return;
    }
    if (isPageDown) {
      this.state = { ...this.state, scrollOffset: this.state.scrollOffset + 10 };
      return;
    }
  }

  invalidate(): void {
    // Static report, nothing to invalidate
  }

  render(width: number): string[] {
    const { theme, report } = this.config;
    const { activeTab, scrollOffset } = this.state;
    const lines: string[] = [];
    const innerWidth = Math.max(90, Math.min(width - 4, 130));

    // ── Header ──────────────────────────────────────────
    lines.push(renderBoxHeader(theme, innerWidth, " 📊 Pi Usage Report "));

    // ── Tabs ────────────────────────────────────────────
    const tab1 = activeTab === "short"
      ? theme.fg("accent", theme.bold(" [1] Short (1d, 7d) "))
      : theme.fg("muted", " [1] Short (1d, 7d) ");
    const tab2 = activeTab === "long"
      ? theme.fg("accent", theme.bold(" [2] Long (30d, 90d) "))
      : theme.fg("muted", " [2] Long (30d, 90d) ");
    const tabLine = `  ${tab1}  ${tab2}`;
    lines.push(theme.fg("border", "│") + " " + tabLine);
    lines.push(theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));

    // ── Content ─────────────────────────────────────────
    const contentLines = this.renderReportContent(report, activeTab, innerWidth - 4);

    const maxViewportHeight = 25;
    const maxScroll = Math.max(0, contentLines.length - maxViewportHeight);
    const effectiveScroll = Math.min(scrollOffset, maxScroll);

    if (effectiveScroll !== scrollOffset) {
      this.state = { ...this.state, scrollOffset: effectiveScroll };
    }

    const visibleLines = contentLines.slice(effectiveScroll, effectiveScroll + maxViewportHeight);

    for (const line of visibleLines) {
      lines.push(theme.fg("border", "│") + "  " + line);
    }

    const emptyLines = maxViewportHeight - visibleLines.length;
    for (let i = 0; i < emptyLines; i++) {
      lines.push(theme.fg("border", "│") + " ".repeat(innerWidth - 2) + theme.fg("border", "│"));
    }

    // ── Footer ──────────────────────────────────────────
    const scrollIndicator = maxScroll > 0 ? ` [${effectiveScroll}/${maxScroll}↑↓] ` : "";
    const footerText = `${scrollIndicator}[←/→ or 1/2] Tabs  [↑↓/PgUp/PgDn] Scroll  [q/Esc] Close`;
    lines.push(renderBoxFooter(theme, innerWidth, footerText));

    return lines;
  }

  private renderReportContent(report: UsageReport, activeTab: Tab, innerWidth: number): string[] {
    const { theme } = this.config;
    const lines: string[] = [];

    const targetDays = activeTab === "short" ? [1, 7] : [30, 90];
    const windows = report.windows.filter((w) => targetDays.includes(w.days));

    // Fixed column widths (must sum to ≤ innerWidth - 2 for padding)
    const COL = {
      source: 12,
      model: 32,
      msgs: 6,
      input: 10,
      output: 10,
      cached: 8,
      total: 12,
      price: 10,
    };
    const gap = "  ";

    for (const window of windows) {
      lines.push("");
      lines.push(theme.fg("accent", theme.bold(`📈 ${window.label}`)));

      if (window.models.length === 0) {
        lines.push(theme.fg("muted", "  No usage data in this period."));
        continue;
      }

      // Header row
      const hdr =
        this.cell("Source", COL.source, "left") + gap +
        this.cell("Model", COL.model, "left") + gap +
        this.cell("Msgs", COL.msgs, "right") + gap +
        this.cell("Input", COL.input, "right") + gap +
        this.cell("Output", COL.output, "right") + gap +
        this.cell("Cached", COL.cached, "right") + gap +
        this.cell("Total", COL.total, "right") + gap +
        this.cell("Price", COL.price, "right");
      lines.push(theme.fg("text", theme.bold(hdr)));

      // Separator
      const sepWidth = COL.source + COL.model + COL.msgs + COL.input + COL.output + COL.cached + COL.total + COL.price + gap.length * 7;
      lines.push(theme.fg("border", "  " + "─".repeat(sepWidth)));

      // Data rows
      const sorted = [...window.models].sort((a, b) => b.cost - a.cost);
      for (const m of sorted) {
        const row =
          this.cell(m.provider, COL.source, "left") + gap +
          this.cell(m.model, COL.model, "left") + gap +
          this.cell(m.messageCount.toLocaleString(), COL.msgs, "right") + gap +
          this.cell(m.input.toLocaleString(), COL.input, "right") + gap +
          this.cell(m.output.toLocaleString(), COL.output, "right") + gap +
          this.cell(m.cacheRead.toLocaleString(), COL.cached, "right") + gap +
          this.cell(m.totalTokens.toLocaleString(), COL.total, "right") + gap +
          this.cell(this.formatUSD(m.cost), COL.price, "right");
        lines.push(theme.fg("text", row));
      }

      // Totals
      lines.push(theme.fg("border", "  " + "─".repeat(sepWidth)));
      const tot =
        this.cell("TOTAL", COL.source, "left") + gap +
        this.cell("", COL.model, "left") + gap +
        this.cell(window.totalMessages.toLocaleString(), COL.msgs, "right") + gap +
        this.cell(window.totalInput.toLocaleString(), COL.input, "right") + gap +
        this.cell(window.totalOutput.toLocaleString(), COL.output, "right") + gap +
        this.cell(window.totalCacheRead.toLocaleString(), COL.cached, "right") + gap +
        this.cell(window.totalTokens.toLocaleString(), COL.total, "right") + gap +
        this.cell(this.formatUSD(window.totalCost), COL.price, "right");
      lines.push(theme.fg("accent", theme.bold(tot)));
    }

    // Pricing notes
    if (activeTab === "long" && report.pricingNotes.length > 0) {
      lines.push("");
      lines.push(theme.fg("border", "  " + "─".repeat(innerWidth - 2)));
      lines.push(theme.fg("accent", theme.bold("📝 Pricing Notes")));
      for (const note of report.pricingNotes) {
        lines.push(theme.fg("muted", `  • ${note}`));
      }
    }

    return lines;
  }

  private cell(text: string, width: number, align: "left" | "right"): string {
    if (align === "right") {
      return text.padStart(width);
    }
    // Left align with truncation
    if (text.length > width) {
      return truncateToWidth(text, width);
    }
    return text.padEnd(width);
  }

  private formatUSD(amount: number): string {
    if (amount < 1) return `$${amount.toFixed(4)}`;
    return `$${amount.toFixed(2)}`;
  }
}