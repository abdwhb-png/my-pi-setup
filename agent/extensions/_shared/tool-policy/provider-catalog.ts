import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import {
    piMessagesTranscript,
    rewriteProviderSystemPrompt,
} from "../provider-system-prompt.ts";
import { toolPresentation, type PresentedTool } from "./presentation.ts";
type ProviderPayload = BeforeProviderRequestEvent["payload"];

function isArray(value: ProviderPayload): value is ProviderPayload[] {
    return Array.isArray(value);
}

export const TOOLS_LIST_HEADING = "Available tools:";
export const TOOL_GUIDELINES_HEADING = "Tool usage guidelines:";
export const CATALOG_START = "<pi-runtime-tools>";
export const CATALOG_END = "</pi-runtime-tools>";
type ObjectValue = Record<string, ProviderPayload>;
function record(value: ProviderPayload): value is ObjectValue {
    return value !== null && typeof value === "object" && !isArray(value);
}

export interface CatalogTool extends PresentedTool {
    promptGuidelines?: readonly string[];
}
function toolLine(tool: CatalogTool): string {
    return `- ${tool.name}${tool.description?.trim() ? ": " + tool.description.trim().split(/\r?\n/)[0] : ""}`;
}
export type ToolSelection =
    | { mode: "auto" }
    | { mode: "required" }
    | { mode: "none" }
    | { mode: "named"; names: readonly string[] }
    | { mode: "unspecified" };

function callableTools(
    tools: readonly CatalogTool[],
    selection: ToolSelection,
): CatalogTool[] | undefined {
    const immediate = tools.filter((t) => !t.deferred);
    switch (selection.mode) {
        case "auto":
        case "required":
            return immediate;
        case "none":
            return [];
        case "named": {
            const names = new Set(selection.names);
            return immediate.filter((tool) => names.has(tool.name));
        }
        case "unspecified":
            return immediate.length ? undefined : [];
    }
    return undefined;
}

export function buildToolsListSnippet(
    tools: readonly CatalogTool[],
    selection: ToolSelection = { mode: "auto" },
): string {
    const immediate = tools.filter((t) => !t.deferred);
    const deferred = tools.filter((t) => t.deferred);
    const callable = callableTools(tools, selection);
    const callableNames = new Set(callable?.map((tool) => tool.name));
    const unavailable =
        callable === undefined
            ? immediate
            : immediate.filter((tool) => !callableNames.has(tool.name));
    return [
        TOOLS_LIST_HEADING,
        ...(immediate.length === 0
            ? ["(no immediate function tools)"]
            : callable === undefined
              ? ["(callability unspecified by this provider request)"]
              : callable.length
                ? callable.map(toolLine)
                : ["(no immediately callable function tools)"]),
        ...(selection.mode === "required"
            ? ["Tool selection: one of the available tools is required."]
            : selection.mode === "named"
              ? [
                    `Tool selection: restricted to ${selection.names.join(", ") || "(missing named tool)"}.`,
                ]
              : []),
        ...(unavailable.length
            ? [
                  selection.mode === "unspecified"
                      ? "Tool schemas present (callability unspecified):"
                      : "Schemas disabled for this request:",
                  ...unavailable.map(toolLine),
              ]
            : []),
        ...(deferred.length
            ? [
                  "Deferred tools (definitions supplied through the deferred-tool transport):",
                  ...deferred.map(toolLine),
              ]
            : []),
    ].join("\n");
}
export function stripToolsCatalog(prompt: string): string {
    return prompt.replace(
        /\n{0,2}<pi-runtime-tools>[\s\S]*?<\/pi-runtime-tools>/g,
        "",
    );
}
export function appendToolsListPrompt(
    prompt: string,
    tools: readonly CatalogTool[],
    selection: ToolSelection = { mode: "auto" },
): string {
    const callable = callableTools(tools, selection) ?? [];
    const guidelines = [
        ...new Set(
            [
                ...callable.flatMap((t) => t.promptGuidelines ?? []),
                ...toolPresentation(callable),
            ]
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    ];
    const body = [
        CATALOG_START,
        buildToolsListSnippet(tools, selection),
        ...(guidelines.length
            ? [TOOL_GUIDELINES_HEADING, ...guidelines.map((s) => `- ${s}`)]
            : []),
        CATALOG_END,
    ].join("\n");
    return `${stripToolsCatalog(prompt)}\n\n${body}`;
}

export type CatalogResult =
    | {
          supported: true;
          payload: ProviderPayload;
          tools: PresentedTool[];
          callableTools: PresentedTool[] | undefined;
          selection: ToolSelection;
          block: string;
      }
    | { supported: false; reason: string };

function definitions(
    value: ProviderPayload,
    deferred = false,
): PresentedTool[] {
    if (value === undefined) return [];
    if (!isArray(value)) throw new Error("Tool definitions must be an array");
    return value.flatMap((entry): PresentedTool[] => {
        if (!record(entry)) throw new Error("Invalid tool definition");
        if (isArray(entry.functionDeclarations))
            return definitions(entry.functionDeclarations, deferred);
        if (entry.type === "namespace" && typeof entry.name === "string") {
            const namespace = entry.name;
            return definitions(entry.tools, deferred).map((t) => ({
                ...t,
                name: `${namespace}.${t.name}`,
            }));
        }
        const tool = record(entry.function)
            ? entry.function
            : record(entry.toolSpec)
              ? entry.toolSpec
              : entry;
        // Provider-native tools have no Pi function schema. Do not advertise them as Pi functions.
        if (typeof tool.name !== "string") {
            if (
                typeof entry.type === "string" ||
                record(entry.googleSearch) ||
                record(entry.codeExecution) ||
                record(entry.cachePoint)
            )
                return [];
            throw new Error("Missing function tool name");
        }
        if (!tool.name.trim()) throw new Error("Empty function tool name");
        if (
            tool.description !== undefined &&
            typeof tool.description !== "string"
        )
            throw new Error("Invalid function tool description");
        return [
            {
                name: tool.name,
                description: tool.description,
                deferred:
                    deferred ||
                    entry.defer_loading === true ||
                    tool.defer_loading === true,
            },
        ];
    });
}

function deferredDefinitions(messages: ProviderPayload): PresentedTool[] {
    if (!isArray(messages)) return [];
    return messages.flatMap((message) => {
        if (!record(message)) return [];
        const direct =
            message.type === "tool_search_output" ||
            message.type === "additional_tools" ||
            (message.role === "system" && isArray(message.tools))
                ? definitions(message.tools, true)
                : [];
        const additional = definitions(message.additional_tools, true);
        // Kimi deferred function definitions are carried by tool-result messages.
        const nested = record(message.tool_response)
            ? definitions(message.tool_response.tools, true)
            : [];
        return [...direct, ...additional, ...nested];
    });
}

function namedSelection(names: ProviderPayload): ToolSelection {
    if (!isArray(names) || !names.every((name) => typeof name === "string"))
        throw new Error("Invalid named tool selection");
    const unique = [
        ...new Set(names.map((name) => name.trim()).filter(Boolean)),
    ];
    if (!unique.length) throw new Error("Empty named tool selection");
    return { mode: "named", names: unique };
}

function standardSelection(value: ProviderPayload): ToolSelection {
    if (value === undefined) return { mode: "unspecified" };
    if (typeof value === "string") {
        switch (value.toLowerCase()) {
            case "auto":
            case "validated":
                return { mode: "auto" };
            case "required":
            case "any":
                return { mode: "required" };
            case "none":
                return { mode: "none" };
            default:
                throw new Error(`Unsupported tool selection: ${value}`);
        }
    }
    if (!record(value)) throw new Error("Invalid tool selection");
    if (typeof value.type === "string") {
        switch (value.type.toLowerCase()) {
            case "auto":
            case "validated":
                return { mode: "auto" };
            case "required":
            case "any":
                return { mode: "required" };
            case "none":
                return { mode: "none" };
            case "function":
                if (
                    record(value.function) &&
                    typeof value.function.name === "string"
                )
                    return namedSelection([value.function.name]);
                if (typeof value.name === "string")
                    return namedSelection([value.name]);
                break;
            case "tool":
                if (typeof value.name === "string")
                    return namedSelection([value.name]);
                break;
        }
    }
    if (record(value.function) && typeof value.function.name === "string")
        return namedSelection([value.function.name]);
    if (typeof value.name === "string") return namedSelection([value.name]);
    if (value.auto !== undefined) return { mode: "auto" };
    if (value.any !== undefined) return { mode: "required" };
    if (record(value.tool) && typeof value.tool.name === "string")
        return namedSelection([value.tool.name]);
    throw new Error("Unsupported tool selection object");
}

function googleSelection(config: ObjectValue): ToolSelection {
    if (config.toolConfig === undefined) return { mode: "unspecified" };
    if (!record(config.toolConfig))
        throw new Error("Invalid Google tool config");
    const functionCallingConfig = config.toolConfig.functionCallingConfig;
    if (functionCallingConfig === undefined) return { mode: "unspecified" };
    if (!record(functionCallingConfig))
        throw new Error("Invalid Google function calling config");
    const mode = standardSelection(functionCallingConfig.mode);
    if (mode.mode === "none") return mode;
    return functionCallingConfig.allowedFunctionNames === undefined
        ? mode
        : namedSelection(functionCallingConfig.allowedFunctionNames);
}

function providerSelection(api: string, value: ObjectValue): ToolSelection {
    switch (api) {
        case "openai-completions":
        case "openai-responses":
        case "azure-openai-responses":
        case "openai-codex-responses":
        case "anthropic-messages":
            return standardSelection(value.tool_choice);
        case "mistral-conversations":
            return standardSelection(value.toolChoice);
        case "google-generative-ai":
        case "google-vertex":
            if (!record(value.config)) throw new Error("Missing Google config");
            return googleSelection(value.config);
        case "bedrock-converse-stream":
            return record(value.toolConfig)
                ? standardSelection(value.toolConfig.toolChoice)
                : { mode: "unspecified" };
        case "pi-messages":
            if (value.options === undefined) return { mode: "unspecified" };
            if (!record(value.options)) throw new Error("Invalid Pi options");
            return standardSelection(value.options.toolChoice);
        default:
            return { mode: "unspecified" };
    }
}

/** The outgoing payload, not getActiveTools(), is the authority for this request. */
export function injectProviderToolsCatalog(
    api: string,
    value: ProviderPayload,
): CatalogResult {
    if (!record(value))
        return {
            supported: false,
            reason: "Provider payload is not an object",
        };
    try {
        let tools: PresentedTool[];
        const selection = providerSelection(api, value);
        switch (api) {
            case "openai-completions":
            case "mistral-conversations":
                tools = [
                    ...definitions(value.tools),
                    ...deferredDefinitions(value.messages),
                ];
                break;
            case "openai-responses":
            case "azure-openai-responses":
            case "openai-codex-responses":
                tools = [
                    ...definitions(value.tools),
                    ...deferredDefinitions(value.input),
                ];
                break;
            case "anthropic-messages":
                tools = definitions(value.tools);
                break;
            case "google-generative-ai":
            case "google-vertex":
                if (!record(value.config))
                    throw new Error("Missing Google config or contents");
                tools = definitions(value.config.tools);
                break;
            case "bedrock-converse-stream":
                if (value.toolConfig !== undefined && !record(value.toolConfig))
                    throw new Error("Invalid Bedrock tool config");
                tools = definitions(
                    record(value.toolConfig)
                        ? value.toolConfig.tools
                        : undefined,
                );
                break;
            case "pi-messages":
                tools = definitions(
                    getCurrentTools(piMessagesTranscript(value)),
                );
                break;
            default:
                return {
                    supported: false,
                    reason: `No tools-catalog adapter for ${api}`,
                };
        }
        const unique = new Map<string, PresentedTool>();
        for (const tool of tools) {
            const previous = unique.get(tool.name);
            if (!previous || (previous.deferred && !tool.deferred))
                unique.set(tool.name, tool);
        }
        tools = [...unique.values()];
        const selected = callableTools(tools, selection);
        const payload = rewriteProviderSystemPrompt(
            api,
            value,
            (prompt) => appendToolsListPrompt(prompt, tools, selection),
            stripToolsCatalog,
        );
        return {
            supported: true,
            payload,
            tools,
            callableTools: selected,
            selection,
            block: appendToolsListPrompt("", tools, selection).trim(),
        };
    } catch (error) {
        return {
            supported: false,
            reason:
                error instanceof Error
                    ? error.message
                    : "Invalid provider payload",
        };
    }
}
