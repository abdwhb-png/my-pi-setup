import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export function normalizeJsonText(text: string): string {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^~~~json\s*\n([\s\S]*?)\n~~~$/);
    return fenced ? fenced[1].trim() : trimmed;
}

export function parseStrictJson<Schema extends TSchema>(
    text: string,
    schema: Schema,
): Static<Schema> {
    const value: unknown = JSON.parse(normalizeJsonText(text));
    if (!Value.Check(schema, value)) {
        const errors = [...Value.Errors(schema, value)]
            .map((error) => error.message)
            .join('; ');
        throw new Error(`Structured output is invalid: ${errors}`);
    }
    return value;
}
