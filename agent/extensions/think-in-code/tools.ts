/**
 * Tool contracts for the three native `think_*` tools.
 *
 * Each tool calls the ThinkCoordinator and returns bounded analyzer text plus
 * structured `details`. Raw sources remain in archives unless the caller's
 * analyzer program deliberately copies them into its public result.
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
    THINK_TOOL_NAMES,
    type ThinkExecuteAction,
    type ThinkLanguage,
    TOOL_NAMES,
} from "./types.ts";

const SUPPORTED_LANGUAGES: readonly ThinkLanguage[] = [
    "javascript",
    "typescript",
    "python",
];
const EXECUTE_ACTIONS: readonly ThinkExecuteAction[] = [
    "command",
    "content",
    "archives",
    "file",
    "batch",
];

const MAX_PROGRAM_BYTES = 64 * 1024;
const MAX_INLINE_CONTENT_BYTES = 64 * 1024 * 1024;
const ARCHIVE_ID_PATTERN = "^[A-Za-z0-9_-]{8,128}$";
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_MAX_NOTE_CHARS = 1024;

// Language and program guidance. The JavaScript/TypeScript analyzer runs the
// program as an ES module; valid programs MUST use `export default <value>`
// because top-level `return` raises SyntaxError. The Python analyzer runs the
// program as a top-level statement block and reads `result` as the return
// value (assign to `result`, do not use `return` at module top level).
const LANGUAGE_DESCRIPTION =
    "Analyzer language. JavaScript/TypeScript run as QuickJS ES modules: bindings are const locals and output requires `export default <value>`. Python runs in Eryx: bindings are locals and output requires top-level `result = <value>`.";
const PROGRAM_DESCRIPTION =
    "Sandboxed analyzer source. Return only a bounded derivation, never raw bindings. JavaScript/TypeScript require `export default <value>`; Python requires top-level `result = <value>`. Bindings: INPUT, INPUTS, FILE_CONTENT, FILE_PATH, ARCHIVES, ARCHIVE_IDS and caller strings.";

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

function boundedCharacters(
    name: string,
    value: unknown,
    maxCharacters: number,
): string {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    if (Array.from(value).length > maxCharacters) {
        throw new Error(`${name} exceeds ${maxCharacters} characters`);
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

const batchItemSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        command: Type.String({ minLength: 1, maxLength: 4096 }),
        timeout: Type.Optional(Type.Number()),
        stdin: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
const searchSchema: TSchema = Type.Object(
    {
        query: Type.String({ minLength: 1, maxLength: 1024 }),
        limit: Type.Optional(
            Type.Number({ minimum: 1, maximum: MAX_SEARCH_LIMIT }),
        ),
    },
    { additionalProperties: false },
);

export function createThinkSchemas(
    maxNoteChars = DEFAULT_MAX_NOTE_CHARS,
): Readonly<{ execute: TSchema; note: TSchema; search: TSchema }> {
    const executeSchema: TSchema = Type.Object(
        {
            action: StringEnum(EXECUTE_ACTIONS, {
                description:
                    "Input source to analyze: one command, inline content, prior archives, one project file, or a command batch.",
            }),
            language: StringEnum(SUPPORTED_LANGUAGES, {
                description: LANGUAGE_DESCRIPTION,
            }),
            program: Type.String({
                minLength: 1,
                maxLength: MAX_PROGRAM_BYTES,
                description: PROGRAM_DESCRIPTION,
            }),
            command: Type.Optional(
                Type.String({ minLength: 1, maxLength: 4096 }),
            ),
            timeout: Type.Optional(Type.Number()),
            stdin: Type.Optional(Type.String()),
            content: Type.Optional(
                Type.String({ maxLength: MAX_INLINE_CONTENT_BYTES }),
            ),
            archiveIds: Type.Optional(
                Type.Array(Type.String({ pattern: ARCHIVE_ID_PATTERN })),
            ),
            path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            items: Type.Optional(
                Type.Array(batchItemSchema, { minItems: 1, maxItems: 16 }),
            ),
            limits: Type.Optional(
                Type.Object(
                    {
                        wallTimeMs: Type.Optional(Type.Number()),
                        cpuSeconds: Type.Optional(Type.Number()),
                        memoryBytes: Type.Optional(Type.Number()),
                        outputBytes: Type.Optional(Type.Number()),
                    },
                    { additionalProperties: false },
                ),
            ),
            bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
        },
        { additionalProperties: false },
    );
    const noteSchema: TSchema = Type.Object(
        {
            source: Type.String({ minLength: 1, maxLength: 4096 }),
            text: Type.String({ minLength: 1, maxLength: maxNoteChars }),
            archiveIds: Type.Optional(
                Type.Array(Type.String({ pattern: ARCHIVE_ID_PATTERN })),
            ),
        },
        { additionalProperties: false },
    );
    return Object.freeze({
        execute: executeSchema,
        note: noteSchema,
        search: searchSchema,
    });
}

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
    note(args: unknown): Promise<unknown>;
    search(args: unknown): Promise<unknown>;
}

function requireAction(value: unknown): ThinkExecuteAction {
    if (
        typeof value !== "string" ||
        !EXECUTE_ACTIONS.includes(value as ThinkExecuteAction)
    ) {
        throw new Error(
            `Unsupported think_execute action: ${String(value)}. Expected one of ${EXECUTE_ACTIONS.join(", ")}.`,
        );
    }
    return value as ThinkExecuteAction;
}

function rejectUnexpectedFields(
    obj: Record<string, unknown>,
    action: ThinkExecuteAction,
): void {
    if ("fetch" in obj || "network" in obj) {
        throw new Error("Fetch/network parameters are not supported");
    }
    const common = ["id", "action", "language", "program"];
    const byAction: Record<ThinkExecuteAction, readonly string[]> = {
        command: ["command", "timeout", "stdin", "limits", "bindings"],
        content: ["content", "limits", "bindings"],
        archives: ["archiveIds", "limits", "bindings"],
        file: ["path", "bindings"],
        batch: ["items"],
    };
    const allowed = new Set([...common, ...byAction[action]]);
    const unexpected = Object.keys(obj).find((key) => !allowed.has(key));
    if (unexpected) {
        throw new Error(
            `think_execute action ${action} does not accept ${unexpected}`,
        );
    }
}

function rejectUnexpectedNoteFields(obj: Record<string, unknown>): void {
    const allowed = new Set(["id", "source", "text", "archiveIds"]);
    const unexpected = Object.keys(obj).find((key) => !allowed.has(key));
    if (unexpected) {
        throw new Error(`think_note does not accept ${unexpected}`);
    }
}

function rejectUnexpectedSearchFields(obj: Record<string, unknown>): void {
    const allowed = new Set(["id", "query", "limit"]);
    const unexpected = Object.keys(obj).find((key) => !allowed.has(key));
    if (unexpected) {
        throw new Error(`think_search does not accept ${unexpected}`);
    }
}

export function buildToolHandlers(
    coordinator: ThinkCoordinator,
    maxNoteChars = DEFAULT_MAX_NOTE_CHARS,
): ToolHandlers {
    return {
        async execute(args, ctx, runtime) {
            const obj = args as Record<string, unknown>;
            const action = requireAction(obj.action);
            rejectUnexpectedFields(obj, action);
            const id = runtime?.toolCallId ?? boundedString("id", obj.id, 128);
            const language = requireLanguage(obj.language);
            const program = boundedString(
                "program",
                obj.program,
                MAX_PROGRAM_BYTES,
            );

            if (action === "file") {
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
            }
            if (action === "batch") {
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
            }

            const source =
                action === "command"
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
                    : action === "content"
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
                    limits: buildLimits(obj.limits),
                    bindings: obj.bindings as
                        | Record<string, string>
                        | undefined,
                },
                ctx,
                runtime,
            );
        },
        async note(args) {
            const obj = args as Record<string, unknown>;
            rejectUnexpectedNoteFields(obj);
            const id = boundedString("id", obj.id, 128);
            const archiveIds =
                obj.archiveIds === undefined
                    ? undefined
                    : requireArchiveIds(obj.archiveIds, "archiveIds");
            return coordinator.index({
                id,
                kind: "document-summary",
                source: boundedString("source", obj.source, 4096),
                text: boundedCharacters("text", obj.text, maxNoteChars),
                archiveIds,
            });
        },
        async search(args) {
            const obj = args as Record<string, unknown>;
            rejectUnexpectedSearchFields(obj);
            const id = boundedString("id", obj.id, 128);
            return coordinator.search({
                id,
                query: boundedString("query", obj.query, 1024),
                limit: typeof obj.limit === "number" ? obj.limit : undefined,
            });
        },
    };
}

export const SCHEMAS = createThinkSchemas();

export { THINK_TOOL_NAMES, TOOL_NAMES };
