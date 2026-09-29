import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showReview, type ReviewOptions } from "./slow-mode-ui.ts";

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender: () => {} };

/**
 * Render the review overlay once by capturing the component the UI factory
 * builds. `ctx.ui.custom` is the only supported way in, so the stub resolves it
 * immediately and returns a decision without any input.
 *
 * Width is generous on purpose: the hint line is longer than a real terminal, and
 * `truncateToWidth` would otherwise hide the very text these tests assert on.
 */
async function renderReview(
    options: ReviewOptions,
    width = 400,
): Promise<string> {
    let component: { render(width: number): string[] } | undefined;
    const ctx = {
        ui: {
            custom: (
                factory: (
                    tui: unknown,
                    theme: unknown,
                    keybindings: unknown,
                    done: (result: unknown) => void,
                ) => { render(width: number): string[] },
            ) => {
                component = factory(tui, theme, {}, () => {});
                return Promise.resolve("reject");
            },
        },
    } as unknown as ExtensionContext;

    await showReview(ctx, options);
    if (!component) throw new Error("review component was not created");
    return component.render(width).join("\n");
}

function options(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
    return {
        operation: "TOOL",
        filePath: "ssh_write",
        body: "Tool: ssh_write\n  file_path: /etc/hosts",
        ...overrides,
    };
}

describe("showReview operation labels", () => {
    it("labels a generic tool review as TOOL, not BASH", async () => {
        const rendered = await renderReview(options());
        expect(rendered).toContain("TOOL (call review)");
        expect(rendered).not.toContain("BASH");
    });

    it("keeps the BASH label for command reviews", async () => {
        const rendered = await renderReview(
            options({ operation: "BASH", filePath: "safe_bash", body: "$ ls" }),
        );
        expect(rendered).toContain("BASH (command review)");
    });

    it("keeps the WRITE and EDIT labels", async () => {
        expect(
            await renderReview(options({ operation: "WRITE", filePath: "a.ts" })),
        ).toContain("NEW FILE");
        expect(
            await renderReview(options({ operation: "EDIT", filePath: "a.ts" })),
        ).toContain("EDIT (diff)");
    });
});

describe("showReview external-open hint", () => {
    it("does not advertise Ctrl+O when nothing can be opened", async () => {
        const rendered = await renderReview(options());
        expect(rendered).toContain("TOOL (call review)");
        expect(rendered).not.toContain("Ctrl+O");
    });

    it("advertises Ctrl+O for a staged write", async () => {
        const rendered = await renderReview(
            options({
                operation: "WRITE",
                filePath: "a.ts",
                stagePath: "/tmp/staged.ts",
                allowEdit: true,
            }),
        );
        expect(rendered).toContain("Ctrl+O edit externally");
    });

    it("advertises the diff hint for an edit review", async () => {
        const rendered = await renderReview(
            options({
                operation: "EDIT",
                filePath: "a.ts",
                oldPath: "/tmp/a.old",
                newPath: "/tmp/a.new",
                allowEdit: true,
            }),
        );
        expect(rendered).toContain("Ctrl+E edit");
        expect(rendered).toContain("Ctrl+O view diff");
    });

    it("advertises a read-only view when a path is staged without edit", async () => {
        const rendered = await renderReview(
            options({ operation: "WRITE", filePath: "a.ts", stagePath: "/tmp/x" }),
        );
        expect(rendered).toContain("Ctrl+O view externally");
    });
});
