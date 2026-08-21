import { describe, expect, test } from "bun:test";
import { createRefreshGate } from "../_shared/git-status-widget-lifecycle";

describe("git status widget refresh lifecycle", () => {
    test("rejects an in-flight refresh after session shutdown", () => {
        const gate = createRefreshGate();
        const refresh = gate.begin();

        expect(gate.isCurrent(refresh)).toBe(true);
        gate.invalidate();
        expect(gate.isCurrent(refresh)).toBe(false);
    });

    test("keeps the latest session refresh current", () => {
        const gate = createRefreshGate();
        const first = gate.begin();
        const second = gate.begin();

        expect(gate.isCurrent(first)).toBe(false);
        expect(gate.isCurrent(second)).toBe(true);
    });
});
