import { describe, expect, it } from "bun:test";
import {
    buildYoloWidgetText,
    renderYoloWidget,
} from "./widget.ts";

const theme = { fg: (_color: string, text: string) => text } as never;

describe("pi-permission-system-addons yolo widget", () => {
    it("is visible with on state when enabled", () => {
        expect(renderYoloWidget(theme, true)).toContain("●");
        expect(renderYoloWidget(theme, true)).toContain("yoloSession: on");
    });

    it("is visible with off state when disabled", () => {
        expect(renderYoloWidget(theme, false)).toContain("◉");
        expect(renderYoloWidget(theme, false)).toContain("yoloSession: off");
        expect(renderYoloWidget(theme, false)).not.toBeNull();
    });

    it("hides when off only when hideWhenOff is set", () => {
        expect(renderYoloWidget(theme, false, { hideWhenOff: true })).toBeNull();
        expect(
            renderYoloWidget(theme, true, { hideWhenOff: true }),
        ).toContain("yoloSession: on");
    });

    it("builds plain text", () => {
        expect(buildYoloWidgetText(true)).toBe("yoloSession: on");
        expect(buildYoloWidgetText(false)).toBe("yoloSession: off");
    });
});