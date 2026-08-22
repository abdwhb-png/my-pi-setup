import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createWidget } from "./_shared/fancy-footer";
import { runGit, getBranch, getUnstagedCount } from "./_shared/git-helper";
import { createRefreshGate } from "./_shared/git-status-widget-lifecycle";
import { createUiColors } from "./_shared/ui/ui-colors";

const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;
const BRANCH_ICON = "🌿";
const UNSTAGED_ICON = "✏️";

let widgetText: string | null = null;

async function refreshWidgetText(
    ctx: ExtensionContext,
): Promise<string | null> {
    if (!ctx.hasUI) return null;
    const cwd = ctx.cwd;
    const theme = ctx.ui.theme;

    try {
        await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
        const [branch, unstagedCount] = await Promise.all([
            getBranch(cwd),
            getUnstagedCount(cwd),
        ]);

        const colors = createUiColors(theme);

        const fileLabel = unstagedCount === 1 ? "file" : "files";
        return `${BRANCH_ICON}${colors.primary(branch)} · ${UNSTAGED_ICON}${colors.warning(`${unstagedCount} ${fileLabel}`)}`;
    } catch {
        return null;
    }
}

export default function (pi: ExtensionAPI) {
    let interval: NodeJS.Timeout | undefined;
    let w: ReturnType<typeof createWidget> | undefined;
    const refreshGate = createRefreshGate();
    let activeRefresh: number | undefined;

    pi.on("session_start", async (_event, ctx) => {
        if (interval) clearInterval(interval);
        const refresh = refreshGate.begin();
        activeRefresh = refresh;

        w = createWidget(pi, {
            id: WIDGET_ID,
            label: "Git Status",
            description: "Shows current branch and unstaged file count.",
            row: 1,
            order: 1,
            align: "left",
            render: () => widgetText,
        });

        const initialWidgetText = await refreshWidgetText(ctx);
        if (!refreshGate.isCurrent(refresh)) return;
        widgetText = initialWidgetText;
        w.update(ctx, widgetText);
        interval = setInterval(async () => {
            const nextWidgetText = await refreshWidgetText(ctx);
            if (!refreshGate.isCurrent(refresh)) return;
            widgetText = nextWidgetText;
            w?.update(ctx, widgetText);
        }, UPDATE_INTERVAL_MS);
    });

    pi.on("input", async (_event, ctx) => {
        const refresh = activeRefresh;
        const nextWidgetText = await refreshWidgetText(ctx);
        if (refresh === undefined || !refreshGate.isCurrent(refresh)) {
            return { action: "continue" };
        }
        widgetText = nextWidgetText;
        w?.update(ctx, widgetText);
        return { action: "continue" };
    });

    pi.on("tool_execution_end", async (_event, ctx) => {
        const refresh = activeRefresh;
        const nextWidgetText = await refreshWidgetText(ctx);
        if (refresh === undefined || !refreshGate.isCurrent(refresh)) return;
        widgetText = nextWidgetText;
        w?.update(ctx, widgetText);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        refreshGate.invalidate();
        activeRefresh = undefined;
        if (interval) {
            clearInterval(interval);
            interval = undefined;
        }
        w?.remove(ctx);
    });
}
