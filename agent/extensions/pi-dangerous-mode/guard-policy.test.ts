import { describe, expect, it } from "bun:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTOPILOT, type AutopilotConfig } from "./config.ts";
import { evaluateAutopilotGuard } from "./guard-policy.ts";

function call(
    toolName: string,
    input: Record<string, unknown>,
): Pick<ToolCallEvent, "toolName" | "input"> {
    return { toolName, input } as Pick<ToolCallEvent, "toolName" | "input">;
}

function config(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
    return {
        ...DEFAULT_AUTOPILOT,
        guardedTools: [...DEFAULT_AUTOPILOT.guardedTools],
        guardedCommands: [...DEFAULT_AUTOPILOT.guardedCommands],
        ...overrides,
    };
}

describe("pi-dangerous-mode Autopilot guard policy", () => {
    it("blocks shared shell deletion hazards as irreversible deletion", () => {
        const result = evaluateAutopilotGuard(
            call("safe_bash", { command: "rm file.txt" }),
            config(),
        );

        expect(result).toEqual({
            category: "irreversible_delete",
            toolName: "safe_bash",
            reason: "Autopilot blocked protected action: irreversible_delete.",
        });
    });

    it("blocks configured publication commands", () => {
        expect(
            evaluateAutopilotGuard(
                call("bash", { command: "git push origin main" }),
                config(),
            )?.category,
        ).toBe("publish");
    });

    it("blocks configured deployment tools", () => {
        expect(
            evaluateAutopilotGuard(call("deploy_service", {}), config())
                ?.category,
        ).toBe("deploy");
    });

    it("blocks payment tools as purchase actions", () => {
        expect(
            evaluateAutopilotGuard(call("payment_capture", {}), config())
                ?.category,
        ).toBe("purchase");
    });

    it("allows tools and commands outside guard policy", () => {
        expect(
            evaluateAutopilotGuard(
                call("read", { path: "README.md" }),
                config(),
            ),
        ).toBeUndefined();
        expect(
            evaluateAutopilotGuard(
                call("bash", { command: "git status --short" }),
                config(),
            ),
        ).toBeUndefined();
    });

    it("maps non-deletion shared shell hazards to external effects", () => {
        expect(
            evaluateAutopilotGuard(
                call("safe_bash", { command: "sudo echo unsafe" }),
                config(),
            )?.category,
        ).toBe("external_effect");
    });

    it("maps custom guard patterns without known category to external effects", () => {
        expect(
            evaluateAutopilotGuard(
                call("send_email", {}),
                config({ guardedTools: ["send_email"] }),
            )?.category,
        ).toBe("external_effect");
    });
});
