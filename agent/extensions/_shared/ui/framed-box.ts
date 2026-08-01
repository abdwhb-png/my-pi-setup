import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type BoxBorderStyle = "single" | "double" | "rounded";

export interface BoxOptions {
  titlePosition?: "left" | "center" | "right";
  borderStyle?: BoxBorderStyle;
}

export interface BoxPanelSpec {
  minWidth: number;
  /**
   * Hard cap applied during allocation.
   *
   * During allocation each panel never grows beyond this width.
   * If all panels become saturated and extra width remains, the remainder is
   * intentionally assigned to the last panel to preserve a valid frameWidth.
   */
  maxWidth?: number;
  weight?: number;
}

export interface BoxRendererOptions {
  minWidth?: number;
  maxWidth?: number;
  viewportHeight?: number;
  borderStyle?: BoxBorderStyle;
}

export interface BoxPanelLayout {
  frameWidth: number;
  panelWidths: readonly number[];
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

type BoxBorder = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  separator: string;
  separatorRight: string;
  topJunction: string;
  crossJunction: string;
  bottomJunction: string;
};

const borders: Record<BoxBorderStyle, BoxBorder> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    separator: "├",
    separatorRight: "┤",
    topJunction: "┬",
    crossJunction: "┼",
    bottomJunction: "┴",
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
    topJunction: "╦",
    crossJunction: "╬",
    bottomJunction: "╩",
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
    topJunction: "┬",
    crossJunction: "┼",
    bottomJunction: "┴",
  },
};

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

function validatePanelSpecs(specs: readonly BoxPanelSpec[]): boolean {
  if (specs.length === 0) return false;

  for (const spec of specs) {
    if (!isPositiveInteger(spec.minWidth)) return false;
    if (spec.maxWidth !== undefined) {
      if (!isPositiveInteger(spec.maxWidth) || spec.maxWidth < spec.minWidth) return false;
    }

    if (spec.weight !== undefined && !isPositiveInteger(spec.weight)) {
      return false;
    }
  }

  return true;
}

function validateBoxPanelLayout(layout: BoxPanelLayout): boolean {
  if (!isPositiveInteger(layout.frameWidth) || layout.panelWidths.length === 0) {
    return false;
  }

  let totalPanelWidth = 0;
  for (const width of layout.panelWidths) {
    if (!isPositiveInteger(width)) return false;
    totalPanelWidth += width;
  }

  const expectedFrameWidth = 2 + (layout.panelWidths.length - 1) + totalPanelWidth;
  return layout.frameWidth === expectedFrameWidth;
}

function ensureValidBoxPanelLayout(layout: BoxPanelLayout): void {
  if (!validateBoxPanelLayout(layout)) {
    throw new Error("invalid box panel layout");
  }
}

export function allocateBoxPanelLayout(
  frameWidth: number,
  specs: readonly BoxPanelSpec[],
): BoxPanelLayout | null {
  if (!isPositiveInteger(frameWidth)) return null;
  if (!validatePanelSpecs(specs)) return null;

  const separatorCount = specs.length - 1;
  const maxPanelWidth = frameWidth - 2 - separatorCount;
  if (maxPanelWidth <= 0) return null;

  const minPanelWidth = specs.reduce((acc, spec) => acc + spec.minWidth, 0);
  if (minPanelWidth > maxPanelWidth) return null;

  const panelWidths = specs.map((spec) => spec.minWidth);
  let remainingWidth = maxPanelWidth - minPanelWidth;

  if (remainingWidth <= 0) {
    return {
      frameWidth,
      panelWidths,
    };
  }

  while (remainingWidth > 0) {
    const expandable = specs
      .map((spec, index) => ({
        index,
        width: panelWidths[index],
        maxWidth: spec.maxWidth,
        weight: spec.weight ?? 1,
      }))
      .filter(({ width, maxWidth }) =>
        maxWidth === undefined ? true : width < maxWidth,
      );

    if (expandable.length === 0) {
      panelWidths[specs.length - 1] += remainingWidth;
      return {
        frameWidth,
        panelWidths,
      };
    }

    const totalWeight = expandable.reduce((acc, entry) => acc + entry.weight, 0);
    if (totalWeight <= 0) {
      panelWidths[specs.length - 1] += remainingWidth;
      return {
        frameWidth,
        panelWidths,
      };
    }

    const roundBudget = remainingWidth;
    const provisionalAllocations = expandable.map((entry) => {
      const exactAllocation = (roundBudget * entry.weight) / totalWeight;
      const maxRoom = entry.maxWidth === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, entry.maxWidth - entry.width);
      const baseAllocation = Math.min(Math.floor(exactAllocation), maxRoom);

      return {
        ...entry,
        baseAllocation,
        remainder: exactAllocation - Math.floor(exactAllocation),
      };
    });

    let allocatedThisRound = 0;
    for (const entry of provisionalAllocations) {
      panelWidths[entry.index] += entry.baseAllocation;
      allocatedThisRound += entry.baseAllocation;
    }

    let leftover = roundBudget - allocatedThisRound;

    const remainderTargets = provisionalAllocations
      .filter((entry) => {
        const maxRoom = entry.maxWidth === undefined
          ? Number.POSITIVE_INFINITY
          : entry.maxWidth - entry.width;
        return entry.baseAllocation < maxRoom;
      })
      .sort((a, b) => {
        if (a.remainder === b.remainder) {
          return a.index - b.index;
        }
        return b.remainder - a.remainder;
      });

    for (const entry of remainderTargets) {
      if (leftover <= 0) break;

      const maxRoom = entry.maxWidth === undefined
        ? Number.POSITIVE_INFINITY
        : entry.maxWidth - entry.width;
      if (entry.baseAllocation >= maxRoom) continue;

      panelWidths[entry.index] += 1;
      leftover -= 1;
    }

    if (!provisionalAllocations.some((entry) => {
      const maxWidth = entry.maxWidth;
      return maxWidth === undefined || panelWidths[entry.index] < maxWidth;
    }) && leftover > 0) {
      panelWidths[specs.length - 1] += leftover;
      return {
        frameWidth,
        panelWidths,
      };
    }

    remainingWidth = leftover;
  }

  const layout: BoxPanelLayout = {
    frameWidth,
    panelWidths,
  };

  if (!validateBoxPanelLayout(layout)) {
    return null;
  }

  return layout;
}

/**
 * Allocate panel widths honoring minimum/maximum constraints and weights.
 *
 * Max width is treated as an hard cap during weighted distribution.
 * If every panel reaches maxWidth before extra width is fully consumed,
 * the leftover width is assigned to the last panel so the returned layout
 * always matches the requested frameWidth.
 */

function resolveBorderStyle(borderStyle?: BoxBorderStyle): BoxBorderStyle {
  return borderStyle || "rounded";
}

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

  // Reserve corners plus one space on either side of the title text.
  const maxTextWidth = Math.max(0, innerWidth - 4);
  const safeText = truncateToWidth(text, maxTextWidth);
  const textWidth = visibleWidth(safeText);

  const pad = Math.max(0, innerWidth - textWidth - 4);
  let padLeft = 0;
  let padRight = 0;

  if (titlePosition === "center") {
    padLeft = Math.floor(pad / 2);
    padRight = pad - padLeft;
  } else if (titlePosition === "left") {
    padLeft = Math.min(1, pad);
    padRight = pad - padLeft;
  } else {
    padRight = Math.min(1, pad);
    padLeft = pad - padRight;
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

  const maxTextWidth = Math.max(0, innerWidth - 4);
  const safeText = truncateToWidth(text, maxTextWidth);
  const textWidth = visibleWidth(safeText);

  const pad = Math.max(0, innerWidth - textWidth - 4);
  let padLeft = 0;
  let padRight = 0;

  if (titlePosition === "center") {
    padLeft = Math.floor(pad / 2);
    padRight = pad - padLeft;
  } else if (titlePosition === "left") {
    padLeft = Math.min(1, pad);
    padRight = pad - padLeft;
  } else {
    padRight = Math.min(1, pad);
    padLeft = pad - padRight;
  }

  padLeft = Math.max(0, padLeft);
  padRight = Math.max(0, padRight);

  const leftLine = b.bottomLeft + b.horizontal.repeat(padLeft);
  const rightLine = b.horizontal.repeat(padRight) + b.bottomRight;

  const styledText = theme.fg("muted", theme.italic(` ${safeText} `));

  return theme.fg("border", leftLine) + styledText + theme.fg("border", rightLine);
}

/**
 * Render wrapped content rows enclosed by the box's vertical borders.
 */
export function renderBoxContentLines(
  theme: Theme,
  innerWidth: number,
  text: string,
  options: BoxOptions = defaultOptions,
): string[] {
  const { borderStyle } = { ...defaultOptions, ...options };
  const b = borders[borderStyle || "rounded"];
  const contentWidth = Math.max(1, innerWidth - 4);

  return wrapTextWithAnsi(text, contentWidth).map((line) => {
    const padding = Math.max(1, innerWidth - visibleWidth(line) - 3);
    return (
      theme.fg("border", b.vertical) +
      " " +
      line +
      " ".repeat(padding) +
      theme.fg("border", b.vertical)
    );
  });
}

/** Render a full-width separator between box content sections. */
export function renderBoxSeparator(
  theme: Theme,
  innerWidth: number,
  options: BoxOptions = defaultOptions,
): string {
  const { borderStyle } = { ...defaultOptions, ...options };
  const b = borders[resolveBorderStyle(borderStyle)];
  return theme.fg(
    "border",
    b.separator + b.horizontal.repeat(Math.max(0, innerWidth - 2)) + b.separatorRight,
  );
}

export function renderBoxPanelRow(
  theme: Theme,
  layout: BoxPanelLayout,
  cells: readonly string[],
  options: BoxOptions = defaultOptions,
): string {
  ensureValidBoxPanelLayout(layout);

  if (cells.length !== layout.panelWidths.length) {
    throw new Error("cells length does not match panel layout");
  }

  const { borderStyle } = { ...defaultOptions, ...options };
  const b = borders[resolveBorderStyle(borderStyle)];

  let line = "";

  for (const [index, cell] of cells.entries()) {
    if (cell.includes("\r") || cell.includes("\n")) {
      throw new Error("renderBoxPanelRow cells must be single-line strings");
    }

    const width = layout.panelWidths[index];
    const safeCell = truncateToWidth(cell, width);
    const padding = Math.max(0, width - visibleWidth(safeCell));
    line += theme.fg("border", b.vertical) + safeCell + " ".repeat(padding);
  }

  return line + theme.fg("border", b.vertical);
}

export function renderBoxPanelSeparator(
  theme: Theme,
  layout: BoxPanelLayout,
  kind: "top" | "middle" | "bottom",
  options: BoxOptions = defaultOptions,
): string {
  ensureValidBoxPanelLayout(layout);

  const { borderStyle } = { ...defaultOptions, ...options };
  const b = borders[resolveBorderStyle(borderStyle)];

  const junction =
    kind === "top"
      ? b.topJunction
      : kind === "middle"
        ? b.crossJunction
        : b.bottomJunction;

  let line = "";
  for (const [index, width] of layout.panelWidths.entries()) {
    const separator = index === 0 ? b.separator : junction;
    line += theme.fg("border", `${separator}${b.horizontal.repeat(Math.max(0, width))}`);
  }

  return `${line}${theme.fg("border", b.separatorRight)}`;
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
    const availableInnerWidth = Math.max(1, this.terminalWidth - 4);
    const maxInnerWidth = Math.max(1, this.opts.maxWidth - 4);
    return Math.min(availableInnerWidth, maxInnerWidth);
  };

  getContentWidth = (): number => {
    return Math.max(1, this.getInnerWidth() - 4); // │ + 2 spaces padding on each side
  };

  private wrapLines(lines: string[]): string[] {
    return lines.flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, this.getContentWidth())),
    );
  }

  /** Access a border character (e.g. 'vertical', 'separator') for custom lines */
  borderChar = (key: keyof typeof borders.rounded): string => {
    return borders[this.opts.borderStyle][key];
  };

  /** Returns scroll indicator string, e.g. " [3/10↑↓] ", or "" if no scrolling */
  getScrollInfo = (): string => {
    const maxScroll = Math.max(0, this.wrapLines(this.contentLines).length - this.opts.viewportHeight);
    if (maxScroll === 0) return "";
    const effective = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    return ` [${effective}/${maxScroll}↑↓] `;
  }

  render(): string[] {
    const theme = this.theme;
    const b = borders[this.opts.borderStyle];
    const innerWidth = this.getInnerWidth();
    const viewportH = this.opts.viewportHeight;

    if (innerWidth < 4) {
      const fallbackText =
        this.titleText ?? this.fixedHeaderLines[0] ?? this.contentLines[0] ?? this.footerText ?? "";
      return [truncateToWidth(fallbackText, innerWidth)];
    }

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
    for (const line of this.wrapLines(this.fixedHeaderLines)) {
      const vw = visibleWidth(line);
      const padding = Math.max(0, innerWidth - vw - 4);
      lines.push(
        theme.fg("border", b.vertical) + "  " + line + " ".repeat(padding) + theme.fg("border", b.vertical),
      );
    }

    // ── Scrollable content viewport ──
    const wrappedContentLines = this.wrapLines(this.contentLines);
    const maxScroll = Math.max(0, wrappedContentLines.length - viewportH);
    const effectiveScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    // Clamp to avoid stale state
    if (this.scrollOffset !== effectiveScroll) {
      this.scrollOffset = effectiveScroll;
    }

    const visibleLines = wrappedContentLines.slice(
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
