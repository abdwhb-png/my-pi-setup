import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { listSavedPlans, type SavedPlan, type SavedPlanKind } from "./tracker.ts";

function formatPlan(plan: SavedPlan): string {
    const name = plan.topic ?? plan.path ?? plan.key;
    const version = plan.version == null ? "" : ` v${plan.version}`;
    return `  ${name}${version}`;
}

function formatSection(kind: SavedPlanKind, entries: SavedPlan[]): string {
    const title = kind === "session_plan" ? "Session plans" : "Pi plans";
    if (entries.length === 0) return `${title}: none`;
    return `${title}:\n${entries.map(formatPlan).join("\n")}`;
}

function parseArgs(args: string): { kind?: SavedPlanKind; query?: string } {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return {};
    if (parts[0] === "--session") {
        return { kind: "session_plan", query: parts.slice(1).join(" ") || undefined };
    }
    if (parts[0] === "--pi") {
        return { kind: "pi-plan", query: parts.slice(1).join(" ") || undefined };
    }
    return { query: parts.join(" ") };
}

function matchesQuery(plan: SavedPlan, query: string): boolean {
    const normalized = query.trim().toLocaleLowerCase();
    return [plan.topic, plan.path, plan.key]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase() === normalized);
}

export function showSavedPlans(
    args: string,
    sessionId: string,
): string {
    const { kind, query } = parseArgs(args);
    let entries = listSavedPlans(sessionId);
    if (kind) entries = entries.filter((entry) => entry.kind === kind);
    if (query) entries = entries.filter((entry) => matchesQuery(entry, query));

    if (entries.length === 0) {
        return query
            ? `No saved plan matching "${query}" in the active session.`
            : "No plans saved in the active session yet. Use session_plan save or write_plan.";
    }

    return [
        formatSection(
            "session_plan",
            entries.filter((entry) => entry.kind === "session_plan"),
        ),
        formatSection(
            "pi-plan",
            entries.filter((entry) => entry.kind === "pi-plan"),
        ),
    ].join("\n\n");
}

export function registerShowSavedPlansCommand(pi: ExtensionAPI): void {
    pi.registerCommand("show-saved-plans", {
        description:
            "List plans saved during the active session. Use --session or --pi to filter.",
        handler: async (args, ctx: ExtensionCommandContext) => {
            ctx.ui.notify(
                showSavedPlans(args, ctx.sessionManager.getSessionId()),
                "info",
            );
        },
    });
}
