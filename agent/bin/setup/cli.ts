import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPrerequisites } from './check.ts';
import {
    downloadDistribution,
    packDistribution,
    publishDistribution,
    releaseTag,
} from './distribution.ts';
import {
    installBundle,
    rollbackInstallation,
    recoverInstallation,
    assertSetupIdle,
    assertStopped,
} from './installation.ts';

const USAGE = `Usage: pi-setup COMMAND [OPTIONS]
  pack --output DIR
  publish --from DIR --tag TAG
  install|update --release TAG [--root DIR] [--bindings FILE] [--dry-run]
  check [--root DIR]
  rollback [--root DIR] [--dry-run]
  recover [--root DIR]
  memory export --output FILE [--root DIR]
  memory import --input FILE [--root DIR]
Credentials and memories are never included in setup releases.`;

export async function runSetup(
    args: string[],
    sourceRoot: string,
): Promise<number> {
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
        console.log(USAGE);
        return 0;
    }
    try {
        const command = args.shift();
        const memoryMode = command === 'memory' ? args.shift() : undefined;
        const allowed: Record<string, string[]> = {
            pack: ['--output'],
            publish: ['--from', '--tag'],
            install: ['--release', '--root', '--bindings', '--dry-run'],
            update: ['--release', '--root', '--bindings', '--dry-run'],
            check: ['--root'],
            rollback: ['--root', '--dry-run'],
            recover: ['--root'],
            memory:
                memoryMode === 'export'
                    ? ['--output', '--root']
                    : ['--input', '--root'],
        };
        if (
            !command ||
            !allowed[command] ||
            (command === 'memory' &&
                !['export', 'import'].includes(memoryMode ?? ''))
        )
            throw new Error(USAGE);
        const flags = new Map<string, string>();
        while (args.length) {
            const flag = args.shift()!;
            if (!allowed[command]!.includes(flag) || flags.has(flag))
                throw new Error(USAGE);
            if (flag === '--dry-run') flags.set(flag, 'true');
            else {
                const value = args.shift();
                if (!value || value.startsWith('--')) throw new Error(USAGE);
                flags.set(flag, value);
            }
        }
        const required = (name: string) => {
            const value = flags.get(name);
            if (!value) throw new Error(`Missing ${name}\n${USAGE}`);
            return value;
        };
        const root = resolve(flags.get('--root') ?? join(homedir(), '.pi'));
        if (command === 'pack') {
            await packDistribution(sourceRoot, resolve(required('--output')));
            console.log(
                'Distribution prepared. Review inventory.json before publishing.',
            );
        } else if (command === 'publish') {
            publishDistribution(resolve(required('--from')), required('--tag'));
            console.log('Private immutable release published.');
        } else if (command === 'rollback')
            console.log(
                await rollbackInstallation(root, flags.has('--dry-run')),
            );
        else if (command === 'recover') {
            recoverInstallation(root);
            console.log('Previous installation restored.');
        } else if (command === 'memory') {
            assertSetupIdle(root);
            assertStopped(root);
            const { exportGlobalMemory, importGlobalMemory } =
                await import('./memory.ts');
            if (memoryMode === 'export')
                await exportGlobalMemory(
                    join(root, 'agent'),
                    resolve(required('--output')),
                );
            else
                await importGlobalMemory(
                    join(root, 'agent'),
                    resolve(required('--input')),
                );
            console.log(
                'Global memory transfer complete; sessions and project memories excluded.',
            );
        } else if (command === 'check') {
            const result = spawnSync(
                process.execPath,
                [join(root, 'agent/bin/setup/check.ts'), root],
                { cwd: root, stdio: 'inherit' },
            );
            if (result.error) throw result.error;
            return result.status ?? 1;
        } else {
            const release = releaseTag(required('--release'));
            const missing = checkPrerequisites();
            if (missing.length) throw new Error(missing.join('\n'));
            assertSetupIdle(root);
            const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-download-'));
            try {
                const bundle = downloadDistribution(release, temporary);
                console.log(
                    await installBundle({
                        root,
                        bundle,
                        release,
                        update: command === 'update',
                        dryRun: flags.has('--dry-run'),
                        bindings: flags.has('--bindings')
                            ? resolve(flags.get('--bindings')!)
                            : undefined,
                    }),
                );
                if (!flags.has('--dry-run'))
                    console.log(
                        'Run pi-setup check to review local tools and provider configuration. Add ~/.pi/bin to PATH.',
                    );
            } finally {
                rmSync(temporary, { recursive: true, force: true });
            }
        }
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
