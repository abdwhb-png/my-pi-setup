import { describe, expect, it } from "bun:test";
import { cycleFocus } from "./focus-navigation.ts";

describe("cycleFocus", () => {
    const order = ["agents", "details", "live"] as const;

    it("cycles forward and backward with wrapping", () => {
        expect(cycleFocus(order, "agents", 1)).toBe("details");
        expect(cycleFocus(order, "live", 1)).toBe("agents");
        expect(cycleFocus(order, "agents", -1)).toBe("live");
    });

    it("chooses a deterministic edge when the current focus is absent", () => {
        expect(cycleFocus(order, "missing", 1)).toBe("agents");
        expect(cycleFocus(order, "missing", -1)).toBe("live");
    });

    it("keeps the current value when no focus target exists", () => {
        expect(cycleFocus([], "missing", 1)).toBe("missing");
    });
});
