import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function targetLabel(name: string | undefined): string {
    return name ?? "inactive";
}

/**
 * One call-line renderer for all four remote tools. The detail is supplied as a
 * typed extractor so each tool reads its own schema-known argument instead of
 * indexing an untyped argument bag. The target label is read through a callback
 * because SSH mode can change between renders.
 */
export function createRemoteRenderCall<Args>(
    toolName: string,
    detail: (args: Args) => string | undefined,
    targetName: () => string | undefined,
): (args: Args, theme: Theme) => Text {
    return (args, theme) =>
        new Text(
            `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", detail(args) ?? "...")} ${theme.fg("muted", `[${targetLabel(targetName())}]`)}`,
            0,
            0,
        );
}
