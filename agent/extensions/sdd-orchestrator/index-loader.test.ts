import { test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// The real Node/Jiti boundary transpiles the full SDD entrypoint. Under an
// isolated repeated run it has taken up to 11.8s here, while healthy warm runs
// are 1.6–6.8s. Keep the child deadline finite but above that measured cold
// load rather than failing at Bun's generic five-second test timeout.
const LOADER_CHILD_TIMEOUT_MS = 15_000;

test('the extension entrypoint loads through Pi’s Jiti loader', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-runtime-loader-'));
    const extensionPath = join(import.meta.dir, 'index.ts');
    const packageEntry = fileURLToPath(
        import.meta.resolve('@earendil-works/pi-coding-agent'),
    );
    const loaderPath = join(dirname(packageEntry), 'core/extensions/loader.js');
    const script = `const [loaderPath, extensionPath, cwd] = process.argv.slice(1);
const { loadExtensions } = await import(loaderPath);
const result = await loadExtensions([extensionPath], cwd);
if (result.errors.length || result.extensions.length !== 1) {
    console.error(JSON.stringify({ errors: result.errors, count: result.extensions.length }));
    process.exitCode = 1;
}`;
    try {
        await execFileAsync(
            'node',
            ['--input-type=module', '-e', script, loaderPath, extensionPath, agentDir],
            {
                cwd: agentDir,
                encoding: 'utf8',
                timeout: LOADER_CHILD_TIMEOUT_MS,
                killSignal: 'SIGKILL',
                maxBuffer: 1_024 * 1_024,
            },
        );
    } catch (error) {
        const stderr =
            error && typeof error === 'object'
                ? Object.getOwnPropertyDescriptor(error, 'stderr')?.value
                : undefined;
        throw new Error(
            `Pi loader child failed within ${LOADER_CHILD_TIMEOUT_MS}ms: ${
                error instanceof Error ? error.message : String(error)
            }${typeof stderr === 'string' && stderr.trim() ? `\nstderr: ${stderr.trim()}` : ''}`,
        );
    } finally {
        rmSync(agentDir, { recursive: true, force: true });
    }
    // The child deadline is the primary hang guard; this margin guarantees it is
    // reaped and its diagnostic is surfaced before Bun's test timeout.
}, LOADER_CHILD_TIMEOUT_MS + 1_000);
