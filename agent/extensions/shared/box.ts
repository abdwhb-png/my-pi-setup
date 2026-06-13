import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Render a centered box header line:
 *   ╭─── text ───╮
 *
 * The `text` is styled with `theme.fg("accent", theme.bold(text))`.
 */
export function renderBoxHeader(
  theme: Theme,
  innerWidth: number,
  text: string,
): string {
  const pad = Math.max(0, innerWidth - visibleWidth(text));
  const padLeft = Math.floor(pad / 2);
  const padRight = pad - padLeft;
  return (
    theme.fg("border", "╭" + "─".repeat(padLeft)) +
    theme.fg("accent", theme.bold(text)) +
    theme.fg("border", "─".repeat(padRight) + "╮")
  );
}

/**
 * Render a centered box footer line:
 *   ╰─── text ───╯
 *
 * The `text` is styled with `theme.fg("muted", theme.italic(text))`.
 */
export function renderBoxFooter(
  theme: Theme,
  innerWidth: number,
  text: string,
): string {
  const pad = Math.max(0, innerWidth - visibleWidth(text));
  const padLeft = Math.floor(pad / 2);
  const padRight = pad - padLeft;
  return (
    theme.fg("border", "╰" + "─".repeat(padLeft)) +
    theme.fg("muted", theme.italic(text)) +
    theme.fg("border", "─".repeat(padRight) + "╯")
  );
}