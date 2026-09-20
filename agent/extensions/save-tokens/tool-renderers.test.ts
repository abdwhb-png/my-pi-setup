import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatCompressionFooter as sharedFormatCompressionFooter } from "../_shared/compression-render.ts";
import { formatCompressionFooter } from "./tool-renderers.ts";

test("preserves the legacy compression renderer re-export", () => {
    expect(formatCompressionFooter).toBe(sharedFormatCompressionFooter);
    expect(
        formatCompressionFooter(
            {
                originalLength: 1_200,
                compressedLength: 300,
                savedBytes: 900,
                savedPct: 75,
            },
            { fg: (_color, text) => text } as Theme,
        ),
    ).toContain("1200 → 300");
});
