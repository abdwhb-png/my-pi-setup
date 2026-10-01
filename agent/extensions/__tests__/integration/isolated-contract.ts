import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

function descendants(pid: number): number[] {
    let children: string;
    try {
        children = readdirSync(`/proc/${pid}/task`)
            .map((thread) => {
                try {
                    return readFileSync(
                        `/proc/${pid}/task/${thread}/children`,
                        "utf8",
                    );
                } catch (error) {
                    if (
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "ENOENT"
                    )
                        return "";
                    throw error;
                }
            })
            .join(" ");
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return [];
        throw error;
    }
    return children
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .flatMap((child) => descendants(child).concat(child));
}

function kill(pid: number): void {
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
        )
            throw error;
    }
}

/** Contain process-global test mutations and terminate this contract's process group on exit or timeout. */
export function runIsolatedContract(
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let timedOut = false;
        const append = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-32_768);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const terminate = () => {
            if (!child.pid) return;
            // Bash/Analysis supervisors may create separate process groups.
            // Collect these while the stalled worker still owns their parent chain.
            try {
                for (const pid of descendants(child.pid)) kill(pid);
                kill(-child.pid);
            } catch (error) {
                clearTimeout(timer);
                child.kill("SIGKILL");
                reject(error);
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            terminate();
        }, options.timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", terminate);
        child.once("close", (code) => {
            clearTimeout(timer);
            if (timedOut)
                reject(
                    new Error(
                        `Isolated contract timed out after ${options.timeoutMs}ms.\n${output}`,
                    ),
                );
            else if (code !== 0)
                reject(
                    new Error(`Isolated contract exited ${code}.\n${output}`),
                );
            else resolve(output);
        });
    });
}
