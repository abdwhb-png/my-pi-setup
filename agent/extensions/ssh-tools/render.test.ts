import { describe, expect, it } from "bun:test";
import { targetLabel } from "./render.ts";

describe("targetLabel", () => {
    it("names the active target", () => {
        expect(targetLabel("devlab")).toBe("devlab");
    });

    it("marks an inactive target", () => {
        expect(targetLabel(undefined)).toBe("inactive");
    });
});
