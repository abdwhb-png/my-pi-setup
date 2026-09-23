import { describe, expect, it } from "bun:test";
import {
    buildHerdrWidgetText,
    renderHerdrWidget,
} from "./widget.ts";

const theme = { fg: (_color: string, text: string) => text } as never;

describe("pi-herdr widget", () => {
    it("is hidden while herdr tools are off", () => {
        expect(renderHerdrWidget(theme, false)).toBeNull();
    });

    it("shows on state while herdr tools are enabled", () => {
        expect(renderHerdrWidget(theme, true)).toContain("herdr: on");
    });

    it("builds plain text", () => {
        expect(buildHerdrWidgetText(true)).toBe("herdr: on");
        expect(buildHerdrWidgetText(false)).toBe("herdr: off");
    });
});