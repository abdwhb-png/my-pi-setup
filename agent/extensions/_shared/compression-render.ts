import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { CompressionDetails } from "./compression-protocol";

interface CompressionCarrier {
    compression?: CompressionDetails;
}

export const icon = "🗜";

export function formatCompressionFooter(
    details: CompressionDetails,
    theme: Theme,
): string {
    const { originalLength, compressedLength, savedPct } = details;
    return theme.fg(
        "muted",
        ` ${icon} • ${originalLength} → ${compressedLength} chars (-${savedPct}%)`,
    );
}

export function readCompressionDetails(
    details: object | undefined,
): CompressionDetails | null {
    if (!details) return null;
    const carrier = details as CompressionCarrier;
    const compression = carrier.compression;
    if (!compression) return null;
    return compression;
}

export function appendCompressionFooter(
    component: Component,
    details: object | undefined,
    theme: Theme,
): void {
    if (!(component instanceof Container)) return;
    const compression = readCompressionDetails(details);
    if (!compression) return;
    component.addChild(
        new Text(`\n${formatCompressionFooter(compression, theme)}`, 0, 0),
    );
}
