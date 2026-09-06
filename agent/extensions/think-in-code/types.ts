/**
 * Shared type definitions for Think-in-Code tools.
 *
 * These types form the contract between the coordinator and the registered
 * Pi tools. They are intentionally narrow: anything more permissive would leak
 * raw data into the LLM context (which the entire extension exists to
 * prevent).
 */

import type {
    AnalysisLanguage,
    AnalysisResult,
} from "../_shared/sandbox-runtime/analysis-protocol.ts";

export type ThinkLanguage = AnalysisLanguage;

export type ThinkExecuteAction =
    | "command"
    | "content"
    | "archives"
    | "file"
    | "batch";

export interface ExecuteSourceCommand {
    kind: "command";
    command: string;
    timeout?: number;
    stdin?: string;
}

export interface ExecuteSourceContent {
    kind: "content";
    content: string;
}

export interface ExecuteSourceArchives {
    kind: "archives";
    archiveIds: readonly string[];
}

export type ExecuteSource =
    | ExecuteSourceCommand
    | ExecuteSourceContent
    | ExecuteSourceArchives;

export interface ExecuteRequest {
    id: string;
    language: ThinkLanguage;
    program: string;
    source: ExecuteSource;
    limits?: {
        wallTimeMs?: number;
        cpuSeconds?: number;
        memoryBytes?: number;
        outputBytes?: number;
    };
    bindings?: Record<string, string>;
}

export interface BatchExecuteItem {
    id: string;
    command: string;
    timeout?: number;
    stdin?: string;
}

export interface BatchExecuteRequest {
    id: string;
    language: ThinkLanguage;
    program: string;
    items: readonly BatchExecuteItem[];
}

export type ItemStatus = "blocked" | "failed" | "succeeded";

export interface BatchItemResult {
    id: string;
    status: ItemStatus;
    archiveId?: string;
    byteCount: number;
    error?: string;
}

export interface BatchExecuteSummary {
    items: BatchItemResult[];
    blockReason?: string;
    sourceBytes: number;
    derivedBytes: number;
}

export interface IndexRequest {
    id: string;
    kind: "command-summary" | "analysis-summary";
    source: string;
    text?: string;
    archiveIds?: readonly string[];
}

export interface SearchRequest {
    id: string;
    query: string;
    limit?: number;
}

export interface ExecuteFileRequest {
    id: string;
    path: string;
    language: ThinkLanguage;
    program: string;
    bindings?: Record<string, string>;
}

export interface ToolExecutionDetails {
    archiveIds: readonly string[];
    /** LLM-visible outcome metadata mirrored in the first content block. */
    status?: "success" | "partial";
    action?: ThinkExecuteAction;
    sourceStatus?: "succeeded" | "failed" | "mixed";
    resultBytes?: number;
    /** Search hits returned by think_artifact_search. Omitted for non-search tools. */
    hitCount?: number;
    /** Searchable documents in the current project store. */
    indexedDocumentCount?: number;
    /** True when artifact search ran against an empty artifact corpus. */
    corpusEmpty?: boolean;
    /** Search strategy used for the returned hits. */
    searchMode?: "strict" | "relaxed" | "none";
    /** Unique normalized tokens in the search query. */
    queryTokenCount?: number;
    /** Query tokens matched by the strongest returned hit. */
    topMatchedTokenCount?: number;
    sourceBytes: number;
    derivedBytes: number;
    language: ThinkLanguage;
    runtime: AnalysisResult["runtime"] | "none";
    elapsedMs: number;
    truncated: boolean;
    captureWarnings: readonly string[];
    indexWarnings: readonly string[];
    blockedReason?: string;
}

export const TOOL_NAMES = Object.freeze({
    execute: "think_execute",
    artifactSearch: "think_artifact_search",
});

export type ThinkToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const THINK_TOOL_NAMES: readonly ThinkToolName[] = Object.freeze([
    TOOL_NAMES.execute,
    TOOL_NAMES.artifactSearch,
]);
