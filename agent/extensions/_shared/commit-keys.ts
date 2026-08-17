import { matchesKey } from "@earendil-works/pi-tui";

/**
 * Centralized key binding detection for commit plan UI.
 * Uses pi-tui's matchesKey() which handles legacy raw bytes,
 * Kitty CSI-u sequences, and modifyOtherKeys sequences.
 *
 * Both confirm.ts (CommitConfirmDialog) and session.ts (CommitPlanSession)
 * import these instead of doing raw string comparison.
 */
export function isEnter(data: string): boolean {
    return matchesKey(data, "enter");
}

export function isEscape(data: string): boolean {
    return matchesKey(data, "escape");
}

export function isTab(data: string): boolean {
    return matchesKey(data, "tab");
}

export function isCtrlR(data: string): boolean {
    return matchesKey(data, "ctrl+r");
}

export function isArrowUp(data: string): boolean {
    return matchesKey(data, "up");
}

export function isArrowDown(data: string): boolean {
    return matchesKey(data, "down");
}
