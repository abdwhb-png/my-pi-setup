import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const openaiFastMode = {
    id: "openai",
    label: "OpenAI",
    supports(model: NonNullable<ExtensionContext["model"]>): boolean {
        return (
            ["openai", "openai-codex"].includes(model.provider.toLowerCase()) &&
            [
                "openai-responses",
                "openai-completions",
                "openai-codex-responses",
            ].includes(model.api)
        );
    },
    apply(payload: Record<string, unknown>): Record<string, unknown> {
        return { ...payload, service_tier: "priority" };
    },
};
