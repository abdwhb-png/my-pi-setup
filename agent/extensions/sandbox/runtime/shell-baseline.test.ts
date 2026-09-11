import { expect, test } from "bun:test";

import {
    buildShellPath,
    SHELL_SYSTEM_PATH_ENTRIES,
    SHELL_SYSTEM_READ_PATHS,
} from "./shell-baseline.ts";

test("defines a generic system baseline for shells and dynamic linking", () => {
    expect(SHELL_SYSTEM_READ_PATHS).toEqual([
        "/bin",
        "/sbin",
        "/usr",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/ld.so.conf.d",
    ]);
    expect(SHELL_SYSTEM_PATH_ENTRIES).toEqual([
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/usr/sbin",
        "/bin",
        "/sbin",
    ]);
    expect(buildShellPath(["/opt/tools/bin"])).toMatch(
        /^\/opt\/tools\/bin:/,
    );
});
