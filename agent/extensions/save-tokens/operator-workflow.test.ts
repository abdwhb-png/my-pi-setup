import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = import.meta.dirname;

describe('Pi compression operator integration', () => {
    test('the integration verifier covers timeouts and byte-identical archive recovery', () => {
        const script = readFileSync(resolve(ROOT, 'scripts/verify-local-backends.ts'), 'utf8');
        expect(script).toContain('headroom: 30_000');
        expect(script).toContain('edgee: 5_000');
        expect(script).toContain('timeoutMs: E2E_TIMEOUT_MS[backendId]');
        expect(script).toContain('archiveOriginal: archiveOriginalToolResult');
        expect(script).toContain('details?.compression.archivePath');
        expect(script).toContain('readFileSync(archivePath, "utf8") !== fixture.text');
        expect(script).toContain('mkdtempSync(');
        expect(script).toContain('join(tmpdir(),');
    });

    test('the local guide documents configuration, recovery, and the ingress decision', () => {
        const readme = readFileSync(resolve(ROOT, 'README.COMPRESSION.md'), 'utf8');
        for (const requirement of [
            'saveTokens.compressor.backend',
            'HEADROOM_COMPRESSOR_BASE_URL',
            'EDGEE_COMPRESSOR_BASE_URL',
            '/reload',
            'fail-open',
            'tool-result-archive',
            'save-tokens-telemetry',
        ]) expect(readme).toContain(requirement);
        expect(readFileSync(resolve(ROOT, '../../../docs/adr/ADR-012-local-compression-ingress-relays.md'), 'utf8')).not.toBe('');
    });
});
