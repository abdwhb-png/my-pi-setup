import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderBoxContentLines } from "../_shared/ui/framed-box";

export function renderCwd(
    theme: Theme,
    innerWidth: number,
    cwd: string,
): string[] {
    return renderBoxContentLines(
        theme,
        innerWidth,
        theme.fg("accent", theme.bold(`CWD: ${cwd}`)),
    );
}
