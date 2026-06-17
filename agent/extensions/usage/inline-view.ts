import { type Component } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TimeWindowReport } from "./types";
import { Container, Text } from "@earendil-works/pi-tui";
import { createUiColors } from "../_shared/ui-colors.ts";

interface UsageInlineViewConfig {
  window: TimeWindowReport;
  theme: Theme;
  done: () => void;
}

export class UsageInlineView implements Component {
  private container: Container;
  private body: Text;
  private cachedWidth?: number;

  constructor(private config: UsageInlineViewConfig) {
    const { theme } = config;
    const colors = createUiColors(theme);

    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => colors.primary(s)));
    this.container.addChild(
      new Text(
        colors.primary(theme.bold("📊 Today's Usage")) +
        colors.subtle("  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => colors.primary(s)));
  }

  handleInput(data: string): void {
    if (
      data === "\x1b" ||
      data.toLowerCase() === "q" ||
      data === "\r"
    ) {
      this.config.done();
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) this.rebuild(width);
    return this.container.render(width);
  }

  private rebuild(width: number): void {
    const { theme, window } = this.config;
    const colors = createUiColors(theme);
    const muted = (s: string) => colors.meta(s);
    const text = (s: string) => colors.text(s);

    const lines: string[] = [];

    if (window.models.length === 0) {
      lines.push(muted("No usage data for today."));
      this.body.setText(lines.join("\n"));
      this.cachedWidth = width;
      return;
    }

    // ── Total cost (prominent) ──
    lines.push(
      muted("Today's Total: ") +
      colors.primary(theme.bold(`$${window.totalCost.toFixed(4)}`)),
    );

    // ── Aggregate numbers ──
    lines.push(
      muted("Messages: ") +
      text(window.totalMessages.toLocaleString()) +
      muted(" · Tokens: ") +
      text(window.totalTokens.toLocaleString()) +
      muted(` (in ${window.totalInput.toLocaleString()} / out ${window.totalOutput.toLocaleString()} / cached ${window.totalCacheRead.toLocaleString()})`),
    );

    lines.push("");

    // ── Per-model breakdown ──
    const CONTENT_WIDTH = Math.max(20, width - 4);
    const modelWidth = Math.max(15, CONTENT_WIDTH - 42); // 42 = fixed cols + gaps
    const gap = "  ";

    // Header
    const hdr =
      padCell("Model", modelWidth, "left") + gap +
      padCell("Msgs", 5, "right") + gap +
      padCell("In", 9, "right") + gap +
      padCell("Out", 9, "right") + gap +
      padCell("Total", 9, "right") + gap +
      padCell("Cost", 10, "right");
    lines.push(theme.fg("text", theme.bold(hdr)));

    // Separator
    const sepWidth = modelWidth + 5 + 9 + 9 + 9 + 10 + gap.length * 5;
    lines.push(theme.fg("border", "  " + "─".repeat(sepWidth)));

    // Data rows
    const sorted = window.models.toSorted((a, b) => b.cost - a.cost);
    for (const m of sorted) {
      const row =
        padCell(`${m.provider}/${m.model}`, modelWidth, "left") + gap +
        padCell(m.messageCount.toLocaleString(), 5, "right") + gap +
        padCell(m.input.toLocaleString(), 9, "right") + gap +
        padCell(m.output.toLocaleString(), 9, "right") + gap +
        padCell(m.totalTokens.toLocaleString(), 9, "right") + gap +
        padCell(formatUSD(m.cost), 10, "right");
      lines.push(theme.fg("text", row));
    }

    // Totals
    lines.push(theme.fg("border", "  " + "─".repeat(sepWidth)));
    const totalRow =
      padCell("TOTAL", modelWidth, "left") + gap +
      padCell(window.totalMessages.toLocaleString(), 5, "right") + gap +
      padCell(window.totalInput.toLocaleString(), 9, "right") + gap +
      padCell(window.totalOutput.toLocaleString(), 9, "right") + gap +
      padCell(window.totalTokens.toLocaleString(), 9, "right") + gap +
      padCell(formatUSD(window.totalCost), 10, "right");
    lines.push(theme.fg("accent", theme.bold(totalRow)));

    this.body.setText(lines.join("\n"));
    this.cachedWidth = width;
  }
}

function padCell(text: string, width: number, align: "left" | "right"): string {
  if (align === "right") {
    return text.padStart(width);
  }
  if (text.length > width) {
    return text.slice(0, width);
  }
  return text.padEnd(width);
}

function formatUSD(amount: number): string {
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}