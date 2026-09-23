import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

export const HERDR_WIDGET_ID = "herdr-tools";

export function buildHerdrWidgetText(enabled: boolean): string {
	return `herdr: ${enabled ? "on" : "off"}`;
}

/** Renders Herdr tool visibility for the footer; `null` (hidden) while off. */
export function renderHerdrWidget(
	theme: Theme | undefined | null,
	enabled: boolean,
): string | null {
	if (!enabled) return null;
	const colors = createUiColors(
		theme?.fg ? theme : { fg: (_color, text: string) => text },
	);
	return `${colors.subtle("herdr:")} ${colors.success("on")}`;
}