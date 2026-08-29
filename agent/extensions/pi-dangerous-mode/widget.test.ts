import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DANGEROUS_ICON, renderDangerousWidget } from "./widget.ts";
import type { RuntimeStatus } from "./runtime-state.ts";

function mockTheme(): Theme {
    return {
        fg: (_color: string, text: string) => text,
    } as unknown as Theme;
}

function baseStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
    return {
        compatible: { runner: true, uiBroker: true },
        configValid: true,
        dangerous: {
            flag: false,
            override: undefined,
            inducedByAutopilot: false,
            effective: false,
        },
        autopilot: {
            flag: false,
            override: undefined,
            effective: false,
            phase: "inactive",
            turnsUsed: 0,
            retriesUsed: 0,
        },
        ...overrides,
    };
}

describe("renderDangerousWidget", () => {
    it("returns null when neither dangerous nor autopilot effective", () => {
        const theme = mockTheme();
        const status = baseStatus();
        expect(renderDangerousWidget(theme, status)).toBeNull();
    });

    it("returns styled ON with icon when dangerous effective", () => {
        const theme = mockTheme();
        const status = baseStatus({
            dangerous: {
                flag: true,
                override: true,
                inducedByAutopilot: false,
                effective: true,
            },
        });
        const result = renderDangerousWidget(theme, status);
        expect(result).not.toBeNull();
        expect(result).toContain(DANGEROUS_ICON);
        expect(result).toContain("ON");
        expect(result).toContain("dangerous:");
    });

    it("shows autopilot phase and turns when autopilot effective", () => {
        const theme = mockTheme();
        const status = baseStatus({
            dangerous: {
                flag: false,
                override: undefined,
                inducedByAutopilot: true,
                effective: true,
            },
            autopilot: {
                flag: true,
                override: true,
                effective: true,
                phase: "running",
                turnsUsed: 3,
                retriesUsed: 1,
            },
        });
        const result = renderDangerousWidget(theme, status);
        expect(result).not.toBeNull();
        expect(result).toContain(DANGEROUS_ICON);
        expect(result).toContain("auto:running");
        expect(result).toContain("3");
    });

    it("returns ERR when runner incompatible even if effective", () => {
        const theme = mockTheme();
        const status = baseStatus({
            compatible: { runner: false, uiBroker: true },
            dangerous: {
                flag: true,
                override: true,
                inducedByAutopilot: false,
                effective: true,
            },
        });
        const result = renderDangerousWidget(theme, status);
        expect(result).not.toBeNull();
        expect(result).toContain("ERR");
        expect(result).toContain(DANGEROUS_ICON);
    });

    it("returns ERR when config invalid", () => {
        const theme = mockTheme();
        const status = baseStatus({
            configValid: false,
            dangerous: {
                flag: true,
                override: true,
                inducedByAutopilot: false,
                effective: true,
            },
        });
        const result = renderDangerousWidget(theme, status);
        expect(result).toContain("ERR");
    });
});
