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
import { join, resolve, dirname } from 'node:path';
import { validateBundle } from './distribution.ts';
import {
    assertInventory,
    child,
    inventory,
    json,
    object,
    run,
    writeJson,
    writableDirectories,
} from './files.ts';

const STATE = '.pi-setup-state.json';
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
    bindings?: string;
    provision?: (
        root: string,
        bundle: string,
        transactionId: string,
    ) => Promise<void>;
}
export function readInstallation(root: string): InstallationState {
    if (!existsSync(join(root, STATE)))
        throw new Error(
            'Unmanaged Pi installation; automatic adoption is not supported',
        );
    const value = json(join(root, STATE));
    if (value.schemaVersion !== 1 || typeof value.release !== 'string')
        throw new Error('Unmanaged or invalid Pi installation');
    const managed = object(value.managed);
    for (const [path, hash] of Object.entries(managed)) {
        child(root, path);
        if (typeof hash !== 'string')
            throw new Error('Invalid managed file fingerprint');
    }
    if (
        value.previousId !== undefined &&
        (typeof value.previousId !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(value.previousId))
    )
        throw new Error('Invalid previous release reference');
    return value as unknown as InstallationState;
}
export async function installBundle(
    options: InstallationOptions,
): Promise<string> {
    const root = resolve(options.root);
    assertSetupIdle(root);
    const manifest = validateBundle(options.bundle);
    const previous = existsSync(root) ? readInstallation(root) : undefined;
    if (Boolean(previous) !== Boolean(options.update))
        throw new Error(
            previous
                ? 'Use update for an existing installation'
                : 'Use install for a new installation',
        );
    if (previous) assertInventory(root, previous.managed);
    if (previous?.release === options.release) return 'Already installed';
    for (const path of Object.keys(manifest.files).filter((entry) =>
        entry.startsWith('setup/'),
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
    if (options.dryRun)
        return `${previous ? 'Would update' : 'Would install'} ${options.release}: ${Object.keys(manifest.files).length} verified files`;
    return await transact(
        root,
        options.release,
        async (candidate) => {
            cpSync(join(options.bundle, 'setup'), candidate, {
                recursive: true,
                verbatimSymlinks: true,
            });
        },
        async (id) => {
            if (options.provision)
                await options.provision(root, options.bundle, id);
            else
                await provisionInstallation(
                    root,
                    options.bundle,
                    id,
                    options.bindings,
                );
        },
    );
}

function localState(path: string): boolean {
    return (
        path === STATE ||
        /(^|\/)(auth\.json|trust\.json|.*\.secrets\.json|\.env[^/]*)$/.test(
            path,
        ) ||
        /^agent\/(sessions|pi-hermes-memory|projects-memory|cache|artifacts)\//.test(
            path,
        ) ||
        path === 'agent/config/sandbox.json' ||
        path === 'agent/config/setup-bindings.json'
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
): Promise<string> {
    assertStopped(root);
    if (existsSync(root) && lstatSync(root).isSymbolicLink())
        throw new Error('Installation root must not be a symbolic link');
    const id = randomUUID();
    const workspace = `${root}.setup-${id}`;
    const backup = join(workspace, 'previous'),
        candidate = join(workspace, 'candidate');
    const journal = `${root}.setup-journal.json`;
    const hadTarget = existsSync(root);
    const old = hadTarget ? readInstallation(root) : undefined;
    const baseline = hadTarget ? inventory(root) : {};
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
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
    try {
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
            for (const path of [
                'runtime',
                'runtimes',
                'agent/node_modules',
                'agent/npm',
                'agent/git',
            ]) {
                const entries = Object.keys(baseline).filter((name) =>
                    name.startsWith(`${path}/`),
                );
                if (entries.some((name) => !old.managed[name]))
                    throw new Error(
                        `Unmanaged files in generated installation: ${path}`,
                    );
                rmSync(join(candidate, path), { recursive: true, force: true });
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
        await provision(id);
        const current = inventory(root);
        const managed = Object.fromEntries(
            Object.entries(current).filter(
                ([path, hash]) => !localState(path) && personal[path] !== hash,
            ),
        );
        writeJson(join(root, STATE), {
            schemaVersion: 1,
            release,
            managed,
            ...(hadTarget ? { previousId: id } : {}),
        });
        rmSync(journal);
        if (!hadTarget) rmSync(workspace, { recursive: true, force: true });
        return `Installed ${release}`;
    } catch (error) {
        recoverInstallation(root, true);
        throw error;
    }
}

export function recoverInstallation(root: string, owned = false): void {
    root = resolve(root);
    const journalPath = `${root}.setup-journal.json`;
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
}

export async function rollbackInstallation(
    root: string,
    dryRun = false,
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
    );
}

async function provisionInstallation(
    root: string,
    bundle: string,
    transactionId: string,
    bindings?: string,
): Promise<void> {
    run(
        process.execPath,
        [join(root, 'agent/bin/setup/provision.ts'), root, bundle],
        root,
        {
            ...process.env,
            PI_CODING_AGENT_DIR: join(root, 'agent'),
            PI_SETUP_TRANSACTION_ID: transactionId,
            PI_SETUP_BINDINGS: bindings,
        },
    );
}

export function assertSetupIdle(root: string): void {
    const path = `${resolve(root)}.setup-journal.json`;
    if (existsSync(path))
        throw new Error(
            `Interrupted or active setup transaction: run pi-setup recover --root ${resolve(root)}`,
        );
}
