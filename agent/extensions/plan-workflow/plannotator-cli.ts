export type ReviewMode = "submit" | "file" | "code";
export interface ReviewRequest {
    mode: ReviewMode;
    cwd: string;
    filePath?: string;
    browserCommand?: string;
    signal?: AbortSignal;
    executable?: string;
}
export interface ReviewDecision {
    decision: "approved" | "annotated" | "dismissed";
    feedback: string;
}
export async function runPlannotator(
    request: ReviewRequest,
): Promise<ReviewDecision> {
    if (request.signal?.aborted) throw new Error("Review cancelled");
    if (request.mode !== "code" && !request.filePath)
        throw new Error("Review requires a file path");
    const args =
        request.mode === "code"
            ? ["review", "--json"]
            : [
                  "annotate",
                  request.filePath!,
                  ...(request.mode === "submit"
                      ? ["--gate", "--json", "--require-approval"]
                      : ["--json"]),
              ];
    return new Promise((resolve, reject) => {
        const child = spawn(request.executable ?? "plannotator", args, {
            cwd: request.cwd,
            shell: false,
            env: {
                ...process.env,
                ...(request.browserCommand
                    ? { PLANNOTATOR_BROWSER: request.browserCommand }
                    : {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error) => {
            failure ??= error;
            child.kill("SIGTERM");
            killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
            killTimer.unref();
        };
        const abort = () => stop(new Error("Review cancelled"));
        const cleanup = () => {
            request.signal?.removeEventListener("abort", abort);
            if (killTimer) clearTimeout(killTimer);
        };
        request.signal?.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted) abort();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (failure) return;
            stdout += chunk;
            if (Buffer.byteLength(stdout) > 4 * 1024 * 1024)
                stop(new Error("Plannotator output exceeds 4 MiB"));
        });
        child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
        });
        child.once("error", (error) => {
            cleanup();
            reject(
                new Error(
                    `Cannot start Plannotator. Install the official CLI and ensure it is on PATH: ${error.message}`,
                ),
            );
        });
        child.once("close", (code, signal) => {
            cleanup();
            if (failure) return reject(failure);
            if (signal)
                return reject(new Error(`Plannotator terminated by ${signal}`));
            try {
                const raw: unknown = JSON.parse(stdout);
                if (!raw || typeof raw !== "object" || !("decision" in raw))
                    throw new Error("Missing decision");
                const decision = raw.decision;
                if (
                    decision !== "approved" &&
                    decision !== "annotated" &&
                    decision !== "dismissed"
                )
                    throw new Error("Unknown decision");
                const feedback =
                    request.mode === "code"
                        ? "message" in raw
                            ? raw.message
                            : undefined
                        : "feedback" in raw
                          ? raw.feedback
                          : "";
                if (typeof feedback !== "string")
                    throw new Error("Invalid feedback/message");
                const expectedExit =
                    request.mode === "submit" && decision !== "approved"
                        ? 1
                        : 0;
                if (code !== expectedExit)
                    throw new Error(
                        `Decision/exit mismatch (${decision}, exit ${code})`,
                    );
                resolve({ decision, feedback });
            } catch (error) {
                reject(
                    new Error(
                        `Invalid Plannotator result: ${String(error)}${stderr ? `\n${stderr}` : ""}`,
                    ),
                );
            }
        });
    });
}
import { spawn } from "node:child_process";
