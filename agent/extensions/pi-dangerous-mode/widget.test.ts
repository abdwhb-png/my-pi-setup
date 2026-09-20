import { describe, expect, it } from "bun:test";
import {
    buildDangerousWidgetText,
    renderDangerousWidget,
} from "./widget.ts";

const theme = { fg: (_color: string, text: string) => text } as never;
const base = {
    compatible: { runner: true, uiPromptGuard: true },
    configValid: true,
    dangerous: { flag: false, override: undefined, effective: false },
    unattended: { override: undefined, effective: false },
};

describe("dangerous-mode widget", () => {
    it("shows independent Dangerous and Unattended states", () => {
        expect(renderDangerousWidget(theme, base)).toBeNull();
        const dangerousOnly = buildDangerousWidgetText({
            ...base,
            dangerous: { ...base.dangerous, effective: true },
        });
        const unattendedOnly = buildDangerousWidgetText({
            ...base,
            unattended: { override: true, effective: true },
        });
        const active = {
            ...base,
            dangerous: { ...base.dangerous, effective: true },
            unattended: { override: true, effective: true },
        };
        const both = buildDangerousWidgetText(active);
        expect(dangerousOnly).not.toBe("");
        expect(unattendedOnly).not.toBe("");
        expect(dangerousOnly).not.toBe(unattendedOnly);
        expect(both).toContain(dangerousOnly);
        expect(both).toContain(unattendedOnly);
        expect(renderDangerousWidget(theme, active)).toContain(
            both,
        );
    });
});
