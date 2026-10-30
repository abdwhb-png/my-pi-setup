import { expect, test } from 'bun:test';
import { run } from './files.ts';

test('subprocess failures preserve actionable context and redact known credential patterns', () => {
    try {
        run(process.execPath, [
            '-e',
            'console.error("Tool unavailable before Bearer fixture-credential-value after"); process.exit(3)',
        ]);
        throw new Error('Expected subprocess failure');
    } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('Tool unavailable before');
        expect(message).toContain('after');
        expect(message).not.toContain('fixture-credential-value');
    }
});

test('subprocess failures retain the final cause after verbose warning output', () => {
    expect(() =>
        run(process.execPath, [
            '-e',
            'console.error("warning\\n".repeat(2000)); console.error("Terminal installation cause"); process.exit(1)',
        ]),
    ).toThrow('Terminal installation cause');
});
