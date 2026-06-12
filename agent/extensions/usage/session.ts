import { type Component } from "@earendil-works/pi-tui";
import type { UsageReport } from "./types";

export class UsageReportWidget implements Component {
  private lines: string[];

  constructor(private report: UsageReport, private reportLines?: string[]) {
    this.lines = reportLines ?? [];
  }

  render(width: number): string[] {
    // If we have pre-rendered lines, use them. The report is static.
    if (this.lines.length > 0) return this.lines;

    // Otherwise render with truncated lines
    const rendered = this.reportLines ?? [];
    return rendered.map(line => {
      if (line.length <= width) return line;
      return line.substring(0, width - 1) + '…';
    });
  }

  invalidate(): void {
    // Report is static — nothing to invalidate
  }
}