import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface BoxOptions {
  titlePosition?: "left" | "center" | "right";
  borderStyle?: "single" | "double" | "rounded";
}

export interface BoxRendererOptions {
  minWidth?: number;
  maxWidth?: number;
  viewportHeight?: number;
  borderStyle?: "single" | "double" | "rounded";
}

const defaultOptions: BoxOptions = {
  titlePosition: "center",
  borderStyle: "rounded",
};

const defaultRendererOptions: Required<BoxRendererOptions> = {
  minWidth: 40,
  maxWidth: 140,
  viewportHeight: 25,
  borderStyle: "rounded",
};

const borders = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    separator: "├",
    separatorRight: "┤",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
    separator: "╠",
    separatorRight: "╣",
  },
  rounded: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    separator: "├",
    separatorRight: "┤",
  },
};

/**
 * Render a beautiful, responsive box header line.
 * Handles text truncation if the title is wider than the box.
 *
 * @param theme - Theme for color styling
 * @param innerWidth - Total width of the box (including corners)
 * @param text - The header text to display
 * @param options - Optional styling: borderStyle (single/double/rounded) and titlePosition (left/center/right)
 */
export function renderBoxHeader(
  theme: Theme,
  innerWidth: number,
  text: string,
  options: BoxOptions = defaultOptions,
): string {
  const { titlePosition, borderStyle } = { ...defaultOptions, ...options };
  const b = borders[borderStyle || "rounded"];

  // Ensure text fits within the box (leave 2 chars for corners)
  const maxTextWidth = Math.max(0, innerWidth - 2);
  const safeText = truncateToWidth(text, maxTextWidth);
  const textWidth = visibleWidth(safeText);

  const pad = Math.max(0, innerWidth - textWidth - 2);
  let padLeft = 0;
  let padRight = 0;

  if (titlePosition === "center") {
    padLeft = Math.floor(pad / 2);
    padRight = pad - padLeft;
  } else if (titlePosition === "left") {
    padLeft = 1;
    padRight = pad - 1;
  } else {
    padLeft = pad - 1;
    padRight = 1;
  }

  // Ensure padding is never negative
  padLeft = Math.max(0, padLeft);
  padRight = Math.max(0, padRight);

  const leftLine = b.topLeft + b.horizontal.repeat(padLeft);
  const rightLine = b.horizontal.repeat(padRight) + b.topRight;

  // Add subtle padding around the text for better visual breathing room
  const styledText = theme.fg("accent", theme.bold(` ${safeText} `));

  return theme.fg("border", leftLine) + styledText + theme.fg("border", rightLine);
}

/**
 * Render a beautiful, responsive box footer line.
 * Handles text truncation if the text is wider than the box.
 *
 * @param theme - Theme for color styling
 * @param innerWidth - Total width of the box (including corners)
 * @param text - The footer text to display
 * @param options - Optional styling: borderStyle (single/double/rounded) and titlePosition (left/center/right)
 */
export function renderBoxFooter(
  theme: Theme,
  innerWidth: number,
  text: string,
  options: BoxOptions = defaultOptions,
): string {
  const { titlePosition, borderStyle } = { ...defaultOptions, ...options };
  const b = borders[borderStyle || "rounded"];

  const maxTextWidth = Math.max(0, innerWidth - 2);
  const safeText = truncateToWidth(text, maxTextWidth);
  const textWidth = visibleWidth(safeText);

  const pad = Math.max(0, innerWidth - textWidth - 2);
  let padLeft = 0;
  let padRight = 0;

  if (titlePosition === "center") {
    padLeft = Math.floor(pad / 2);
    padRight = pad - padLeft;
  } else if (titlePosition === "left") {
    padLeft = 1;
    padRight = pad - 1;
  } else {
    padLeft = pad - 1;
    padRight = 1;
  }

  padLeft = Math.max(0, padLeft);
  padRight = Math.max(0, padRight);

  const leftLine = b.bottomLeft + b.horizontal.repeat(padLeft);
  const rightLine = b.horizontal.repeat(padRight) + b.bottomRight;

  const styledText = theme.fg("muted", theme.italic(` ${safeText} `));

  return theme.fg("border", leftLine) + styledText + theme.fg("border", rightLine);
}

/**
 * Render vertical side borders for a box.
 *
 * @param theme - Theme for color styling
 * @param height - Number of lines to generate
 * @returns Array of styled vertical border strings
 */
export function renderBoxSides(theme: Theme, height: number): string[] {
  const b = borders["rounded"];
  return Array.from({ length: height }, () => theme.fg("border", b.vertical));
}

// ── BoxRenderer: centralized responsive box with scroll management ──

/**
 * BoxRenderer centralizes all box layout logic:
 * - Responsive width calculation (clamped to min/max)
 * - Scroll/viewport management (set content, scroll, auto-clamp)
 * - Border rendering (header, body lines, footer)
 * - Empty line padding to fill viewport
 *
 * Extensions just set title, content, footer and call render().
 */
export class BoxRenderer {
  private theme: Theme;
  private terminalWidth: number;
  private opts: Required<BoxRendererOptions>;

  private titleText: string | null = null;
  private footerText: string | null = null;
  private fixedHeaderLines: string[] = [];
  private contentLines: string[] = [];
  private scrollOffset = 0;
  private boxOptions: BoxOptions = {};

  constructor(theme: Theme, terminalWidth: number, options?: BoxRendererOptions) {
    this.theme = theme;
    this.terminalWidth = terminalWidth;
    this.opts = { ...defaultRendererOptions, ...options };
  }

  setTitle(text: string): void {
    this.titleText = text;
  }

  setFooter(text: string | null): void {
    this.footerText = text;
  }

  /** Non-scrollable lines rendered between header and scrollable content */
  setFixedHeader(lines: string[]): void {
    this.fixedHeaderLines = lines;
  }

  setContent(lines: string[]): void {
    this.contentLines = lines;
  }

  setBoxOptions(opts: BoxOptions): void {
    this.boxOptions = opts;
  }

  scrollTo(offset: number): void {
    this.scrollOffset = offset;
  }

  scrollDown(): void {
    this.scrollOffset++;
  }

  getInnerWidth = (): number => {
    const raw = Math.min(this.terminalWidth, this.opts.maxWidth);
    const w = Math.max(raw, this.opts.minWidth);
    return w - 4; // account for overlay padding
  };

  getContentWidth = (): number => {
    return this.getInnerWidth() - 4; // │ + 2 spaces padding on each side
  };

  /** Access a border character (e.g. 'vertical', 'separator') for custom lines */
  borderChar = (key: keyof typeof borders.rounded): string => {
    return borders[this.opts.borderStyle][key];
  };

  /** Returns scroll indicator string, e.g. " [3/10↑↓] ", or "" if no scrolling */
  getScrollInfo = (): string => {
    const maxScroll = Math.max(0, this.contentLines.length - this.opts.viewportHeight);
    if (maxScroll === 0) return "";
    const effective = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    return ` [${effective}/${maxScroll}↑↓] `;
  }

  render(): string[] {
    const theme = this.theme;
    const b = borders[this.opts.borderStyle];
    const innerWidth = this.getInnerWidth();
    const viewportH = this.opts.viewportHeight;

    const lines: string[] = [];

    // ── Header ──
    if (this.titleText !== null) {
      lines.push(renderBoxHeader(theme, innerWidth, this.titleText, {
        ...defaultOptions,
        ...this.boxOptions,
      }));
    } else {
      lines.push(theme.fg("border", b.topLeft + b.horizontal.repeat(innerWidth - 2) + b.topRight));
    }

    // ── Fixed header (non-scrollable, e.g. tabs) ──
    for (const line of this.fixedHeaderLines) {
      const vw = visibleWidth(line);
      const padding = Math.max(0, innerWidth - vw - 4);
      lines.push(
        theme.fg("border", b.vertical) + "  " + line + " ".repeat(padding) + theme.fg("border", b.vertical),
      );
    }

    // ── Scrollable content viewport ──
    const maxScroll = Math.max(0, this.contentLines.length - viewportH);
    const effectiveScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    // Clamp to avoid stale state
    if (this.scrollOffset !== effectiveScroll) {
      this.scrollOffset = effectiveScroll;
    }

    const visibleLines = this.contentLines.slice(
      effectiveScroll,
      effectiveScroll + viewportH,
    );

    for (const line of visibleLines) {
      const vw = visibleWidth(line);
      const padding = Math.max(0, innerWidth - vw - 4);
      lines.push(
        theme.fg("border", b.vertical) + "  " + line + " ".repeat(padding) + theme.fg("border", b.vertical),
      );
    }

    // Pad remaining viewport with empty lines
    const emptyLines = viewportH - visibleLines.length;
    for (let i = 0; i < emptyLines; i++) {
      lines.push(
        theme.fg("border", b.vertical) +
          " ".repeat(innerWidth - 2) +
          theme.fg("border", b.vertical),
      );
    }

    // ── Footer ──
    if (this.footerText !== null) {
      const scrollInfo = maxScroll > 0 ? ` [${effectiveScroll}/${maxScroll}↑↓] ` : "";
      const fullFooter = scrollInfo + this.footerText;
      lines.push(renderBoxFooter(theme, innerWidth, fullFooter, {
        ...defaultOptions,
        ...this.boxOptions,
      }));
    }

    return lines;
  }
}