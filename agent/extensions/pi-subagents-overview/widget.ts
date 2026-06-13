/**
 * Overlay widget components for subagents overview and detail views.
 *
 * Follows the same pattern as usage/widget.ts and yeet/session.ts:
 * - Implements Component interface from @earendil-works/pi-tui
 * - Uses ctx.ui.custom with overlay:true for centered, dismissible dialogs
 * - Uses shared box rendering for consistent header/footer styling
 */

import { type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { BoxRenderer } from "../shared/box";

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
    const box = new BoxRenderer(theme, width);
    box.setTitle(" 🤖 Subagents Overview ");
    box.setContent(this.contentLines);
    box.scrollTo(this.state.scrollOffset);
    box.setFooter(`${box.getScrollInfo()}[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close`);
    return box.render();
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
    const box = new BoxRenderer(theme, width, { viewportHeight: 20 });
    box.setTitle(` 🧬 Agent: ${this.config.agentName} `);
    box.setContent(this.contentLines);
    box.scrollTo(this.state.scrollOffset);
    box.setFooter(`${box.getScrollInfo()}[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close`);
    return box.render();
  }
}