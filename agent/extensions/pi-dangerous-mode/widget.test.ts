import { describe, expect, it } from "bun:test";
import { renderDangerousWidget } from "./widget.ts";

const theme = { fg: (_color: string, text: string) => text } as never;
const base = {
    compatible: { runner: true, uiBroker: true },
    configValid: true,
    dangerous: { flag: false, override: undefined, effective: false },
    unattended: { override: undefined, effective: false },
};

describe("dangerous-mode widget", () => {
    it("shows independent Dangerous and Unattended states", () => {
        expect(renderDangerousWidget(theme, base)).toBeNull();
        expect(renderDangerousWidget(theme, {
            ...base,
            dangerous: { ...base.dangerous, effective: true },
            unattended: { override: true, effective: true },
        })).toContain("dangerous: ON unattended: ON");
    });
});
