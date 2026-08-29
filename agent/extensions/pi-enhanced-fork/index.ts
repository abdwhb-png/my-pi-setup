import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionUIContext,
    SessionEntry,
    TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

import { EnhancedForkSelector } from "./selector.ts";
import type { ForkCandidate } from "./selector.ts";

export {
    EnhancedForkSelector,
    type ForkCandidate,
    parseWheelDirection,
} from "./selector.ts";

const LEADING_SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;

export function extractForkCandidates(
    entries: readonly SessionEntry[],
): ForkCandidate[] {
    return entries.flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "user")
            return [];

        const { content } = entry.message;
        const text =
            typeof content === "string"
                ? content
                : content
                      .flatMap((block) =>
                          block.type === "text" ? [block.text] : [],
                      )
                      .join("");
        return text.trim().length === 0 ? [] : [{ entryId: entry.id, text }];
    });
}

export function compactExpandedSkillInput(text: string): string | undefined {
    const skillNames: string[] = [];
    let remaining = text;
    let match = LEADING_SKILL_BLOCK.exec(remaining);

    while (match) {
        const skillName = match[1];
        if (!skillName) break;
        skillNames.push(skillName);
        remaining = remaining.slice(match[0].length);
        match = LEADING_SKILL_BLOCK.exec(remaining);
    }

    if (skillNames.length === 0) return undefined;

    const command = `/skill:${skillNames.join(",")}`;
    return remaining.length === 0 ? command : `${command} ${remaining}`;
}

export async function runEnhancedFork(
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) return;
    if (!ctx.isIdle()) {
        ctx.ui.notify(
            "Wait for the current response to finish before forking",
            "warning",
        );
        return;
    }

    const candidates = extractForkCandidates(ctx.sessionManager.getEntries());
    if (candidates.length === 0) {
        ctx.ui.notify("No user messages to fork from", "warning");
        return;
    }

    const selectedId = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) =>
            new EnhancedForkSelector(candidates, tui, theme, done),
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                margin: 1,
                maxHeight: "80%",
                width: "90%",
            },
        },
    );
    const selected = candidates.find(
        (candidate) => candidate.entryId === selectedId,
    );
    if (!selected) return;

    const compactText = compactExpandedSkillInput(selected.text);
    try {
        await ctx.fork(selected.entryId, {
            withSession: async (replacementCtx) => {
                if (compactText) replacementCtx.ui.setEditorText(compactText);
            },
        });
    } catch (error) {
        ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
        );
    }
}

function forkShimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const configured = env.PI_ENHANCED_FORK_SHIM?.trim().toLowerCase();
    return configured !== "0" && configured !== "false" && configured !== "off";
}

function rewriteForkSubmission(
    data: string,
    ui: Pick<ExtensionUIContext, "getEditorText" | "setEditorText">,
): ReturnType<TerminalInputHandler> {
    if (isKeyRelease(data) || !matchesKey(data, Key.enter)) return undefined;
    if (ui.getEditorText().trim() !== "/fork") return undefined;

    ui.setEditorText("/efork");
    return undefined;
}

export default function piEnhancedFork(pi: ExtensionAPI): void {
    let unsubscribe: (() => void) | undefined;

    pi.registerCommand("efork", {
        description: "Fork from a user message with a responsive selector",
        handler: async (_args, ctx) => runEnhancedFork(ctx),
    });

    pi.on("session_start", (_event, ctx) => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (!forkShimEnabled()) return;

        try {
            unsubscribe = ctx.ui.onTerminalInput((data) =>
                rewriteForkSubmission(data, ctx.ui),
            );
        } catch {
            ctx.ui.notify(
                "Enhanced /fork shim unavailable; use /efork",
                "warning",
            );
        }
    });

    pi.on("session_shutdown", () => {
        unsubscribe?.();
        unsubscribe = undefined;
    });
}
