import {
    executionFromDetails,
    unknownExecution,
    type ExecutionProvenance,
} from "../_shared/execution-provenance/index.ts";
import {
    recordSandboxExecutionContext,
    sandboxExecutionContextFromError,
} from "../_shared/sandbox-runtime/execution-context.ts";
import type { AnalysisSandboxPort } from "../_shared/sandbox-runtime/index.ts";
import { isThinkExecutionError } from "./public-contract.ts";

export interface ThinkExecutionProvenance {
    sourceExecution: ExecutionProvenance;
    analysisExecution: ExecutionProvenance;
    sourceExecutions?: { id: string; execution: ExecutionProvenance }[];
}

export interface ThinkAnalysisTrace {
    run(
        port: AnalysisSandboxPort,
        ...args: Parameters<AnalysisSandboxPort["run"]>
    ): ReturnType<AnalysisSandboxPort["run"]>;
}

/** Keep each invocation's observations local, including overlapping batches. */
export async function withThinkExecution<
    T extends { content: { type: "text"; text: string }[]; details: object },
>(
    source: () => Pick<
        ThinkExecutionProvenance,
        "sourceExecution" | "sourceExecutions"
    >,
    run: (trace: ThinkAnalysisTrace) => Promise<T>,
): Promise<T & { details: T["details"] & ThinkExecutionProvenance }> {
    let analysisExecution = unknownExecution();
    try {
        const result = await run({
            run: async (port, ...args) => {
                const [request] = args;
                try {
                    const result = await port.run(...args);
                    analysisExecution = result.execution ?? unknownExecution();
                    if (result.sandboxContext) {
                        recordSandboxExecutionContext(
                            request.id,
                            result.sandboxContext,
                        );
                    }
                    return result;
                } catch (error) {
                    analysisExecution = executionFromDetails(error) ?? {
                        ...unknownExecution(),
                        outcome: "failed",
                    };
                    const sandboxContext =
                        sandboxExecutionContextFromError(error);
                    if (sandboxContext) {
                        recordSandboxExecutionContext(
                            request.id,
                            sandboxContext,
                        );
                    }
                    throw error;
                }
            },
        });
        const execution = { ...source(), analysisExecution };
        const [header, ...rest] = result.content;
        return {
            ...result,
            content: header
                ? [
                      {
                          ...header,
                          text: JSON.stringify({
                              ...JSON.parse(header.text),
                              ...execution,
                          }),
                      },
                      ...rest,
                  ]
                : result.content,
            details: { ...result.details, ...execution },
        };
    } catch (error) {
        if (isThinkExecutionError(error)) {
            const payload = JSON.parse(error.message);
            const sources = source();
            if (
                payload.stage === "source" &&
                sources.sourceExecution.status === "unsandboxed"
            ) {
                sources.sourceExecution = {
                    ...sources.sourceExecution,
                    outcome: "failed",
                };
            }
            error.message = JSON.stringify({
                ...payload,
                ...sources,
                analysisExecution,
            });
        }
        throw error;
    }
}
