import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
    allocateBoxPanelLayout,
    renderBoxFooter,
    renderBoxHeader,
    renderBoxPanelRow,
    renderBoxPanelSeparator,
    type BoxBorderStyle,
    type BoxPanelLayout,
    type BoxPanelSpec,
} from "./framed-box.ts";

export interface ResponsivePanelVariant<Mode extends string> {
    mode: Mode;
    minWidth: number;
    panels: readonly BoxPanelSpec[];
}

export function resolveResponsivePanelLayout<Mode extends string>(
    frameWidth: number,
    variants: readonly ResponsivePanelVariant<Mode>[],
): { mode: Mode; layout: BoxPanelLayout } | null {
    const candidates = variants
        .filter((variant) => frameWidth >= variant.minWidth)
        .toSorted((left, right) => right.minWidth - left.minWidth);

    for (const candidate of candidates) {
        const layout = allocateBoxPanelLayout(frameWidth, candidate.panels);
        if (layout) return { mode: candidate.mode, layout };
    }
    return null;
}

export function computePanelOverlayHeight(
    terminalRows: number,
    options: { ratio?: number; margin?: number } = {},
): number {
    if (!Number.isFinite(terminalRows)) return 0;
    const rows = Math.max(0, Math.floor(terminalRows));
    const ratio = Math.max(0, options.ratio ?? 0.85);
    const margin = Math.max(0, Math.floor(options.margin ?? 2));
    return Math.max(0, Math.min(Math.floor(rows * ratio), rows - margin));
}

export function wrapPanelLines(
    lines: readonly string[],
    panelWidth: number,
    options: { padding?: number } = {},
): string[] {
    const padding = Math.max(0, Math.floor(options.padding ?? 1));
    const contentWidth = Math.max(1, panelWidth - padding * 2);
    const prefix = " ".repeat(padding);

    return lines.flatMap((line) => {
        const wrapped = wrapTextWithAnsi(line, contentWidth);
        const visualLines = wrapped.length > 0 ? wrapped : [""];
        return visualLines.map((visualLine) => `${prefix}${visualLine}`);
    });
}

export function slicePanelViewport(
    lines: readonly string[],
    requestedOffset: number,
    requestedHeight: number,
): { lines: string[]; offset: number; maxOffset: number; totalLines: number } {
    const height = Math.max(0, Math.floor(requestedHeight));
    const maxOffset = Math.max(0, lines.length - height);
    const offset =
        height === 0
            ? 0
            : Math.max(0, Math.min(Math.floor(requestedOffset), maxOffset));
    const visibleLines = lines.slice(offset, offset + height);
    while (visibleLines.length < height) visibleLines.push("");

    return {
        lines: visibleLines,
        offset,
        maxOffset,
        totalLines: lines.length,
    };
}

export function renderPanelTitle(
    theme: Theme,
    label: string,
    active: boolean,
    options: { padding?: number } = {},
): string {
    const prefix = " ".repeat(Math.max(0, Math.floor(options.padding ?? 1)));
    return active
        ? theme.fg("accent", theme.bold(`${prefix}▸ ${label}`))
        : theme.fg("muted", `${prefix}${label}`);
}

export function renderFramedPanels(options: {
    theme: Theme;
    title: string;
    layout: BoxPanelLayout;
    prelude?: readonly string[];
    panelTitles?: readonly string[];
    panelRows?: readonly (readonly string[])[];
    additionalRows?: readonly (readonly string[])[];
    footer?: string;
    borderStyle?: BoxBorderStyle;
    titlePosition?: "left" | "center" | "right";
}): string[] {
    const {
        theme,
        title,
        layout,
        prelude = [],
        panelTitles,
        panelRows = [],
        additionalRows = [],
        footer = "",
        borderStyle = "rounded",
        titlePosition = "left",
    } = options;
    const boxOptions = { borderStyle, titlePosition } as const;
    const fullLayout = allocateBoxPanelLayout(layout.frameWidth, [
        { minWidth: layout.frameWidth - 2 },
    ]);
    if (!fullLayout) return [];

    const rendered = [
        renderBoxHeader(theme, layout.frameWidth, title, boxOptions),
        ...prelude.map((line) =>
            renderBoxPanelRow(theme, fullLayout, [line], boxOptions),
        ),
    ];

    if (panelTitles) {
        rendered.push(
            renderBoxPanelSeparator(theme, layout, "top", boxOptions),
            renderBoxPanelRow(theme, layout, panelTitles, boxOptions),
            renderBoxPanelSeparator(theme, layout, "middle", boxOptions),
        );
    }

    rendered.push(
        ...panelRows.map((row) =>
            renderBoxPanelRow(theme, layout, row, boxOptions),
        ),
        ...additionalRows.map((row) =>
            renderBoxPanelRow(theme, layout, row, boxOptions),
        ),
        renderBoxFooter(theme, layout.frameWidth, footer, boxOptions),
    );
    return rendered;
}

export function renderFramedPanelFallback(options: {
    theme: Theme;
    width: number;
    maxHeight: number;
    title: string;
    message: string;
    footer?: string;
    borderStyle?: BoxBorderStyle;
}): string[] {
    const {
        theme,
        title,
        message,
        footer = "",
        borderStyle = "rounded",
    } = options;
    const width = Math.max(0, Math.floor(options.width));
    const maxHeight = Math.max(0, Math.floor(options.maxHeight));
    if (width === 0 || maxHeight === 0) return [];
    if (width < 4 || maxHeight < 3) {
        return [truncateToWidth(title || message || footer, width)].slice(
            0,
            maxHeight,
        );
    }

    const layout = allocateBoxPanelLayout(width, [{ minWidth: width - 2 }]);
    if (!layout) return [truncateToWidth(title || message || footer, width)];
    const bodyRows = Math.max(1, maxHeight - 2);
    const wrapped = wrapPanelLines([message], layout.panelWidths[0], {
        padding: 1,
    });
    const viewport = slicePanelViewport(wrapped, 0, bodyRows);
    const rendered = renderFramedPanels({
        theme,
        title,
        layout,
        panelRows: viewport.lines.map((line) => [line]),
        footer,
        borderStyle,
    });
    return rendered.slice(0, maxHeight).map((line) => {
        if (visibleWidth(line) === width) return line;
        return truncateToWidth(line, width);
    });
}
