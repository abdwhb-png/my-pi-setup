import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UsageReport } from "./types";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("usage", {
        description:
            "Show Pi usage and cost summary — no args for inline today view, any arg for full report",
        handler: async (args: string, ctx: any) => {
            // ── Non-interactive mode fallback ──────────────
            if (!ctx.hasUI) {
                const { walkAllSessions } = await import("./scanner");
                const { computeAllWindows } = await import("./aggregator");
                const { lookupPricing } = await import("./pricing");
                const records = walkAllSessions();
                const sourceKeys = [
                    ...new Set(records.map((r) => r.sourceKey)),
                ];
                const pricing = await lookupPricing(sourceKeys);
                const windows = computeAllWindows(records, pricing);
                const report: UsageReport = {
                    windows,
                    generatedAt: new Date(),
                    pricingNotes: [],
                    pricing,
                };
                console.log("📊 Pi Usage Report");
                console.log("─".repeat(40));
                for (const w of report.windows) {
                    console.log(`\n${w.label}:`);
                    for (const m of w.models) {
                        console.log(
                            `  ${m.provider}/${m.model}: ${m.messageCount} msgs, $${m.cost.toFixed(4)}`,
                        );
                    }
                    console.log(`  TOTAL: $${w.totalCost.toFixed(2)}`);
                }
                return;
            }

            // ── Interactive mode — show progress ──────────
            ctx.ui.notify("🔍 Scanning session files...", "info");

            try {
                const { walkAllSessions } = await import("./scanner");
                const records = walkAllSessions();

                if (records.length === 0) {
                    ctx.ui.notify("No session data found", "warning");
                    return;
                }

                // ── Inline mode: no args → show today's usage inline ──
                const isFullReport = args.trim() === "--full";
                if (!isFullReport) {
                    const { computeWindow } = await import("./aggregator");
                    const { UsageInlineView } = await import("./inline-view");
                    const todayWindow = computeWindow(records, 1, new Map());

                    await (ctx.ui.custom as any)(
                        (
                            _tui: unknown,
                            theme: unknown,
                            _kb: unknown,
                            done: () => void,
                        ) =>
                            new UsageInlineView({
                                window: todayWindow,
                                theme: theme as any,
                                done,
                            }),
                    );
                    return;
                }

                // ── Full report mode: args present → show detached overlay with all windows ──
                const sourceKeys = [
                    ...new Set(records.map((r) => r.sourceKey)),
                ];
                ctx.ui.notify("💵 Looking up pricing...", "info");
                const { lookupPricing } = await import("./pricing");
                const pricing = await lookupPricing(sourceKeys);

                const { computeAllWindows } = await import("./aggregator");
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

                // ── Show detached overlay dialog (like yeet) ──
                const { UsageReportWidget } = await import("./widget");
                await (ctx.ui.custom as any)(
                    (
                        _tui: unknown,
                        theme: unknown,
                        _kb: unknown,
                        done: () => void,
                    ) =>
                        new UsageReportWidget({
                            theme: theme as any,
                            report,
                            done,
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center" as const,
                            width: "80%" as const,
                            maxWidth: 100,
                        },
                    },
                );

                ctx.ui.notify("📊 Usage report closed", "info");
            } catch (err) {
                ctx.ui.notify(
                    `Usage report failed: ${err instanceof Error ? err.message : String(err)}`,
                    "error",
                );
            }
        },
    });
}
