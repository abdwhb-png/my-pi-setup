import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

/**
 * Result from the review UI.
 */
export type ReviewResult =
    | "approve"
    | "approve-auto"
    | "reject"
    | "edit"
    | { action: "rejected"; reason: string };

/**
 * Options for the review UI component
 */
export interface ReviewOptions {
    operation: "WRITE" | "EDIT" | "BASH"; // Type of change being reviewed
    filePath: string; // Relative path to the file (or tool name)
    body: string; // Content to display (file content, diff, or command)
    stagePath?: string; // Path to staged file (for writes and external editing)
    oldPath?: string; // Staged old file (edits only)
    newPath?: string; // Staged new file (edits only)
    allowEdit?: boolean; // Allow editing: Ctrl+E/Ctrl+O
}

/**
 * Show interactive review UI.
 */
export async function showReview(
    ctx: ExtensionContext,
    opts: ReviewOptions,
): Promise<ReviewResult> {
    const { matchesKey, Key, decodeKittyPrintable } =
        await import("@earendil-works/pi-tui");

    return ctx.ui.custom<ReviewResult>((tui, theme, _kb, done) => {
        let scrollOffset = 0;
        let cachedLines: string[] | undefined;

        let currentBody = opts.body;
        let bodyLines = currentBody.split("\n");
        const maxVisible = 30; // Show up to 30 lines at once
        let maxScroll = Math.max(0, bodyLines.length - 5);

        let reasonMode = false;
        let reasonBuffer = "";

        let renderVersion = 0;
        let cachedVersion = -1;

        function clampScroll(offset: number) {
            scrollOffset = Math.max(0, Math.min(maxScroll, offset));
        }

        function refresh() {
            renderVersion++;
            tui.requestRender();
        }

        function invalidate() {
            cachedLines = undefined;
            cachedVersion = -1;
        }

        function openExternal() {
            try {
                if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
                    openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
                } else if (opts.stagePath) {
                    openExternalFile(opts.stagePath);
                }

                if (
                    opts.allowEdit &&
                    opts.operation === "WRITE" &&
                    opts.stagePath
                ) {
                    try {
                        const editedContent = readFileSync(
                            opts.stagePath,
                            "utf-8",
                        );
                        currentBody = editedContent;
                        bodyLines = currentBody.split("\n");
                        maxScroll = Math.max(0, bodyLines.length - 5);
                        scrollOffset = Math.min(scrollOffset, maxScroll);
                    } catch {}
                }
            } catch {}
            refresh();
        }

        function handleReasonInput(data: string) {
            if (matchesKey(data, Key.enter)) {
                const reason = reasonBuffer.trim();
                done({
                    action: "rejected",
                    reason: reason.length > 0 ? reason : "(no reason given)",
                });
                return;
            }
            if (matchesKey(data, Key.escape)) {
                reasonMode = false;
                reasonBuffer = "";
                invalidate();
                refresh();
                return;
            }
            if (matchesKey(data, Key.backspace)) {
                reasonBuffer = reasonBuffer.slice(0, -1);
                refresh();
                return;
            }
            if (data.length === 1 && data >= " " && data <= "~") {
                reasonBuffer += data;
                refresh();
                return;
            }
            const printable = decodeKittyPrintable?.(data);
            if (printable) {
                reasonBuffer += printable;
                refresh();
            }
        }

        function handleInput(data: string) {
            if (reasonMode) {
                handleReasonInput(data);
                return;
            }

            if (data === "y" || matchesKey(data, Key.enter)) {
                done("approve");
                return;
            }
            if (data === "a") {
                done("approve-auto");
                return;
            }
            if (
                data === "n" ||
                matchesKey(data, Key.escape) ||
                matchesKey(data, Key.ctrl("c"))
            ) {
                done("reject");
                return;
            }
            if (data === "r") {
                reasonMode = true;
                reasonBuffer = "";
                invalidate();
                refresh();
                return;
            }
            if (
                opts.allowEdit &&
                opts.operation === "EDIT" &&
                matchesKey(data, Key.ctrl("e"))
            ) {
                done("edit");
                return;
            }
            if (matchesKey(data, Key.ctrl("o"))) {
                openExternal();
                return;
            }

            if (matchesKey(data, Key.up)) {
                clampScroll(scrollOffset - 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.down)) {
                clampScroll(scrollOffset + 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.pageUp)) {
                clampScroll(scrollOffset - 15);
                refresh();
                return;
            }
            if (matchesKey(data, Key.pageDown)) {
                clampScroll(scrollOffset + 15);
                refresh();
                return;
            }
            if (matchesKey(data, Key.home)) {
                scrollOffset = 0;
                refresh();
                return;
            }
            if (matchesKey(data, Key.end)) {
                scrollOffset = maxScroll;
                refresh();
                return;
            }
        }

        function render(width: number): string[] {
            if (cachedLines && cachedVersion === renderVersion)
                return cachedLines;

            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "─".repeat(width)));

            const colors = createUiColors(theme);
            add(colors.warning(" ⚠ SLOW MODE — review before applying"));

            const opLabel =
                opts.operation === "WRITE"
                    ? theme.fg("warning", " NEW FILE")
                    : opts.operation === "EDIT"
                      ? theme.fg("accent", " EDIT (diff)")
                      : theme.fg("warning", " BASH (command review)");
            add(opLabel);

            add(` ${theme.fg("accent", opts.filePath)}`);
            lines.push("");

            const visible = bodyLines.slice(
                scrollOffset,
                scrollOffset + maxVisible,
            );
            const hasAnsiCodes =
                opts.operation === "EDIT" && /\x1b\[[0-9;]*m/.test(opts.body);

            for (const rawLine of visible) {
                const line = rawLine.replace(/\t/g, "    ");
                if (opts.operation === "EDIT" && hasAnsiCodes) {
                    add(` ${line}`);
                } else if (opts.operation === "EDIT") {
                    if (line.startsWith("---") || line.startsWith("+++")) {
                        add(` ${theme.fg("dim", line)}`);
                    } else if (line.startsWith("@@")) {
                        add(` ${theme.fg("accent", line)}`);
                    } else if (line.startsWith("+")) {
                        add(` ${theme.fg("success", line)}`);
                    } else if (line.startsWith("-")) {
                        add(` ${theme.fg("error", line)}`);
                    } else {
                        add(` ${theme.fg("text", line)}`);
                    }
                } else if (opts.operation === "BASH") {
                    if (line.startsWith("⚠")) {
                        add(` ${colors.danger(line)}`);
                    } else if (line.startsWith("$")) {
                        add(` ${theme.fg("accent", line)}`);
                    } else {
                        add(` ${theme.fg("text", line)}`);
                    }
                } else {
                    add(` ${theme.fg("text", line)}`);
                }
            }

            if (bodyLines.length > maxVisible) {
                const total = bodyLines.length;
                const end = Math.min(scrollOffset + maxVisible, total);
                add(
                    theme.fg(
                        "dim",
                        ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`,
                    ),
                );
            }

            lines.push("");

            if (reasonMode) {
                add(
                    colors.warning(
                        " ⚠ Reject reason — Enter submit • Esc cancel • Backspace delete",
                    ),
                );
                add(` > ${reasonBuffer}`);
            } else {
                let hints =
                    "y/Enter approve • n/Esc reject • r reject w/ reason • a auto-accept (this turn)";
                if (opts.allowEdit && opts.operation === "EDIT") {
                    hints += " • Ctrl+E edit • Ctrl+O view diff";
                } else if (opts.allowEdit) {
                    hints += " • Ctrl+O edit externally";
                } else {
                    hints += " • Ctrl+O view externally";
                }
                hints += " • ↑↓ line • PgUp/PgDn page • Home/End top/bottom";
                add(theme.fg("dim", ` ${hints}`));
            }

            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines;
            cachedVersion = renderVersion;
            return lines;
        }

        return {
            render,
            invalidate,
            handleInput,
        };
    });
}

function openExternalDiff(oldPath: string, newPath: string, label: string) {
    const diffTool = findDiffTool();
    if (!diffTool) {
        openExternalFile(newPath);
        return;
    }

    const { cmd, args } = diffTool;
    if (cmd === "delta") {
        try {
            const diff = execFileSync("diff", ["-u", oldPath, newPath], {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
            });
            execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
                input: diff,
                stdio: ["pipe", "inherit", "inherit"],
            });
        } catch (error) {
            const stdout =
                typeof error === "object" && error !== null && "stdout" in error
                    ? error.stdout
                    : undefined;
            if (typeof stdout === "string" || Buffer.isBuffer(stdout)) {
                let diff =
                    typeof stdout === "string"
                        ? stdout
                        : stdout.toString("utf8");
                diff = diff.replace(/^--- .*$/m, `--- a/${label}`);
                diff = diff.replace(/^\+\+\+ .*$/m, `+++ b/${label}`);
                execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
                    input: diff,
                    stdio: ["pipe", "inherit", "inherit"],
                });
            } else {
                args.push(
                    "--paging",
                    "always",
                    "--side-by-side",
                    oldPath,
                    newPath,
                );
                execFileSync(cmd, args, { stdio: "inherit" });
            }
        }
    } else if (cmd === "nvim" || cmd === "vim") {
        args.push("-d", oldPath, newPath);
        execFileSync(cmd, args, { stdio: "inherit" });
    } else {
        args.push(oldPath, newPath);
        execFileSync(cmd, args, { stdio: "inherit" });
    }
}

export function openExternalFile(filePath: string) {
    const editor = process.env.VISUAL || process.env.EDITOR || "less";
    execFileSync(editor, [filePath], { stdio: "inherit" });
}

function commandExists(cmd: string): boolean {
    try {
        execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function findDiffTool(): { cmd: string; args: string[] } | null {
    const candidates = ["delta", "nvim", "vim", "diff"];
    for (const cmd of candidates) {
        if (commandExists(cmd)) {
            return { cmd, args: [] };
        }
    }
    return null;
}

let deltaAvailable: boolean | null = null;

function hasDelta(): boolean {
    if (deltaAvailable !== null) {
        return deltaAvailable;
    }
    deltaAvailable = commandExists("delta");
    return deltaAvailable;
}

export function renderWithDelta(unifiedDiff: string): string {
    if (!hasDelta()) {
        return unifiedDiff;
    }
    try {
        const result = execFileSync(
            "delta",
            ["--no-gitconfig", "--color-only", "--tabs", "4"],
            {
                input: unifiedDiff,
                encoding: "utf-8",
                timeout: 5000,
            },
        );
        return result;
    } catch {
        return unifiedDiff;
    }
}
