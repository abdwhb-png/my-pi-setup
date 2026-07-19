import { describe, expect, it } from 'bun:test';
import { redactValue } from './redaction';

describe('redaction — sensitive keys', () => {
    it('masks values under sensitive key names (case-insensitive)', () => {
        const result = redactValue({
            authorization: 'Bearer sk-abc123',
            apiKey: 'sk-xyz',
            Api_Key: 'sk-zzz',
            token: 'ghp_xxxx',
            access_token: 'ya29.a0',
            refresh_token: 'rty.fgh',
            password: 'hunter2',
            cookie: 'session=abc',
            'set-cookie': 'tracking=yes',
            secret: 'supersecret',
            privateKey: '-----BEGIN PRIVATE KEY-----',
        });
        const v = result.value as Record<string, unknown>;
        expect(v.authorization).toBe('[REDACTED]');
        expect(v.apiKey).toBe('[REDACTED]');
        expect(v.Api_Key).toBe('[REDACTED]');
        expect(v.token).toBe('[REDACTED]');
        expect(v.access_token).toBe('[REDACTED]');
        expect(v.refresh_token).toBe('[REDACTED]');
        expect(v.password).toBe('[REDACTED]');
        expect(v.cookie).toBe('[REDACTED]');
        expect(v['set-cookie']).toBe('[REDACTED]');
        expect(v.secret).toBe('[REDACTED]');
        expect(v.privateKey).toBe('[REDACTED]');
        expect(result.counters.maskedKeys).toBe(11);
    });

    it('leaves innocent keys unchanged', () => {
        const result = redactValue({
            username: 'john',
            message: 'hello world',
            count: 42,
            items: [1, 2, 3],
        });
        const v = result.value as Record<string, unknown>;
        expect(v.username).toBe('john');
        expect(v.message).toBe('hello world');
        expect(v.count).toBe(42);
        expect(result.counters.maskedKeys).toBe(0);
    });
});

describe('redaction — secret patterns in strings', () => {
    it('redacts Bearer tokens', () => {
        const result = redactValue({ header: 'Bearer sk-abc123def456' });
        const v = result.value as Record<string, unknown>;
        expect(v.header).toBe('[REDACTED]');
        expect(result.counters.patternRedactions).toBe(1);
    });

    it('redacts sk-... API keys', () => {
        const result = redactValue({ key: 'sk-proj-abc123xyz' });
        expect((result.value as Record<string, unknown>).key).toBe(
            '[REDACTED]',
        );
    });

    it('redacts JWT tokens (three base64 segments)', () => {
        const result = redactValue({
            jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8',
        });
        expect((result.value as Record<string, unknown>).jwt).toBe(
            '[REDACTED]',
        );
        expect(result.counters.patternRedactions).toBe(1);
    });

    it('redacts sensitive env variable assignments', () => {
        const result = redactValue({
            env: 'export API_KEY=sk-abc123',
        });
        expect((result.value as Record<string, unknown>).env).toBe(
            '[REDACTED]',
        );
    });

    it('leaves normal strings alone', () => {
        const result = redactValue({
            text: 'Hello, World!',
            url: 'https://example.com',
            json: '{"valid": true}',
        });
        const v = result.value as Record<string, unknown>;
        expect(v.text).toBe('Hello, World!');
        expect(v.url).toBe('https://example.com');
        expect(v.json).toBe('{"valid": true}');
        expect(result.counters.patternRedactions).toBe(0);
    });
});

describe('redaction — depth bounding', () => {
    it('clips at maxDepth', () => {
        const deep = { a: { b: { c: { d: { e: { value: 'deep' } } } } } };
        const result = redactValue(deep, { maxDepth: 3 });
        const a = (result.value as Record<string, unknown>).a as Record<
            string,
            unknown
        >;
        const b = a.b as Record<string, unknown>;
        expect(b.c).toBe('[DEPTH_CLIPPED]');
        expect(result.counters.depthClipped).toBe(1);
    });

    it('does not clip within shallow objects', () => {
        const shallow = { a: { b: { c: 'ok' } } };
        const result = redactValue(shallow, { maxDepth: 10 });
        const v = result.value as Record<string, unknown>;
        expect((v.a as Record<string, unknown>).b).toEqual({ c: 'ok' });
        expect(result.counters.depthClipped).toBe(0);
    });
});

describe('redaction — string truncation', () => {
    it('truncates long strings and adds ellipsis', () => {
        const long = 'x'.repeat(500);
        const result = redactValue({ data: long }, { maxStringLength: 100 });
        const v = result.value as Record<string, unknown>;
        expect(typeof v.data).toBe('string');
        expect((v.data as string).length).toBe(103); // 100 + '...'
        expect((v.data as string).endsWith('...')).toBe(true);
        expect(result.counters.truncatedStrings).toBe(1);
    });

    it('does not truncate strings within limit', () => {
        const normal = 'short string';
        const result = redactValue(
            { data: normal },
            { maxStringLength: 100 },
        );
        expect(result.value).toEqual({ data: 'short string' });
        expect(result.counters.truncatedStrings).toBe(0);
    });
});

describe('redaction — array bounding', () => {
    it('truncates long arrays', () => {
        const arr = Array.from({ length: 200 }, (_, i) => i);
        const result = redactValue({ items: arr }, { maxArrayItems: 50 });
        const v = result.value as Record<string, unknown>;
        expect((v.items as unknown[]).length).toBe(51);
        expect((v.items as unknown[])[50]).toBe('[TRUNCATED: 200 items]');
        expect(result.counters.truncatedArrays).toBe(1);
    });

    it('preserves arrays within limit', () => {
        const arr = [1, 2, 3, 4, 5];
        const result = redactValue({ items: arr }, { maxArrayItems: 100 });
        const v = result.value as Record<string, unknown>;
        expect(v.items).toEqual([1, 2, 3, 4, 5]);
        expect(result.counters.truncatedArrays).toBe(0);
    });
});

describe('redaction — cycles', () => {
    it('handles circular references gracefully', () => {
        const obj: Record<string, unknown> = { name: 'parent' };
        obj.self = obj;
        const result = redactValue(obj);
        const v = result.value as Record<string, unknown>;
        expect(v.name).toBe('parent');
        expect(v.self).toBe('[CIRCULAR]');
    });
});

describe('redaction — primitives', () => {
    it('returns primitives unchanged with zero counters', () => {
        expect(redactValue(null).value).toBeNull();
        expect(redactValue(undefined).value).toBeUndefined();
        expect(redactValue(42).value).toBe(42);
        expect(redactValue('hello').value).toBe('hello');
        expect(redactValue(true).value).toBe(true);
        const r = redactValue('hello');
        expect(r.counters).toEqual({
            maskedKeys: 0,
            patternRedactions: 0,
            truncatedStrings: 0,
            truncatedArrays: 0,
            depthClipped: 0,
        });
    });
});

describe('redaction — full object integration', () => {
    it('applies all redactions in one pass', () => {
        const input = {
            user: 'john',
            apiKey: 'sk-abc123',
            logMessage: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.RuckMnOQhMqNlBq3TKGrhQ7sLxM',
            metadata: {
                token: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.RuckMnOQhMqNlBq3TKGrhQ7sLxM',
                deep: { deeper: { deepest: { inner: 'x'.repeat(5000) } } },
                tags: Array.from({ length: 300 }, (_, i) => `tag-${i}`),
            },
        };

        const result = redactValue(input, {
            maxDepth: 4,
            maxStringLength: 100,
            maxArrayItems: 50,
        });

        const v = result.value as Record<string, unknown>;
        expect(v.user).toBe('john');
        expect(v.apiKey).toBe('[REDACTED]');
        expect(v.logMessage).toBe('[REDACTED]');

        const meta = v.metadata as Record<string, unknown>;
        expect(meta.token).toBe('[REDACTED]');

        const deep = meta.deep as Record<string, unknown>;
        const deeper = deep.deeper as Record<string, unknown>;
        expect(deeper.deepest).toBe('[DEPTH_CLIPPED]');

        expect((meta.tags as unknown[]).length).toBe(51);

        expect(result.counters.maskedKeys).toBe(2); // apiKey, token
        expect(result.counters.patternRedactions).toBe(1); // logMessage
        expect(result.counters.truncatedStrings).toBe(0); // inner string is clipped before truncation
        expect(result.counters.truncatedArrays).toBe(1); // tags
        expect(result.counters.depthClipped).toBe(1); // deepest
    });
});
