import { stripVTControlCharacters } from 'node:util';

import { truncateToWidth } from '@earendil-works/pi-tui';

import { redactValue, type RedactedJsonValue } from './secret-redaction.ts';
export {
    redactValue,
    redactTextPreservingContext,
} from './secret-redaction.ts';
export type {
    RedactedJsonValue,
    RedactionOptions,
    RedactionCounters,
    RedactionResult,
    PartialRedactionOptions,
} from './secret-redaction.ts';

function normalizeDisplayControls(value: string): string {
    let normalized = '';
    for (const character of stripVTControlCharacters(value)) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === '\n' || character === '\r' || character === '\t') {
            normalized += ' ';
        } else if (codePoint >= 32 && codePoint !== 127) {
            normalized += character;
        }
    }
    return normalized.replaceAll(/\s+/g, ' ').trim();
}

function parseJsonDisplayValue(value: string): RedactedJsonValue {
    const firstCharacter = value[0];
    if (firstCharacter !== '{' && firstCharacter !== '[') return value;
    try {
        return JSON.parse(value) as RedactedJsonValue;
    } catch {
        return value;
    }
}

export function sanitizeDisplayText(value: unknown, maxWidth = 240): string {
    const normalized =
        typeof value === 'string'
            ? normalizeDisplayControls(value)
            : (JSON.stringify(value) ?? String(value));
    const parsed = parseJsonDisplayValue(normalized);
    const redacted = redactValue(parsed).value;
    const serialized =
        typeof redacted === 'string'
            ? redacted
            : (JSON.stringify(redacted) ?? String(redacted));
    return truncateToWidth(normalizeDisplayControls(serialized), maxWidth);
}
