import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface BoxOptions {
  titlePosition?: "left" | "center" | "right";
  borderStyle?: "single" | "double" | "rounded";
}

const defaultOptions: BoxOptions = {
  titlePosition: "center",
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
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
  },
  rounded: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
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