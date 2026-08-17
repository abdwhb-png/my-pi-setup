const HEADROOM_MODEL_ALIASES: Record<string, string> = {
    "gpt-4o-2024-11-20": "gpt-4o",
    "gpt-4o-2024-08-06": "gpt-4o",
    "gpt-4o-2024-05-13": "gpt-4o",
    "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
    "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
    "claude-sonnet-4-20250514": "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
    "claude-3-opus-latest": "claude-3-opus-20240229",
};

export { HEADROOM_MODEL_ALIASES };

export function mapHeadroomModel(modelId: string): string {
    return HEADROOM_MODEL_ALIASES[modelId] ?? modelId;
}
