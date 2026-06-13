/**
 * Overlay widget components for subagents overview and detail views.
 *
 * Follows the same pattern as usage/widget.ts and yeet/session.ts:
 * - Implements Component interface from @earendil-works/pi-tui
 * - Uses ctx.ui.custom with overlay:true for centered, dismissible dialogs
 * - Uses shared box rendering for consistent header/footer styling
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderBoxHeader, renderBoxFooter } from "../shared/box";

// ── Types ──────────────────────────────────────────────

interface ScrollState {
  scrollOffset: number;
}

// ── SubagentsOverviewWidget ────────────────────────────

export class SubagentsOverviewWidget implements Component {
  private contentLines: string[];
  private state: ScrollState;

  constructor(
    private config: {
      theme: Theme;
      content: string;
      done: () => void;
    },
  ) {
    this.contentLines = config.content.split("\n");
    this.state = { scrollOffset: 0 };
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.config.done();
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
    // Static content, nothing to invalidate
  }

  render(width: number): string[] {
    const { theme } = this.config;
    const { scrollOffset } = this.state;
    const lines: string[] = [];
    const innerWidth = Math.max(90, Math.min(width - 4, 130));

    // ── Header ──
    lines.push(renderBoxHeader(theme, innerWidth, " 🤖 Subagents Overview "));

    // ── Content (scrollable) ──
    const maxViewportHeight = 25;
    const maxScroll = Math.max(0, this.contentLines.length - maxViewportHeight);
    const effectiveScroll = Math.min(scrollOffset, maxScroll);

    const visibleLines = this.contentLines.slice(effectiveScroll, effectiveScroll + maxViewportHeight);

    for (const line of visibleLines) {
      const vw = visibleWidth(line);
      const padding = Math.max(0, innerWidth - vw - 2);
      lines.push(theme.fg("border", "│") + " " + line + " ".repeat(padding) + theme.fg("border", "│"));
    }

    const emptyLines = maxViewportHeight - visibleLines.length;
    for (let i = 0; i < emptyLines; i++) {
      lines.push(theme.fg("border", "│") + " ".repeat(innerWidth - 2) + theme.fg("border", "│"));
    }

    // ── Footer ──
    const scrollIndicator = maxScroll > 0 ? ` [${effectiveScroll}/${maxScroll}↑↓] ` : "";
    const footerText = `${scrollIndicator}[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close`;
    lines.push(renderBoxFooter(theme, innerWidth, footerText));

    return lines;
  }
}

// ── AgentDetailWidget ──────────────────────────────────

export class AgentDetailWidget implements Component {
  private contentLines: string[];
  private state: ScrollState;

  constructor(
    private config: {
      theme: Theme;
      content: string;
      agentName: string;
      done: () => void;
    },
  ) {
    this.contentLines = config.content.split("\n");
    this.state = { scrollOffset: 0 };
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.config.done();
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
    // Static content, nothing to invalidate
  }

  render(width: number): string[] {
    const { theme } = this.config;
    const { scrollOffset } = this.state;
    const lines: string[] = [];
    const innerWidth = Math.max(90, Math.min(width - 4, 130));

    // ── Header ──
    lines.push(renderBoxHeader(theme, innerWidth, ` 🧬 Agent: ${this.config.agentName} `));

    // ── Content (scrollable) ──
    const maxViewportHeight = 20;
    const maxScroll = Math.max(0, this.contentLines.length - maxViewportHeight);
    const effectiveScroll = Math.min(scrollOffset, maxScroll);

    const visibleLines = this.contentLines.slice(effectiveScroll, effectiveScroll + maxViewportHeight);

    for (const line of visibleLines) {
      const vw = visibleWidth(line);
      const padding = Math.max(0, innerWidth - vw - 2);
      lines.push(theme.fg("border", "│") + " " + line + " ".repeat(padding) + theme.fg("border", "│"));
    }

    const emptyLines = maxViewportHeight - visibleLines.length;
    for (let i = 0; i < emptyLines; i++) {
      lines.push(theme.fg("border", "│") + " ".repeat(innerWidth - 2) + theme.fg("border", "│"));
    }

    // ── Footer ──
    const scrollIndicator = maxScroll > 0 ? ` [${effectiveScroll}/${maxScroll}↑↓] ` : "";
    const footerText = `${scrollIndicator}[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close`;
    lines.push(renderBoxFooter(theme, innerWidth, footerText));

    return lines;
  }
}