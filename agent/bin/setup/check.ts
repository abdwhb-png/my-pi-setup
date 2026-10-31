import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyRuntimeCoherence } from '../pi-fork-release.ts';
import { loadCurrentPiRuntime } from '../pi-runtime-store.ts';
import { assertInventory, json, run } from './files.ts';
import { assertSetupIdle, readInstallation } from './installation.ts';

export function checkPrerequisites(): string[] {
    if (process.platform !== 'linux' || process.arch !== 'x64')
        throw new Error('This setup supports Linux/WSL2 x86_64 only');
    const missing: string[] = [];
    for (const command of ['git', 'python3', 'bun', 'node', 'sfw', 'gh']) {
        try {
            run(command, ['--version']);
        } catch {
            missing.push(
                `${command}: install it on the host before retrying (see docs/portable-setup.md)`,
            );
        }
    }
    return missing;
}
export async function checkInstallation(root: string): Promise<string[]> {
    assertSetupIdle(root);
    const state = readInstallation(root);
    assertInventory(root, state.managed);
    const agentDir = join(root, 'agent');
    const coherence = verifyRuntimeCoherence(
        loadCurrentPiRuntime(join(root, 'runtime/pi-core')),
        agentDir,
    );
    if (!coherence.ok) throw new Error(coherence.errors.join('\n'));
    const { verifyPackages } = await import('./provision.ts');
    const settings = json(join(agentDir, 'settings.json'));
    const sources = Array.isArray(settings.packages)
        ? settings.packages.map((p) => (typeof p === 'string' ? p : p.source))
        : [];
    await verifyPackages(root, sources);
    const { readPrivateRuntimeEntry, resolvePrivateRuntime } =
        await import('../../extensions/sandbox/runtime/runtime-bundle.ts');
    const entry = await readPrivateRuntimeEntry(
        join(root, 'bin/zerobox'),
        new URL(
            '../../extensions/sandbox/runtime/zerobox-provenance.json',
            import.meta.url,
        ),
    );
    await resolvePrivateRuntime({
        binaryPath: entry.binaryPath,
        expectedBinarySha256: entry.provenance.binarySha256,
    });
    const notices = checkPrerequisites();
    const bindings = join(agentDir, 'config/setup-bindings.json');
    try {
        run(
            process.execPath,
            [
                join(agentDir, 'scripts/configure-sandbox.ts'),
                'check',
                '--agent-dir',
                agentDir,
                ...(existsSync(bindings) ? ['--bindings', bindings] : []),
            ],
            root,
            { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        );
    } catch (error) {
        notices.push(
            `Sandbox tool bindings need configuration: run bun agent/scripts/configure-sandbox.ts preview. ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (
        !existsSync(join(agentDir, 'auth.json')) &&
        !existsSync(join(agentDir, 'ai-providers.secrets.json')) &&
        !existsSync(join(agentDir, 'config/ai-providers.secrets.json'))
    )
        notices.push(
            'Provider credentials are not present in the standard files. Configure your existing secure credential channel; provider connectivity has not been tested.',
        );
    return notices;
}
if (import.meta.main) {
    try {
        const notices = await checkInstallation(resolve(process.argv[2]!));
        for (const notice of notices) console.log(notice);
        console.log(
            notices.length
                ? 'Setup installed; local configuration remains incomplete.'
                : 'Setup integrity and configured tools verified. Provider connectivity not tested.',
        );
        process.exitCode = notices.length ? 1 : 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
