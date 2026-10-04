import { mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const realFs = { ...fs };
const realOs = { ...os };

/** Pi's package manager reads HOME directly; exclude that personal skill root too. */
export async function isolateSkillHome(
    root: string,
    cleanup: Array<() => void | Promise<void>>,
): Promise<void> {
    const userSkills = join(
        process.env.HOME ?? realOs.homedir(),
        ".agents/skills",
    );
    const existsSync: typeof fs.existsSync = (path) =>
        String(path) !== userSkills && realFs.existsSync(path);
    cleanup.push(async () => {
        await mock.module("node:os", () => realOs);
        await mock.module("os", () => realOs);
        await mock.module("node:fs", () => realFs);
        await mock.module("fs", () => realFs);
    });
    await mock.module("node:os", () => ({ ...realOs, homedir: () => root }));
    await mock.module("os", () => ({ ...realOs, homedir: () => root }));
    await mock.module("node:fs", () => ({ ...realFs, existsSync }));
    await mock.module("fs", () => ({ ...realFs, existsSync }));
}
