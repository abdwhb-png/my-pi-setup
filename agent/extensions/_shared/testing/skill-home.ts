import { mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const realFs = { ...fs };
const realOs = { ...os };

/** Pi's package manager reads HOME directly; exclude that personal skill root too. */
export function isolateSkillHome(
    root: string,
    cleanup: Array<() => void>,
): void {
    const userSkills = join(
        process.env.HOME ?? realOs.homedir(),
        ".agents/skills",
    );
    const existsSync: typeof fs.existsSync = (path) =>
        String(path) !== userSkills && realFs.existsSync(path);
    cleanup.push(() => {
        mock.module("node:os", () => realOs);
        mock.module("os", () => realOs);
        mock.module("node:fs", () => realFs);
        mock.module("fs", () => realFs);
    });
    mock.module("node:os", () => ({ ...realOs, homedir: () => root }));
    mock.module("os", () => ({ ...realOs, homedir: () => root }));
    mock.module("node:fs", () => ({ ...realFs, existsSync }));
    mock.module("fs", () => ({ ...realFs, existsSync }));
}
