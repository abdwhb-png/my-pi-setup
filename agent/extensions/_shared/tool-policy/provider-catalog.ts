import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
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
export function buildToolsListSnippet(tools: readonly CatalogTool[]): string {
    const immediate = tools.filter((t) => !t.deferred);
    const deferred = tools.filter((t) => t.deferred);
    const line = (t: CatalogTool) =>
        `- ${t.name}${t.description?.trim() ? ": " + t.description.trim().split(/\r?\n/)[0] : ""}`;
    return [
        TOOLS_LIST_HEADING,
        ...(immediate.length
            ? immediate.map(line)
            : ["(no immediate function tools)"]),
        ...(deferred.length
            ? [
                  "Deferred tools (definitions supplied through the deferred-tool transport):",
                  ...deferred.map(line),
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
): string {
    const guidelines = [
        ...new Set(
            [
                ...tools.flatMap((t) => t.promptGuidelines ?? []),
                ...toolPresentation(tools),
            ]
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    ];
    const body = [
        CATALOG_START,
        buildToolsListSnippet(tools),
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

/** Modify only text blocks. Cache-control fields and non-text content stay intact. */
function textField(
    value: ProviderPayload,
    transform: (text: string) => string,
    append: boolean,
    plainBlock = false,
): ProviderPayload {
    if (typeof value === "string") return transform(value);
    if (value === undefined) return transform("");
    if (!isArray(value)) throw new Error("Unrecognized system content");
    let found = false;
    const result = value.map((block) => {
        if (!record(block) || typeof block.text !== "string") return block;
        const text =
            !found && append
                ? transform(block.text)
                : stripToolsCatalog(block.text);
        found = true;
        return { ...block, text };
    });
    if (!found && append)
        result.push(
            plainBlock
                ? { text: transform("") }
                : { type: "text", text: transform("") },
        );
    return result;
}

function messagePrompt(
    messages: ProviderPayload,
    transform: (text: string) => string,
): ProviderPayload[] {
    if (!isArray(messages)) throw new Error("Missing request messages");
    let inserted = false;
    const result = messages.map((message) => {
        if (
            !record(message) ||
            message.type === "additional_tools" ||
            (message.content === undefined && isArray(message.tools)) ||
            (message.role !== "system" && message.role !== "developer")
        )
            return message;
        const content = textField(
            message.content,
            inserted ? stripToolsCatalog : transform,
            !inserted,
        );
        inserted = true;
        return { ...message, content };
    });
    if (!inserted) result.unshift({ role: "system", content: transform("") });
    return result;
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
        let rewrite: (transform: (text: string) => string) => ProviderPayload;
        switch (api) {
            case "openai-completions":
            case "mistral-conversations":
                tools = [
                    ...definitions(value.tools),
                    ...deferredDefinitions(value.messages),
                ];
                rewrite = (transform) => ({
                    ...value,
                    messages: messagePrompt(value.messages, transform),
                });
                break;
            case "openai-responses":
            case "azure-openai-responses":
            case "openai-codex-responses": {
                if (!isArray(value.input))
                    throw new Error("Missing Responses input");
                const input = value.input;
                tools = [
                    ...definitions(value.tools),
                    ...deferredDefinitions(input),
                ];
                rewrite = (transform) =>
                    typeof value.instructions === "string"
                        ? {
                              ...value,
                              instructions: transform(value.instructions),
                              input: input.map((m) =>
                                  record(m) &&
                                  (m.role === "system" ||
                                      m.role === "developer") &&
                                  m.content !== undefined
                                      ? {
                                            ...m,
                                            content: textField(
                                                m.content,
                                                stripToolsCatalog,
                                                false,
                                            ),
                                        }
                                      : m,
                              ),
                          }
                        : { ...value, input: messagePrompt(input, transform) };
                break;
            }
            case "anthropic-messages":
                if (!isArray(value.messages))
                    throw new Error("Missing Anthropic messages");
                tools = definitions(value.tools);
                rewrite = (transform) => ({
                    ...value,
                    system: textField(value.system, transform, true),
                });
                break;
            case "google-generative-ai":
            case "google-vertex": {
                if (!record(value.config) || !isArray(value.contents))
                    throw new Error("Missing Google config or contents");
                const config = value.config;
                tools = definitions(config.tools);
                rewrite = (transform) => {
                    const system = config.systemInstruction;
                    return {
                        ...value,
                        config: {
                            ...config,
                            systemInstruction: record(system)
                                ? {
                                      ...system,
                                      parts: textField(
                                          system.parts === undefined
                                              ? []
                                              : system.parts,
                                          transform,
                                          true,
                                          true,
                                      ),
                                  }
                                : textField(system, transform, true),
                        },
                    };
                };
                break;
            }
            case "bedrock-converse-stream":
                if (!isArray(value.messages))
                    throw new Error("Missing Bedrock messages");
                if (value.toolConfig !== undefined && !record(value.toolConfig))
                    throw new Error("Invalid Bedrock tool config");
                tools = definitions(
                    record(value.toolConfig)
                        ? value.toolConfig.tools
                        : undefined,
                );
                rewrite = (transform) => ({
                    ...value,
                    system:
                        value.system === undefined
                            ? [{ text: transform("") }]
                            : textField(value.system, transform, true, true),
                });
                break;
            case "pi-messages": {
                if (!record(value.context) || !isArray(value.context.messages))
                    throw new Error("Missing Pi context");
                const context = value.context;
                tools = definitions(context.tools);
                rewrite = (transform) => ({
                    ...value,
                    context: {
                        ...context,
                        systemPrompt: textField(
                            context.systemPrompt,
                            transform,
                            true,
                        ),
                    },
                });
                break;
            }
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
        const payload = rewrite((prompt) =>
            appendToolsListPrompt(prompt, tools),
        );
        return {
            supported: true,
            payload,
            tools,
            block: appendToolsListPrompt("", tools).trim(),
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
