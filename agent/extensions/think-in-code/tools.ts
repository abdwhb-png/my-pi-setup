/**
 * Tool registration for the five native `think_*` tools.
 *
 * Each tool calls the ThinkCoordinator and returns bounded derived text plus
 * structured `details`. Raw command output, archive bytes, and file contents
 * are NEVER returned to the LLM — they exist only inside the archive and
 * are reanalyzable via archive IDs.
 *
 * Schema validation rejects multiple sources, unknown languages, over-limit
 * batch size, invalid archive IDs, excessive result limits, and any fetch or
 * network parameter.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import { ThinkCoordinator } from "./coordinator.ts";
import type { ThinkUpdateCallback } from "./coordinator.ts";
import {
    type IndexRequest,
    THINK_TOOL_NAMES,
    type ThinkLanguage,
    TOOL_NAMES,
} from "./types.ts";

const SUPPORTED_LANGUAGES: readonly ThinkLanguage[] = [
    "javascript",
    "typescript",
    "python",
];
const INDEX_KINDS: readonly IndexRequest["kind"][] = [
    "command-summary",
    "analysis-summary",
    "document-summary",
];

const MAX_PROGRAM_BYTES = 64 * 1024;
const MAX_INLINE_CONTENT_BYTES = 64 * 1024 * 1024;
const ARCHIVE_ID_PATTERN = "^[A-Za-z0-9_-]{8,128}$";
const MAX_SEARCH_LIMIT = 20;

// Language and program guidance. The JavaScript/TypeScript analyzer runs the
// program as an ES module; valid programs MUST use `export default <value>`
// because top-level `return` raises SyntaxError. The Python analyzer runs the
// program as a top-level statement block and reads `result` as the return
// value (assign to `result`, do not use `return` at module top level).
const LANGUAGE_DESCRIPTION =
    "Analyzer language. `javascript` and `typescript` execute as a QuickJS ES module — bindings are exposed as `const` locals and the program MUST use `export default <value>` to return its derived text. `python` runs as an Eryx JSPI sandbox — bindings become locals and the program MUST assign to a top-level `result` variable; the assignment's value becomes the returned derived text.";
const PROGRAM_DESCRIPTION =
    "Analyzer source. JavaScript/TypeScript MUST use `export default <value>` because the program is loaded as an ES module — top-level `return` is a SyntaxError. Python MUST assign to a top-level `result = <value>` variable. Bindings (INPUT, INPUTS, FILE_CONTENT, FILE_PATH, ARCHIVES, ARCHIVE_IDS, plus caller-supplied names) are exposed as locals with frozen objects and no network, filesystem, process, or fetch access.";

function requireLanguage(value: unknown): ThinkLanguage {
    if (
        typeof value !== "string" ||
        !SUPPORTED_LANGUAGES.includes(value as ThinkLanguage)
    ) {
        throw new Error(
            `Unsupported language: ${String(value)}. Expected one of ${SUPPORTED_LANGUAGES.join(", ")}.`,
        );
    }
    return value as ThinkLanguage;
}

function boundedString(name: string, value: unknown, maxBytes: number): string {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
        throw new Error(`${name} exceeds ${maxBytes} UTF-8 bytes`);
    }
    return value;
}

function requireArchiveIds(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array`);
    }
    if (
        value.some(
            (id) =>
                typeof id !== "string" ||
                !new RegExp(ARCHIVE_ID_PATTERN).test(id),
        )
    ) {
        throw new Error(`${label} contains an invalid archive id`);
    }
    return value as string[];
}

function rejectFetch(value: unknown): void {
    if (value === undefined || value === null) return;
    throw new Error("Fetch/network parameters are not supported");
}

function buildLimits(value: unknown):
    | {
          wallTimeMs?: number;
          cpuSeconds?: number;
          memoryBytes?: number;
          outputBytes?: number;
      }
    | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("limits must be an object");
    }
    const obj = value as Record<string, unknown>;
    const out: {
        wallTimeMs?: number;
        cpuSeconds?: number;
        memoryBytes?: number;
        outputBytes?: number;
    } = {};
    for (const key of [
        "wallTimeMs",
        "cpuSeconds",
        "memoryBytes",
        "outputBytes",
    ] as const) {
        const v = obj[key];
        if (v === undefined) continue;
        if (
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            !Number.isInteger(v) ||
            v <= 0
        ) {
            throw new Error(`limits.${key} must be a positive integer`);
        }
        out[key] = v;
    }
    return out;
}

const executeSchema: TSchema = Type.Object({
    language: StringEnum(SUPPORTED_LANGUAGES, {
        description: LANGUAGE_DESCRIPTION,
    }),
    program: Type.String({
        minLength: 1,
        maxLength: MAX_PROGRAM_BYTES,
        description: PROGRAM_DESCRIPTION,
    }),
    command: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
    stdin: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
    archiveIds: Type.Optional(Type.Array(Type.String())),
    limits: Type.Optional(
        Type.Object({
            wallTimeMs: Type.Optional(Type.Number()),
            cpuSeconds: Type.Optional(Type.Number()),
            memoryBytes: Type.Optional(Type.Number()),
            outputBytes: Type.Optional(Type.Number()),
        }),
    ),
    bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
    fetch: Type.Optional(Type.Unknown()),
});

const executeFileSchema: TSchema = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    language: StringEnum(SUPPORTED_LANGUAGES, {
        description: LANGUAGE_DESCRIPTION,
    }),
    program: Type.String({
        minLength: 1,
        maxLength: MAX_PROGRAM_BYTES,
        description: PROGRAM_DESCRIPTION,
    }),
    bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const batchItemSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    timeout: Type.Optional(Type.Number()),
    stdin: Type.Optional(Type.String()),
});
const batchExecuteSchema: TSchema = Type.Object({
    language: StringEnum(SUPPORTED_LANGUAGES, {
        description: LANGUAGE_DESCRIPTION,
    }),
    program: Type.String({
        minLength: 1,
        maxLength: MAX_PROGRAM_BYTES,
        description: PROGRAM_DESCRIPTION,
    }),
    items: Type.Array(batchItemSchema, { minItems: 1, maxItems: 16 }),
});

const indexSchema: TSchema = Type.Object({
    kind: StringEnum(INDEX_KINDS),
    source: Type.String({ minLength: 1, maxLength: 4096 }),
    text: Type.Optional(Type.String({ maxLength: MAX_INLINE_CONTENT_BYTES })),
    archiveIds: Type.Optional(Type.Array(Type.String())),
});

const searchSchema: TSchema = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 1024 }),
    limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: MAX_SEARCH_LIMIT }),
    ),
});

export interface ToolRuntime {
    toolCallId: string;
    signal?: AbortSignal;
    onUpdate?: ThinkUpdateCallback;
}

export interface ToolHandlers {
    execute(
        args: unknown,
        ctx: ExtensionContext,
        runtime?: ToolRuntime,
    ): Promise<unknown>;
    executeFile(
        args: unknown,
        ctx: ExtensionContext,
        runtime?: ToolRuntime,
    ): Promise<unknown>;
    batchExecute(
        args: unknown,
        ctx: ExtensionContext,
        runtime?: ToolRuntime,
    ): Promise<unknown>;
    index(args: unknown): Promise<unknown>;
    search(args: unknown): Promise<unknown>;
}

export function buildToolHandlers(coordinator: ThinkCoordinator): ToolHandlers {
    return {
        async execute(args, ctx, runtime) {
            const obj = args as Record<string, unknown>;
            rejectFetch(obj.fetch);
            const id = runtime?.toolCallId ?? boundedString("id", obj.id, 128);
            const language = requireLanguage(obj.language);
            const program = boundedString(
                "program",
                obj.program,
                MAX_PROGRAM_BYTES,
            );
            const limits = buildLimits(obj.limits);

            // Exactly one source is required.
            const sources = [
                typeof obj.command === "string",
                typeof obj.content === "string",
                Array.isArray(obj.archiveIds) && obj.archiveIds.length > 0,
            ].filter(Boolean).length;
            if (sources !== 1) {
                throw new Error(
                    "think_execute requires exactly one source: command, content, or archiveIds",
                );
            }

            const source =
                obj.command !== undefined
                    ? {
                          kind: "command" as const,
                          command: boundedString("command", obj.command, 4096),
                          timeout:
                              typeof obj.timeout === "number"
                                  ? obj.timeout
                                  : undefined,
                          stdin:
                              typeof obj.stdin === "string"
                                  ? boundedString("stdin", obj.stdin, 1_048_576)
                                  : undefined,
                      }
                    : obj.content !== undefined
                      ? {
                            kind: "content" as const,
                            content: boundedString(
                                "content",
                                obj.content,
                                MAX_INLINE_CONTENT_BYTES,
                            ),
                        }
                      : {
                            kind: "archives" as const,
                            archiveIds: requireArchiveIds(
                                obj.archiveIds,
                                "archiveIds",
                            ),
                        };
            return coordinator.execute(
                {
                    id,
                    language,
                    program,
                    source,
                    limits,
                    bindings: obj.bindings as
                        | Record<string, string>
                        | undefined,
                },
                ctx,
                runtime,
            );
        },
        async executeFile(args, ctx, runtime) {
            const obj = args as Record<string, unknown>;
            const id = runtime?.toolCallId ?? boundedString("id", obj.id, 128);
            const language = requireLanguage(obj.language);
            const program = boundedString(
                "program",
                obj.program,
                MAX_PROGRAM_BYTES,
            );
            return coordinator.executeFile(
                {
                    id,
                    language,
                    program,
                    path: boundedString("path", obj.path, 4096),
                    bindings: obj.bindings as
                        | Record<string, string>
                        | undefined,
                },
                ctx,
                runtime,
            );
        },
        async batchExecute(args, ctx, runtime) {
            const obj = args as Record<string, unknown>;
            const id = runtime?.toolCallId ?? boundedString("id", obj.id, 128);
            const language = requireLanguage(obj.language);
            const program = boundedString(
                "program",
                obj.program,
                MAX_PROGRAM_BYTES,
            );
            if (!Array.isArray(obj.items) || obj.items.length === 0) {
                throw new Error("items must be a non-empty array");
            }
            return coordinator.batchExecute(
                {
                    id,
                    language,
                    program,
                    items: obj.items as Array<{
                        id: string;
                        command: string;
                        timeout?: number;
                        stdin?: string;
                    }>,
                },
                ctx,
                runtime,
            );
        },
        async index(args) {
            const obj = args as Record<string, unknown>;
            const id = boundedString("id", obj.id, 128);
            const kind = obj.kind;
            if (
                kind !== "command-summary" &&
                kind !== "analysis-summary" &&
                kind !== "document-summary"
            ) {
                throw new Error("index kind must be a known summary type");
            }
            const archiveIds =
                obj.archiveIds === undefined
                    ? undefined
                    : requireArchiveIds(obj.archiveIds, "archiveIds");
            const text =
                typeof obj.text === "string"
                    ? boundedString("text", obj.text, MAX_INLINE_CONTENT_BYTES)
                    : undefined;
            if (
                text === undefined &&
                (archiveIds === undefined || archiveIds.length === 0)
            ) {
                throw new Error(
                    "think_index requires either text or archiveIds",
                );
            }
            return coordinator.index({
                id,
                kind,
                source: boundedString("source", obj.source, 4096),
                text,
                archiveIds,
            });
        },
        async search(args) {
            const obj = args as Record<string, unknown>;
            const id = boundedString("id", obj.id, 128);
            return coordinator.search({
                id,
                query: boundedString("query", obj.query, 1024),
                limit: typeof obj.limit === "number" ? obj.limit : undefined,
            });
        },
    };
}

export const SCHEMAS = Object.freeze({
    execute: executeSchema,
    executeFile: executeFileSchema,
    batchExecute: batchExecuteSchema,
    index: indexSchema,
    search: searchSchema,
});

export { THINK_TOOL_NAMES, TOOL_NAMES };
