import { describe, expect, it } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
    isMarkdownLinkTransformRequest,
    MARKDOWN_LINKS_TRANSFORM_EVENT,
    requestMarkdownLinkTransform,
} from "./markdown-links.ts";

describe("requestMarkdownLinkTransform", () => {
    const input = {
        sourcePath: "/project/docs/guide.md",
        content: "Read [setup](./setup.md)",
        cwd: "/project",
        sourceKind: "context",
    };

    it("returns transformed content from a synchronous listener", () => {
        const events = createEventBus();
        events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
            if (!isMarkdownLinkTransformRequest(value)) return;
            expect(value).toMatchObject({ version: 1, ...input });
            value.result = "Read [setup](/project/docs/setup.md)";
        });

        expect(requestMarkdownLinkTransform(events, input)).toBe(
            "Read [setup](/project/docs/setup.md)",
        );
    });

    it("returns original content when no listener is registered", () => {
        const events = createEventBus();
        expect(requestMarkdownLinkTransform(events, input)).toBe(input.content);
    });
});

describe("isMarkdownLinkTransformRequest", () => {
    it("accepts only complete versioned requests", () => {
        expect(
            isMarkdownLinkTransformRequest({
                version: 1,
                sourcePath: "/project/README.md",
                content: "content",
                cwd: "/project",
                sourceKind: "read",
            }),
        ).toBeTrue();
        expect(
            isMarkdownLinkTransformRequest({
                version: 2,
                sourcePath: "/project/README.md",
                content: "content",
                cwd: "/project",
                sourceKind: "read",
            }),
        ).toBeFalse();
        expect(isMarkdownLinkTransformRequest(null)).toBeFalse();
    });
});
