import type { EventBus } from "@earendil-works/pi-coding-agent";

export const MARKDOWN_LINKS_TRANSFORM_EVENT = "markdown-links:transform:v1";

export interface MarkdownLinkTransformInput {
    sourcePath: string;
    content: string;
    cwd: string;
    sourceKind: string;
}

export interface MarkdownLinkTransformRequest extends MarkdownLinkTransformInput {
    version: 1;
    result?: string;
}

export function isMarkdownLinkTransformRequest(
    // oxlint-disable-next-line typescript/no-restricted-types -- EventBus exposes payloads as unknown.
    value: unknown,
): value is MarkdownLinkTransformRequest {
    if (value === null || typeof value !== "object") return false;

    const request = value as Partial<MarkdownLinkTransformRequest>;
    return (
        request.version === 1 &&
        typeof request.sourcePath === "string" &&
        typeof request.content === "string" &&
        typeof request.cwd === "string" &&
        typeof request.sourceKind === "string" &&
        (request.result === undefined || typeof request.result === "string")
    );
}

export function requestMarkdownLinkTransform(
    events: Pick<EventBus, "emit">,
    input: MarkdownLinkTransformInput,
): string {
    const request: MarkdownLinkTransformRequest = {
        version: 1,
        ...input,
    };
    events.emit(MARKDOWN_LINKS_TRANSFORM_EVENT, request);
    return request.result ?? input.content;
}
