import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHomePath } from '../../extensions/_shared/home-path.ts';
import { redactTextPreservingContext } from '../../extensions/_shared/secret-redaction.ts';
import { checkPrerequisites } from './check.ts';
import {
    downloadDistribution,
    packDistribution,
    publishDistribution,
    releaseTag,
    refreshMain,
    resolveMainCommit,
} from './distribution.ts';
import { runAsync } from './files.ts';
import {
    installBundle,
    rollbackInstallation,
    recoverInstallation,
    assertSetupIdle,
    assertStopped,
    readInstallation,
} from './installation.ts';
import { SetupProgressReporter, setupStep } from './progress.ts';

const COMMANDS = {
    pack: {
        flags: ['--output', '--source-sha', '--include-global-skills'],
        required: ['--output'],
        usage: '--output DIR [--source-sha SHA] [--include-global-skills]',
        description:
            'Package approved main code and the current profile. Global skills are excluded by default.',
        examples: [
            'pack --output ~/pi-candidate',
            'pack --output ~/pi-candidate --include-global-skills',
        ],
    },
    publish: {
        flags: ['--from', '--tag'],
        required: ['--from', '--tag'],
        usage: '--from DIR --tag TAG',
        description:
            'Create a private draft and request qualification. Dispatch is not publication success.',
        examples: ['publish --from ~/pi-candidate --tag setup-YYYY-MM-DD.1'],
    },
    install: {
        flags: ['--release', '--root', '--bindings', '--dry-run', '--details'],
        required: ['--release'],
        usage: '--release TAG [--root DIR] [--bindings FILE] [--dry-run [--details]]',
        description:
            'Install a release into a new directory. Preview does not create an installation.',
        examples: [
            'install --release setup-YYYY-MM-DD.1 --dry-run',
            'install --release setup-YYYY-MM-DD.1',
        ],
    },
    update: {
        flags: ['--release', '--root', '--bindings', '--dry-run', '--details'],
        required: ['--release'],
        usage: '--release TAG [--root DIR] [--bindings FILE] [--dry-run [--details]]',
        description:
            'Update a managed installation while preserving local state. Modified managed files are refused.',
        examples: [
            'update --release setup-YYYY-MM-DD.2 --dry-run --details',
            'update --release setup-YYYY-MM-DD.2',
        ],
    },
    check: {
        flags: ['--root'],
        required: [],
        usage: '[--root DIR]',
        description:
            'Check installed files, runtimes, packages and tools. Provider connectivity is not tested.',
        examples: ['check', 'check --root ~/my-pi'],
    },
    cleanup: {
        flags: ['--root', '--dry-run'],
        required: [],
        usage: '[--root DIR] [--dry-run]',
        description:
            'Remove unused recognized runtimes. The result is JSON; active and protected releases are retained.',
        examples: ['cleanup --dry-run', 'cleanup'],
    },
    rollback: {
        flags: ['--root', '--dry-run'],
        required: [],
        usage: '[--root DIR] [--dry-run]',
        description:
            'Restore the previous managed release while retaining current personal state.',
        examples: ['rollback --dry-run', 'rollback'],
    },
    recover: {
        flags: ['--root'],
        required: [],
        usage: '[--root DIR]',
        description:
            'Recover an interrupted operation. A running transaction is refused; no pending operation is a no-op.',
        examples: ['recover', 'recover --root ~/my-pi'],
    },
    'memory export': {
        flags: ['--output', '--root'],
        required: ['--output'],
        usage: '--output FILE [--root DIR]',
        description:
            'Export global memory separately. Sessions and project memories are excluded.',
        examples: ['memory export --output ~/pi-memory.json'],
    },
    'memory import': {
        flags: ['--input', '--root'],
        required: ['--input'],
        usage: '--input FILE [--root DIR]',
        description:
            'Import global memory into an empty destination. An identical import is a no-op.',
        examples: ['memory import --input ~/pi-memory.json'],
    },
} satisfies Record<
    string,
    {
        flags: string[];
        required: string[];
        usage: string;
        description: string;
        examples: string[];
    }
>;

const USAGE = `Usage: pi-setup COMMAND [OPTIONS]\n${Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${name} ${spec.usage}`)
    .join(
        '\n',
    )}\nUse pi-setup COMMAND --help for command details.\ninstall|update require an explicit --release. Credentials and memories are never included in setup releases.`;
class UsageError extends Error {}
function isCommand(value: string | undefined): value is keyof typeof COMMANDS {
    return value !== undefined && Object.hasOwn(COMMANDS, value);
}
function commandHelp(command: keyof typeof COMMANDS): string {
    const spec = COMMANDS[command];
    return `Usage: pi-setup ${command} ${spec.usage}\n${spec.description}\nOptions: ${spec.flags.join(', ')}, --help, -h${spec.flags.some((flag) => flag === '--root') ? '\nDefault --root: ~/.pi' : ''}\nExamples:\n${spec.examples.map((example) => `  pi-setup ${example}`).join('\n')}`;
}
function inputPath(value: string): string {
    return resolve(expandHomePath(value));
}
function quote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runSetup(
    args: string[],
    sourceRoot: string,
): Promise<number> {
    let reporter: SetupProgressReporter | undefined;
    try {
        if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
            console.log(USAGE);
            return 0;
        }
        const first = args.shift();
        const command =
            first === 'memory' ? `memory ${args.shift() ?? ''}` : first;
        if (!isCommand(command))
            throw new UsageError(
                `Unknown or missing command${command ? `: ${command}` : ''}.\n${USAGE}`,
            );
        const name = command;
        const spec = COMMANDS[name];
        const flags = new Map<string, string>();
        let help = false;
        while (args.length) {
            const flag = args.shift()!;
            if (flag === '--help' || flag === '-h') {
                help = true;
                continue;
            }
            if (!spec.flags.some((allowed) => allowed === flag))
                throw new UsageError(
                    `Unknown option ${flag}.\n${commandHelp(name)}`,
                );
            if (flags.has(flag))
                throw new UsageError(
                    `Duplicate option ${flag}.\n${commandHelp(name)}`,
                );
            if (
                ['--dry-run', '--details', '--include-global-skills'].includes(
                    flag,
                )
            )
                flags.set(flag, 'true');
            else {
                const value = args.shift();
                if (!value || value.startsWith('-'))
                    throw new UsageError(
                        `Missing value for ${flag}.\n${commandHelp(name)}`,
                    );
                flags.set(flag, value);
            }
        }
        if (help) {
            console.log(commandHelp(name));
            return 0;
        }
        for (const flag of spec.required)
            if (!flags.has(flag))
                throw new UsageError(`Missing ${flag}.\n${commandHelp(name)}`);
        if (flags.has('--details') && !flags.has('--dry-run'))
            throw new UsageError(
                `--details requires --dry-run.\n${commandHelp(name)}`,
            );
        const root = inputPath(flags.get('--root') ?? join(homedir(), '.pi'));
        reporter = new SetupProgressReporter();
        const progress = reporter.report;
        if (name === 'pack') {
            const output = inputPath(flags.get('--output')!);
            console.error(`[pi-setup] Packaging approved code into ${output}`);
            await setupStep(progress, 'main', () => refreshMain(sourceRoot));
            await packDistribution(
                sourceRoot,
                output,
                resolveMainCommit(sourceRoot, flags.get('--source-sha')),
                {
                    includeGlobalSkills: flags.has('--include-global-skills'),
                    progress,
                },
            );
            console.log(
                `Distribution prepared at ${output}.\nExternal global skills: ${flags.has('--include-global-skills') ? 'included by explicit request' : 'excluded; use pack --include-global-skills to include ~/.agents/skills'}.\nReview ${join(output, 'inventory.json')} before publishing.`,
            );
        } else if (name === 'publish') {
            const tag = releaseTag(flags.get('--tag')!);
            await setupStep(progress, 'main', () => refreshMain(sourceRoot));
            const workflow = await setupStep(progress, 'publish', () =>
                publishDistribution(
                    inputPath(flags.get('--from')!),
                    tag,
                    sourceRoot,
                ),
            );
            console.log(
                `Qualification requested for ${tag}: ${workflow}\nThe release stays in draft until all checks pass.`,
            );
        } else if (name === 'rollback') {
            console.log(
                await rollbackInstallation(
                    root,
                    flags.has('--dry-run'),
                    progress,
                ),
            );
        } else if (name === 'recover') {
            const recovered = await setupStep(progress, 'recover', () =>
                recoverInstallation(root),
            );
            console.log(
                recovered
                    ? `Previous installation restored at ${root}.`
                    : `No interrupted setup operation at ${root}.`,
            );
        } else if (name.startsWith('memory ')) {
            assertSetupIdle(root);
            assertStopped(root);
            const { exportGlobalMemory, importGlobalMemory } =
                await import('./memory.ts');
            const file = inputPath(
                flags.get(name === 'memory export' ? '--output' : '--input')!,
            );
            await setupStep(progress, 'memory', () =>
                name === 'memory export'
                    ? exportGlobalMemory(join(root, 'agent'), file)
                    : importGlobalMemory(join(root, 'agent'), file),
            );
            console.log(
                `Global memory ${name === 'memory export' ? 'exported to' : 'imported from'} ${file}; sessions and project memories excluded.`,
            );
        } else if (name === 'cleanup') {
            const { cleanupRuntimes } = await import('./cleanup.ts');
            console.log(
                JSON.stringify(
                    await setupStep(progress, 'cleanup', () =>
                        cleanupRuntimes(root, flags.has('--dry-run')),
                    ),
                    null,
                    2,
                ),
            );
        } else if (name === 'check') {
            readInstallation(root);
            const result = await setupStep(progress, 'verify', () =>
                runAsync(
                    process.execPath,
                    [join(root, 'agent/bin/setup/check.ts'), root],
                    root,
                    { ...process.env, PI_SETUP_PROGRESS: '1' },
                    progress,
                ),
            );
            console.log(result);
        } else {
            const release = releaseTag(flags.get('--release')!);
            console.error(
                `[pi-setup] ${name}${flags.has('--dry-run') ? ' preview' : ''}: ${release} at ${root}`,
            );
            const missing = await setupStep(progress, 'prerequisites', () =>
                checkPrerequisites(),
            );
            if (missing.length) throw new Error(missing.join('\n'));
            assertSetupIdle(root);
            const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-download-'));
            try {
                const bundle = await downloadDistribution(
                    release,
                    temporary,
                    progress,
                );
                console.log(
                    await installBundle({
                        root,
                        bundle,
                        release,
                        update: name === 'update',
                        dryRun: flags.has('--dry-run'),
                        details: flags.has('--details'),
                        progress,
                        bindings: flags.has('--bindings')
                            ? inputPath(flags.get('--bindings')!)
                            : undefined,
                    }),
                );
                if (!flags.has('--dry-run'))
                    console.log(
                        `Installation: ${root}\nCheck local tools and provider configuration: ${quote(join(root, 'bin/pi-setup'))} check --root ${quote(root)}\nAdd ${quote(join(root, 'bin'))} to your shell PATH to run pi directly.\nLaunch: ${quote(join(root, 'bin/pi'))}\nProvider connectivity has not been tested.`,
                    );
            } finally {
                rmSync(temporary, { recursive: true, force: true });
            }
        }
        return 0;
    } catch (error) {
        console.error(
            redactTextPreservingContext(
                error instanceof Error ? error.message : String(error),
                { maxLength: Infinity },
            ),
        );
        return error instanceof UsageError ? 2 : 1;
    } finally {
        reporter?.close();
    }
}
