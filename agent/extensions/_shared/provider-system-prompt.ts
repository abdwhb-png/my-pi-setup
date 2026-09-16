import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
type ProviderPayload = BeforeProviderRequestEvent["payload"];
function isArray(value: ProviderPayload): value is ProviderPayload[] {
    return Array.isArray(value);
}
function record(
    value: ProviderPayload,
): value is Record<string, ProviderPayload> {
    return value !== null && typeof value === "object" && !isArray(value);
}

/** Modify only text blocks. Cache-control fields and non-text content stay intact. */
function textField(
    value: ProviderPayload,
    transform: (text: string) => string,
    append: boolean,
    strip: (text: string) => string,
    plainBlock = false,
): ProviderPayload {
    if (typeof value === "string") return transform(value);
    if (value === undefined) return transform("");
    if (!isArray(value)) throw new Error("Unrecognized system content");
    let found = false;
    const result = value.map((block) => {
        if (!record(block) || typeof block.text !== "string") return block;
        const text =
            !found && append ? transform(block.text) : strip(block.text);
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
    strip: (text: string) => string,
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
            inserted ? strip : transform,
            !inserted,
            strip,
        );
        inserted = true;
        return { ...message, content };
    });
    if (!inserted) result.unshift({ role: "system", content: transform("") });
    return result;
}

/** Return a request-local copy; never mutate conversation or session state. */
export function rewriteProviderSystemPrompt(
    api: string,
    value: ProviderPayload,
    transform: (text: string) => string,
    strip: (text: string) => string,
): ProviderPayload {
    if (!record(value)) throw new Error("Provider payload is not an object");
    switch (api) {
        case "openai-completions":
        case "mistral-conversations":
            return {
                ...value,
                messages: messagePrompt(value.messages, transform, strip),
            };
        case "openai-responses":
        case "azure-openai-responses":
        case "openai-codex-responses": {
            if (!isArray(value.input))
                throw new Error("Missing Responses input");
            return typeof value.instructions === "string"
                ? {
                      ...value,
                      instructions: transform(value.instructions),
                      input: value.input.map((m) =>
                          record(m) &&
                          (m.role === "system" || m.role === "developer") &&
                          m.content !== undefined
                              ? {
                                    ...m,
                                    content: textField(
                                        m.content,
                                        strip,
                                        false,
                                        strip,
                                    ),
                                }
                              : m,
                      ),
                  }
                : {
                      ...value,
                      input: messagePrompt(value.input, transform, strip),
                  };
        }
        case "anthropic-messages":
            if (!isArray(value.messages))
                throw new Error("Missing Anthropic messages");
            return {
                ...value,
                system: textField(value.system, transform, true, strip),
            };
        case "google-generative-ai":
        case "google-vertex": {
            if (!record(value.config) || !isArray(value.contents))
                throw new Error("Missing Google config or contents");
            const system = value.config.systemInstruction;
            return {
                ...value,
                config: {
                    ...value.config,
                    systemInstruction: record(system)
                        ? {
                              ...system,
                              parts: textField(
                                  system.parts ?? [],
                                  transform,
                                  true,
                                  strip,
                                  true,
                              ),
                          }
                        : textField(system, transform, true, strip),
                },
            };
        }
        case "bedrock-converse-stream":
            if (!isArray(value.messages))
                throw new Error("Missing Bedrock messages");
            return {
                ...value,
                system:
                    value.system === undefined
                        ? [{ text: transform("") }]
                        : textField(value.system, transform, true, strip, true),
            };
        case "pi-messages":
            if (!record(value.context) || !isArray(value.context.messages))
                throw new Error("Missing Pi context");
            return {
                ...value,
                context: {
                    ...value.context,
                    systemPrompt: textField(
                        value.context.systemPrompt,
                        transform,
                        true,
                        strip,
                    ),
                },
            };
        default:
            throw new Error(`No system-prompt adapter for ${api}`);
    }
}
