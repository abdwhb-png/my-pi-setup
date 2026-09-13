import { expect, test } from "bun:test";

import {
    buildShellPath,
    SHELL_SYSTEM_PATH_ENTRIES,
    SHELL_SYSTEM_READ_PATHS,
} from "./shell-baseline.ts";

test("provides private commands with no implicit host filesystem grants", () => {
    expect(SHELL_SYSTEM_READ_PATHS).toEqual([]);
    expect(SHELL_SYSTEM_PATH_ENTRIES).toEqual(["/__zerobox/runtime/bin"]);
    expect(buildShellPath(["/opt/tools/bin"])).toBe("/opt/tools/bin:/__zerobox/runtime/bin");
});
