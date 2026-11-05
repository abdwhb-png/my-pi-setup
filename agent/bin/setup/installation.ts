import { randomUUID } from 'node:crypto';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
    lstatSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { acquireRuntimeStorageLock } from '../../extensions/_shared/runtime-storage.ts';
import {
    LOCAL_CONNECTION_FILES,
    LOCAL_PROFILE_FILES,
    validateBundle,
} from './distribution.ts';
import {
    assertInventory,
    child,
    inventory,
    json,
    object,
    runAsync,
    writeJson,
    writableDirectories,
} from './files.ts';
import { setupStep, type SetupProgress } from './progress.ts';

const STATE = '.pi-setup-state.json';
const GENERATED_DIRECTORIES = [
    'runtime',
    'runtimes',
    'agent/node_modules',
    'agent/npm',
    'agent/git',
];
interface InstallationState {
    schemaVersion: 1;
    release: string;
    managed: Record<string, string>;
    previousId?: string;
}
export interface InstallationOptions {
    root: string;
    bundle: string;
    release: string;
    update?: boolean;
    dryRun?: boolean;
    details?: boolean;
    progress?: SetupProgress;
    bindings?: string;
    provision?: (
        root: string,
        bundle: string,
        transactionId: string,
    ) => Promise<void>;
}
export function readInstallation(root: string): InstallationState {
    if (!existsSync(root))
        throw new Error(
            `No managed Pi installation at ${root}. Install an explicitly selected release first.`,
        );
    if (!existsSync(join(root, STATE)))
        throw new Error(
            'Unmanaged Pi installation; automatic adoption is not supported',
        );
    const value = json(join(root, STATE));
    if (value.schemaVersion !== 1 || typeof value.release !== 'string')
        throw new Error('Unmanaged or invalid Pi installation');
    const managed = object(value.managed);
    const retained: Record<string, string> = {};
    for (const [path, hash] of Object.entries(managed)) {
        child(root, path);
        if (typeof hash !== 'string')
            throw new Error('Invalid managed file fingerprint');
        if (!LOCAL_PROFILE_FILES.has(path)) retained[path] = hash;
    }
    if (
        value.previousId !== undefined &&
        (typeof value.previousId !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(value.previousId))
    )
        throw new Error('Invalid previous release reference');
    return {
        schemaVersion: 1,
        release: value.release,
        managed: retained,
        ...(typeof value.previousId === 'string'
            ? { previousId: value.previousId }
            : {}),
    };
}
export async function installBundle(
    options: InstallationOptions,
): Promise<string> {
    const root = resolve(options.root);
    assertSetupIdle(root);
    const manifest = await setupStep(options.progress, 'files', () =>
        validateBundle(options.bundle),
    );
    const previous = existsSync(root) ? readInstallation(root) : undefined;
    if (Boolean(previous) !== Boolean(options.update))
        throw new Error(
            previous
                ? 'Use update for an existing installation'
                : 'Use install for a new installation',
        );
    if (previous) assertInventory(root, previous.managed);
    if (previous?.release === options.release) return 'Already installed';
    for (const path of Object.keys(manifest.files).filter(
        (entry) =>
            entry.startsWith('setup/') &&
            !LOCAL_CONNECTION_FILES.has(entry.slice(6)),
    )) {
        const local = path.slice(6);
        if (previous) safeParents(root, local);
        if (
            previous &&
            existsSync(child(root, local)) &&
            !previous.managed[local]
        )
            throw new Error(`Unmanaged file collision: ${local}`);
    }
    const profilePath = join(
        options.bundle,
        'setup/agent/config/sandbox.development.example.json',
    );
    let discovery:
        | import('../../extensions/sandbox/development-tools.ts').ToolDiscovery
        | undefined;
    let resolvedBindings: Record<string, unknown> | undefined;
    if (existsSync(profilePath)) {
        const profile = json(profilePath);
        if (profile.tools !== undefined) {
            const { resolveDevelopmentTools } =
                await import('../../extensions/sandbox/development-tools.ts');
            const storedPath = join(root, 'agent/config/setup-bindings.json');
            const cached = existsSync(storedPath)
                ? object(object(json(storedPath).environment).installations)
                : {};
            const authorityPath = join(root, 'agent/config/sandbox.json');
            const configured = existsSync(authorityPath)
                ? object(
                      object(json(authorityPath).environment ?? {})
                          .installations ?? {},
                  )
                : {};
            const stored = { ...cached, ...configured };
            const supplied = options.bindings
                ? object(
                      object(json(options.bindings).environment).installations,
                  )
                : {};
            const declarations = object(
                object(profile.environment ?? {}).installations ?? {},
            );
            discovery = await setupStep(options.progress, 'tools', () =>
                resolveDevelopmentTools(profile.tools, {
                    variables: object(profile.environment ?? {}).variables,
                    existing: stored,
                    overrides: { ...declarations, ...supplied },
                }),
            );
            if (discovery.unavailable.length)
                throw new Error(
                    discovery.unavailable
                        .map((item) => `${item.name}: ${item.reason}`)
                        .join('\n'),
                );
            resolvedBindings = {
                environment: {
                    installations: {
                        ...declarations,
                        ...supplied,
                        ...discovery.installations,
                    },
                },
            };
        }
    }
    if (options.dryRun)
        return `${previous ? 'Would update' : 'Would install'} ${options.release}: ${Object.keys(manifest.files).length} verified files\nDestination: ${root}\n${[...LOCAL_CONNECTION_FILES.keys()].map((path) => `Keep local: ${path} (preserved, never created or managed)`).join('\n')}${discovery ? '\n' + discovery.tools.map((tool) => `Tool ${tool.command}: ${tool.version} at ${tool.executable} (${tool.source})`).join('\n') + (options.details ? '\nRead-only installations: ' + JSON.stringify(discovery.installations, null, 2) : `\nRead-only access: ${Object.keys(discovery.installations).length} tool groups. Use --dry-run --details to inspect all installation roots and files.`) : ''}\nPreview complete; no installation was created or changed.`;
    return await transact(
        root,
        options.release,
        async (candidate) => {
            cpSync(join(options.bundle, 'setup'), candidate, {
                recursive: true,
                verbatimSymlinks: true,
                filter: (source) =>
                    !LOCAL_CONNECTION_FILES.has(
                        relative(join(options.bundle, 'setup'), source),
                    ),
            });
        },
        async (id) => {
            discovery?.assertUnchanged();
            const generated = join(root, 'agent/config/setup-bindings.json');
            if (resolvedBindings) writeJson(generated, resolvedBindings);
            if (options.provision)
                await options.provision(root, options.bundle, id);
            else
                await provisionInstallation(
                    root,
                    options.bundle,
                    id,
                    resolvedBindings ? generated : options.bindings,
                    options.progress,
                );
            discovery?.assertUnchanged();
        },
        options.progress,
        options.update ? 'Updated' : 'Installed',
    );
}

function localState(path: string): boolean {
    if (
        path.endsWith('/.env.example') &&
        GENERATED_DIRECTORIES.some((root) => path.startsWith(`${root}/`))
    )
        return false;
    return (
        path === STATE ||
        LOCAL_PROFILE_FILES.has(path) ||
        /(^|\/)(auth\.json|trust\.json|.*\.secrets\.json|\.env[^/]*)$/.test(
            path,
        ) ||
        /^agent\/(sessions|pi-hermes-memory|projects-memory|cache|artifacts)\//.test(
            path,
        )
    );
}
function safeParents(root: string, path: string): void {
    const parts = path.split('/');
    parts.pop();
    let parent = root;
    for (const part of parts) {
        parent = join(parent, part);
        if (existsSync(parent) && !lstatSync(parent).isDirectory())
            throw new Error(`Non-directory installation parent: ${path}`);
    }
}
export function assertStopped(root: string): void {
    if (process.platform !== 'linux')
        throw new Error('Only Linux and WSL2 are supported');
    for (const pid of readdirSync('/proc').filter(
        (name) => /^\d+$/.test(name) && Number(name) !== process.pid,
    )) {
        let command: string;
        try {
            command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        } catch (error) {
            if (
                ['ENOENT', 'ESRCH', 'EACCES'].includes(
                    (error as NodeJS.ErrnoException).code ?? '',
                )
            )
                continue;
            throw error;
        }
        if (
            command.includes(`${root}/bin/pi\0`) ||
            command.includes(`${root}/runtime/pi-core/`)
        )
            throw new Error(`Stop Pi processes before setup (PID ${pid})`);
    }
}

async function transact(
    root: string,
    release: string,
    prepare: (candidate: string) => Promise<void>,
    provision: (id: string) => Promise<void>,
    progress?: SetupProgress,
    action = 'Installed',
): Promise<string> {
    if (existsSync(root) && lstatSync(root).isSymbolicLink())
        throw new Error('Installation root must not be a symbolic link');
    const id = randomUUID();
    const workspace = `${root}.setup-${id}`;
    const backup = join(workspace, 'previous'),
        candidate = join(workspace, 'candidate');
    const journal = `${root}.setup-journal.json`;
    let hadTarget: boolean;
    let old: InstallationState | undefined;
    let baseline: Record<string, string>;
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    const storageLock = acquireRuntimeStorageLock(root);
    try {
        assertSetupIdle(root);
        assertStopped(root);
        hadTarget = existsSync(root);
        old = hadTarget ? readInstallation(root) : undefined;
        baseline = hadTarget ? inventory(root) : {};
        writeFileSync(
            journal,
            JSON.stringify({
                schemaVersion: 1,
                id,
                pid: process.pid,
                hadTarget,
                phase: 'preparing',
            }),
            { flag: 'wx', mode: 0o600 },
        );
    } finally {
        storageLock.release();
    }
    try {
        const personal = await setupStep(progress, 'prepare', async () => {
            mkdirSync(workspace, { mode: 0o700 });
            if (hadTarget)
                cpSync(root, candidate, {
                    recursive: true,
                    verbatimSymlinks: true,
                });
            else mkdirSync(candidate, { mode: 0o700 });
            writableDirectories(candidate);
            if (old) {
                for (const path of Object.keys(old.managed)) {
                    safeParents(candidate, path);
                    rmSync(child(candidate, path), { force: true });
                }
                // These roots are generated installations, never personal resource owners.
                for (const path of GENERATED_DIRECTORIES) {
                    const entries = Object.keys(baseline).filter((name) =>
                        name.startsWith(`${path}/`),
                    );
                    const unmanaged = entries.filter(
                        (name) => !old.managed[name],
                    );
                    if (unmanaged.length)
                        throw new Error(
                            `Unmanaged files in generated installation: ${path}: ${unmanaged.slice(0, 20).join(', ')}${unmanaged.length > 20 ? ` (${unmanaged.length} total)` : ''}`,
                        );
                    rmSync(join(candidate, path), {
                        recursive: true,
                        force: true,
                    });
                }
                rmSync(join(candidate, STATE), { force: true });
            }
            const personal = inventory(candidate);
            await prepare(candidate);
            if (
                hadTarget &&
                JSON.stringify(inventory(root)) !== JSON.stringify(baseline)
            )
                throw new Error(
                    'Installation changed during preparation; retry while Pi is stopped',
                );
            return personal;
        });
        await setupStep(progress, 'activate', () => {
            assertStopped(root);
            if (hadTarget) renameSync(root, backup);
            writeJson(journal, {
                schemaVersion: 1,
                id,
                pid: process.pid,
                hadTarget,
                phase: 'activating',
            });
            renameSync(candidate, root);
        });
        await setupStep(progress, 'provision', () => provision(id));
        await setupStep(progress, 'verify', () => {
            const current = inventory(root);
            const managed = Object.fromEntries(
                Object.entries(current).filter(
                    ([path, hash]) =>
                        !localState(path) && personal[path] !== hash,
                ),
            );
            writeJson(join(root, STATE), {
                schemaVersion: 1,
                release,
                managed,
                ...(hadTarget ? { previousId: id } : {}),
            });
        });
        rmSync(journal);
        if (!hadTarget) rmSync(workspace, { recursive: true, force: true });
        const { cleanupRuntimes } = await import('./cleanup.ts');
        try {
            await setupStep(progress, 'cleanup', () => cleanupRuntimes(root));
        } catch (error) {
            console.warn(
                `Setup completed, but runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return `${action} ${release}`;
    } catch (error) {
        try {
            await setupStep(progress, 'recover', () =>
                recoverInstallation(root, true),
            );
        } catch (recovery) {
            throw new Error(
                `Setup failed and automatic recovery failed. Use the bootstrap pi-setup recover --root ${JSON.stringify(root)}. Original failure: ${error instanceof Error ? error.message : String(error)}. Recovery failure: ${recovery instanceof Error ? recovery.message : String(recovery)}`,
            );
        }
        throw new Error(
            `Setup failed; ${hadTarget ? 'previous installation restored' : 'incomplete installation removed'}. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
}

export function recoverInstallation(root: string, owned = false): boolean {
    root = resolve(root);
    const journalPath = `${root}.setup-journal.json`;
    if (!existsSync(journalPath)) return false;
    const journal = json(journalPath);
    if (
        journal.schemaVersion !== 1 ||
        typeof journal.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(journal.id) ||
        typeof journal.hadTarget !== 'boolean' ||
        !['preparing', 'activating'].includes(String(journal.phase))
    )
        throw new Error('Invalid setup recovery journal');
    if (!owned && typeof journal.pid === 'number') {
        try {
            process.kill(journal.pid, 0);
            throw new Error('Setup transaction is still running');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    }
    const workspace = `${root}.setup-${journal.id}`,
        backup = join(workspace, 'previous');
    if (existsSync(backup)) {
        if (existsSync(root)) {
            writableDirectories(root);
            rmSync(root, { recursive: true });
        }
        renameSync(backup, root);
    } else if (
        !journal.hadTarget &&
        journal.phase === 'activating' &&
        existsSync(root)
    ) {
        writableDirectories(root);
        rmSync(root, { recursive: true });
    }
    writableDirectories(workspace);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(journalPath);
    return true;
}

export async function rollbackInstallation(
    root: string,
    dryRun = false,
    progress?: SetupProgress,
): Promise<string> {
    root = resolve(root);
    assertSetupIdle(root);
    const state = readInstallation(root);
    assertInventory(root, state.managed);
    if (!state.previousId) throw new Error('No previous setup release');
    const previous = `${root}.setup-${state.previousId}/previous`;
    const old = readInstallation(previous);
    assertInventory(previous, old.managed);
    if (dryRun) return `Would restore ${old.release}`;
    return await transact(
        root,
        old.release,
        async (candidate) => {
            for (const path of Object.keys(old.managed)) {
                safeParents(candidate, path);
                if (existsSync(child(candidate, path)))
                    throw new Error(`Unmanaged rollback collision: ${path}`);
                mkdirSync(dirname(child(candidate, path)), {
                    recursive: true,
                    mode: 0o700,
                });
                cpSync(child(previous, path), child(candidate, path), {
                    verbatimSymlinks: true,
                });
            }
        },
        async () => {},
        progress,
        'Restored',
    );
}

async function provisionInstallation(
    root: string,
    bundle: string,
    transactionId: string,
    bindings?: string,
    progress?: SetupProgress,
): Promise<void> {
    await runAsync(
        process.execPath,
        [join(root, 'agent/bin/setup/provision.ts'), root, bundle],
        root,
        {
            ...process.env,
            PI_CODING_AGENT_DIR: join(root, 'agent'),
            PI_SETUP_TRANSACTION_ID: transactionId,
            PI_SETUP_BINDINGS: bindings,
            PI_SETUP_PROGRESS: progress ? '1' : undefined,
        },
        progress,
    );
}

export function assertSetupIdle(root: string): void {
    const path = `${resolve(root)}.setup-journal.json`;
    if (existsSync(path))
        throw new Error(
            `Interrupted or active setup transaction: run pi-setup recover --root ${resolve(root)}`,
        );
}
