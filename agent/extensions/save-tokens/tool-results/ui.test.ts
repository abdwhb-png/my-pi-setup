import { describe, expect, it, mock } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompressionMetrics } from "./metrics";
import type { CompressionSnapshot } from "./types";
import { STATUS_ID, updateUi } from "./ui";
import type { WidgetHandle } from "../../_shared/fancy-footer";

const themeFg = (color: string, text: string) => `${color}:${text}`;

function fakeCtx(): {
    ctx: ExtensionContext;
    statusCalls: Array<[string, string | undefined]>;
} {
    const statusCalls: Array<[string, string | undefined]> = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double
    const ctx = {
        hasUI: true,
        ui: {
            theme: { fg: themeFg },
            setStatus: (id: string, text: string | undefined) => {
                statusCalls.push([id, text]);
            },
        },
    } as unknown as ExtensionContext;
    return { ctx, statusCalls };
}

function emptySnapshot(): CompressionSnapshot {
    return {
        seen: 0,
        compressed: 0,
        skipped: 0,
        failed: 0,
        bytesSaved: 0,
        toolCounts: {},
        toolStats: {},
        firstCompressedTools: [],
        recentCalls: [],
    };
}

describe("updateUi health state", () => {
    it("shows the engine and no-calls line in neutral colors when up", () => {
        const { ctx } = fakeCtx();
        const widget = { update: mock() };
        const setWidgetText = mock();

        updateUi(
            ctx,
            emptySnapshot(),
            "headroom",
            "up",
            widget as unknown as WidgetHandle,
            setWidgetText,
            true,
            true,
        );

        expect(setWidgetText).toHaveBeenCalledWith(
            "accent:🗜 • compressor headroom" +
                "dim: │ " +
                "muted:no calls yet",
        );
    });

    it("shows offline in danger color when down, overriding the call line", () => {
        const { ctx } = fakeCtx();
        const widget = { update: mock() };
        const setWidgetText = mock();

        updateUi(
            ctx,
            emptySnapshot(),
            "headroom",
            "down",
            widget as unknown as WidgetHandle,
            setWidgetText,
            true,
            true,
        );

        const text = setWidgetText.mock.calls[0][0] as string;
        expect(text).toContain("accent:🗜 • compressor headroom");
        expect(text).toContain("error:offline");
        expect(text).not.toContain("no calls yet");
        expect(widget.update).toHaveBeenCalledTimes(1);
    });

    it("keeps offline override even when calls failed", () => {
        const { ctx } = fakeCtx();
        const metrics = createCompressionMetrics();
        metrics.record({
            kind: "failed",
            toolName: "bash",
            originalLength: 5000,
            compressedLength: 0,
        });
        const widget = { update: mock() };
        const setWidgetText = mock();

        updateUi(
            ctx,
            metrics.snapshot(),
            "headroom",
            "down",
            widget as unknown as WidgetHandle,
            setWidgetText,
            true,
            true,
        );

        const text = setWidgetText.mock.calls[0][0] as string;
        expect(text).toContain("error:offline");
        expect(text).not.toContain("warning:fail");
    });

    it("preserves warning color for failed calls when health is up", () => {
        const { ctx } = fakeCtx();
        const metrics = createCompressionMetrics();
        metrics.record({
            kind: "failed",
            toolName: "bash",
            originalLength: 5000,
            compressedLength: 0,
        });
        const widget = { update: mock() };
        const setWidgetText = mock();

        updateUi(
            ctx,
            metrics.snapshot(),
            "headroom",
            "up",
            widget as unknown as WidgetHandle,
            setWidgetText,
            true,
            true,
        );

        const text = setWidgetText.mock.calls[0][0] as string;
        expect(text).toContain("warning:last 1: ok 0");
        expect(text).not.toContain("error:offline");
    });

    it("sets the status bar to warning offline when down", () => {
        const { ctx, statusCalls } = fakeCtx();
        const widget = { update: mock() };
        const setWidgetText = mock();

        updateUi(
            ctx,
            emptySnapshot(),
            "headroom",
            "down",
            widget as unknown as WidgetHandle,
            setWidgetText,
            true,
            false,
        );

        expect(statusCalls).toContainEqual([
            STATUS_ID,
            "warning:cmp 0/0 ok • saved 0B • fail 0 • offline",
        ]);
    });
});