import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { walkAllSessions } from "./scanner";
import { computeAllWindows } from "./aggregator";
import { lookupPricing } from "./pricing";
import { renderReport } from "./format";
import type { UsageReport } from "./types";

// ── ANSI color constants (used in error widget) ──

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ── Widget identity ────────────────────────────

const WIDGET_ID = "usage-report";
const WIDGET_DISMISS_MS = 30_000;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show Pi usage and cost summary for the last 1, 7, 30, and 90 days",
    handler: async (_args: string, ctx: any) => {
      // ── Non-interactive mode fallback ──────────────
      if (!ctx.hasUI) {
        const records = walkAllSessions();
        const sourceKeys = [...new Set(records.map((r) => r.sourceKey))];
        const pricing = await lookupPricing(sourceKeys);
        const windows = computeAllWindows(records, pricing);
        const report: UsageReport = {
          windows,
          generatedAt: new Date(),
          pricingNotes: [],
          pricing,
        };
        const lines = renderReport(report);
        for (const line of lines) {
          console.log(line);
        }
        return;
      }

      // ── Interactive mode — show progress ──────────
      ctx.ui.notify("🔍 Scanning session files...", "info");

      try {
        const records = walkAllSessions();

        if (records.length === 0) {
          ctx.ui.setWidget(WIDGET_ID, [
            "📊  Usage Report",
            "",
            "  No session data found.",
          ], { placement: "belowEditor" });
          setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 10_000);
          ctx.ui.notify("No session data found", "warning");
          return;
        }

        const sourceKeys = [...new Set(records.map((r) => r.sourceKey))];
        ctx.ui.notify("💵 Looking up pricing...", "info");
        const pricing = await lookupPricing(sourceKeys);

        const windows = computeAllWindows(records, pricing);
        const pricingNotes: string[] = [];
        for (const [key, rates] of pricing) {
          if (rates.source === "unavailable") {
            pricingNotes.push(`${key}: rates unavailable`);
          } else {
            pricingNotes.push(`${key}: rates from ${rates.source}`);
          }
        }

        const report: UsageReport = {
          windows,
          generatedAt: new Date(),
          pricingNotes,
          pricing,
        };
        const lines = renderReport(report);

        ctx.ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
        ctx.ui.notify("📊 Usage report ready — auto-dismisses in 30s", "info");

        // Auto-dismiss after 30 seconds
        setTimeout(() => {
          try {
            ctx.ui.setWidget(WIDGET_ID, undefined);
          } catch {
            /* ignore */
          }
        }, WIDGET_DISMISS_MS);
      } catch (err) {
        ctx.ui.setWidget(WIDGET_ID, [
          "📊  Usage Report",
          "",
          `  ${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`,
        ], { placement: "belowEditor" });
        setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 15_000);
        ctx.ui.notify("Usage report failed", "error");
      }
    },
  });
}