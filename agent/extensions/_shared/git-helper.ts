import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function countUnstagedFiles(statusOutput: string) {
    if (statusOutput.length === 0) return 0;

    let count = 0;
    for (const line of statusOutput.split("\n")) {
        if (line.startsWith("??") || line[1] !== " ") count += 1;
    }
    return count;
}

export async function runGit(args: string[], cwd: string) {
    const { stdout } = await execFileAsync("git", args, {
        cwd,
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
    });
    return stdout.trimEnd();
}

export async function getUnstagedCount(cwd: string): Promise<number> {
    const status = await runGit(
        ["status", "--porcelain", "--untracked-files=normal"],
        cwd,
    );
    return countUnstagedFiles(status);
}

export async function getBranch(cwd: string): Promise<string> {
    const branch = await runGit(["branch", "--show-current"], cwd);
    if (branch.length > 0) return branch;

    const head = await runGit(["rev-parse", "--short", "HEAD"], cwd);
    return head.length > 0 ? `detached@${head}` : "unknown";
}
