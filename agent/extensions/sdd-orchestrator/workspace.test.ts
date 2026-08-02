import { expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceManager, resolveSddStateHome } from './workspace.ts';

setDefaultTimeout(15_000);

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initializeRepository(path: string): void {
    git(path, ['init', '--initial-branch=main']);
    git(path, ['config', 'user.email', 'sdd@example.test']);
    git(path, ['config', 'user.name', 'SDD test']);
    writeFileSync(join(path, 'keep.txt'), 'before\n');
    writeFileSync(join(path, 'delete.txt'), 'delete me\n');
    git(path, ['add', 'keep.txt', 'delete.txt']);
    git(path, ['commit', '-m', 'fixture']);
}

function fixture(): {
    root: string;
    source: string;
    stateHome: string;
    agentDir: string;
    workspaceManager: GitWorkspaceManager;
} {
    const root = mkdtempSync(join(tmpdir(), 'sdd-workspace-'));
    const source = join(root, 'source');
    const stateHome = join(root, 'state');
    const agentDir = join(root, 'agent');
    mkdirSync(source);
    initializeRepository(source);
    return {
        root,
        source,
        stateHome,
        agentDir,
        workspaceManager: new GitWorkspaceManager(agentDir, { stateHome }),
    };
}

function dispose(root: string): void {
    rmSync(root, { recursive: true, force: true });
}

function waitForChildCheckpoint(
    child: ReturnType<typeof spawn>,
    checkpoint: string,
): Promise<void> {
    let output = '';
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`child did not reach ${checkpoint}: ${output}`));
        }, 10_000);
        child.stdout?.on('data', chunk => {
            output += chunk.toString();
            if (output.includes(checkpoint)) {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.stderr?.on('data', chunk => {
            output += chunk.toString();
        });
        child.on('error', (...args: unknown[]) => {
            clearTimeout(timeout);
            reject(
                args[0] instanceof Error
                    ? args[0]
                    : new Error(`child process error: ${String(args[0])}`),
            );
        });
        child.on('exit', (...args: unknown[]) => {
            if (!output.includes(checkpoint)) {
                clearTimeout(timeout);
                reject(
                    new Error(
                        `child exited before ${checkpoint}: ${String(args[0])}`,
                    ),
                );
            }
        });
    });
}

function waitForChildExit(
    child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: string | null }> {
    return new Promise(resolve => {
        child.on('exit', (...args: unknown[]) => {
            resolve({
                code: typeof args[0] === 'number' ? args[0] : null,
                signal: typeof args[1] === 'string' ? args[1] : null,
            });
        });
    });
}

function spawnCheckpointChild(
    operation: 'prepare' | 'apply',
    checkpoint: 'ledger-written' | 'worktree-created' | 'delivery-intent-recorded',
    agentDir: string,
    stateHome: string,
    source: string,
    runId: string,
    workspace?: unknown,
): ReturnType<typeof spawn> {
    const childSource = `import { GitWorkspaceManager } from ${JSON.stringify(join(import.meta.dir, 'workspace.ts'))};
const checkpoint = ${JSON.stringify(checkpoint)};
const waitAt = (current) => {
    if (current === checkpoint) {
        process.stdout.write(checkpoint + '\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
};
const manager = new GitWorkspaceManager(process.env.SDD_TEST_AGENT_DIR, {
    stateHome: process.env.SDD_TEST_STATE_HOME,
    onPreparationCheckpoint: waitAt,
    onDeliveryCheckpoint: waitAt,
});
if (${JSON.stringify(operation)} === 'prepare') {
    await manager.prepare(process.env.SDD_TEST_RUN_ID, process.env.SDD_TEST_SOURCE);
} else {
    await manager.apply(JSON.parse(process.env.SDD_TEST_WORKSPACE), process.env.SDD_TEST_SOURCE);
}`;
    return spawn(process.execPath, ['-e', childSource], {
        cwd: source,
        env: {
            ...process.env,
            SDD_TEST_AGENT_DIR: agentDir,
            SDD_TEST_RUN_ID: runId,
            SDD_TEST_SOURCE: source,
            SDD_TEST_STATE_HOME: stateHome,
            ...(workspace === undefined
                ? {}
                : { SDD_TEST_WORKSPACE: JSON.stringify(workspace) }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

test('falls back from an empty or relative XDG state home to the user state directory', () => {
    const previous = process.env.XDG_STATE_HOME;
    try {
        process.env.XDG_STATE_HOME = '';
        expect(resolveSddStateHome()).toBe(join(homedir(), '.local', 'state'));

        process.env.XDG_STATE_HOME = 'relative-state';
        expect(resolveSddStateHome()).toBe(join(homedir(), '.local', 'state'));
    } finally {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
    }
});

test('prepares a detached worktree at the source HEAD and resolves it for execution', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const baseCommit = git(source, ['rev-parse', 'HEAD']).trim();

        const workspace = await workspaceManager.prepare('run-1', source);

        expect(workspace).toMatchObject({
            sourceRoot: source,
            baseCommit,
            delivery: { status: 'pending' },
        });
        expect(existsSync(workspace.worktreePath)).toBe(true);
        expect(git(workspace.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(
            baseCommit,
        );
        expect(
            workspaceManager.resolveExecutionCwd(workspace, source),
        ).toBe(workspace.worktreePath);
    } finally {
        dispose(root);
    }
});

test('refuses a writer worktree before creating it when the source tree is dirty', async () => {
    const { root, source, stateHome, workspaceManager } = fixture();
    try {
        writeFileSync(join(source, 'uncommitted.txt'), 'dirty\n');

        await expect(workspaceManager.prepare('run-dirty', source)).rejects.toThrow(
            'SDD writer runs require a clean Git worktree.',
        );
        expect(existsSync(join(stateHome, 'pi', 'sdd-orchestrator'))).toBe(
            false,
        );
    } finally {
        dispose(root);
    }
});

test('recreates a worktree when preparation was interrupted after its ledger was written', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const interrupted = new GitWorkspaceManager(agentDir, {
            stateHome,
            onPreparationCheckpoint(checkpoint) {
                if (checkpoint === 'ledger-written') {
                    throw new Error('simulated preparation interruption');
                }
            },
        });

        await expect(interrupted.prepare('run-interrupted', source)).rejects.toThrow(
            'simulated preparation interruption',
        );
        expect(
            existsSync(join(agentDir, '.sdd', 'workspaces', 'run-interrupted.json')),
        ).toBe(true);

        const recovered = await workspaceManager.prepare('run-interrupted', source);

        expect(existsSync(recovered.worktreePath)).toBe(true);
        expect(workspaceManager.resolveExecutionCwd(recovered, source)).toBe(
            recovered.worktreePath,
        );
    } finally {
        dispose(root);
    }
});

test('reclaims a preparation lock left by a killed process and resumes the run', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const runId = 'run-killed-preparation';
        const child = spawnCheckpointChild(
            'prepare',
            'ledger-written',
            agentDir,
            stateHome,
            source,
            runId,
        );
        const childExit = waitForChildExit(child);

        await waitForChildCheckpoint(child, 'ledger-written');
        child.kill('SIGKILL');
        expect(await childExit).toEqual({ code: null, signal: 'SIGKILL' });

        const recovered = await workspaceManager.prepare(runId, source);

        expect(existsSync(recovered.worktreePath)).toBe(true);
        expect(workspaceManager.resolveExecutionCwd(recovered, source)).toBe(
            recovered.worktreePath,
        );
    } finally {
        dispose(root);
    }
});

test('admits only one concurrent successor after a killed preparation owner', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const runId = 'run-killed-preparation-concurrent';
        const interrupted = spawnCheckpointChild(
            'prepare',
            'ledger-written',
            agentDir,
            stateHome,
            source,
            runId,
        );
        const interruptedExit = waitForChildExit(interrupted);
        await waitForChildCheckpoint(interrupted, 'ledger-written');
        interrupted.kill('SIGKILL');
        expect(await interruptedExit).toEqual({ code: null, signal: 'SIGKILL' });

        const firstSuccessor = spawnCheckpointChild(
            'prepare',
            'worktree-created',
            agentDir,
            stateHome,
            source,
            runId,
        );
        const firstSuccessorExit = waitForChildExit(firstSuccessor);
        await waitForChildCheckpoint(firstSuccessor, 'worktree-created');

        await expect(workspaceManager.prepare(runId, source)).rejects.toThrow(
            'SDD workspace lock is already held',
        );

        firstSuccessor.kill('SIGKILL');
        expect(await firstSuccessorExit).toEqual({
            code: null,
            signal: 'SIGKILL',
        });
        const recovered = await workspaceManager.prepare(runId, source);
        expect(existsSync(recovered.worktreePath)).toBe(true);
    } finally {
        dispose(root);
    }
});

test('rejects resuming an isolated run when its persisted worktree disappeared', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-missing', source);
        rmSync(workspace.worktreePath, { recursive: true, force: true });

        expect(() =>
            workspaceManager.resolveExecutionCwd(workspace, source),
        ).toThrow(`SDD isolated worktree is missing: ${workspace.worktreePath}.`);
        await expect(workspaceManager.prepare('run-missing', source)).rejects.toThrow(
            `SDD isolated worktree is missing: ${workspace.worktreePath}.`,
        );
    } finally {
        dispose(root);
    }
});

test('creates a binary patch from the isolated worktree and applies additions, changes, and deletions without staging', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-apply', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        writeFileSync(join(workspace.worktreePath, 'new.bin'), '\u0000binary\n');
        rmSync(join(workspace.worktreePath, 'delete.txt'));

        const delivery = await workspaceManager.apply(workspace, source);

        expect(delivery.patchDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');
        expect(readFileSync(join(source, 'new.bin'), 'utf8')).toBe('\u0000binary\n');
        expect(existsSync(join(source, 'delete.txt'))).toBe(false);
        expect(git(source, ['status', '--porcelain=v1'])).toContain(' M keep.txt');
        expect(git(source, ['status', '--porcelain=v1'])).toContain(' D delete.txt');
        expect(git(source, ['status', '--porcelain=v1'])).toContain('?? new.bin');
    } finally {
        dispose(root);
    }
});

test('applies an untracked binary patch larger than the child-process default buffer', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-large-patch', source);
        const payload = randomBytes(1_200_000);
        writeFileSync(join(workspace.worktreePath, 'large.bin'), payload);

        const delivery = await workspaceManager.apply(workspace, source);

        expect(delivery.patchDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, 'large.bin'))).toEqual(payload);
    } finally {
        dispose(root);
    }
});

test('recovers an apply interrupted after the source patch without applying it twice', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-apply-interrupted', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        const interrupted = new GitWorkspaceManager(agentDir, {
            stateHome,
            onDeliveryCheckpoint(checkpoint) {
                if (checkpoint === 'source-patched') {
                    throw new Error('simulated apply interruption');
                }
            },
        });

        await expect(interrupted.apply(workspace, source)).rejects.toThrow(
            'simulated apply interruption',
        );
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');

        const recovered = await workspaceManager.apply(workspace, source);

        expect(recovered.patchDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');
        expect(
            JSON.parse(
                readFileSync(
                    join(agentDir, '.sdd', 'workspaces', 'run-apply-interrupted.json'),
                    'utf8',
                ),
            ).delivery,
        ).toMatchObject({ status: 'applied', patchDigest: recovered.patchDigest });
    } finally {
        dispose(root);
    }
});

test('retries an apply interrupted after recording its delivery intent but before changing the source', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-apply-intent', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        const interrupted = new GitWorkspaceManager(agentDir, {
            stateHome,
            onDeliveryCheckpoint(checkpoint) {
                if (checkpoint === 'delivery-intent-recorded') {
                    throw new Error('simulated delivery-intent interruption');
                }
            },
        });

        await expect(interrupted.apply(workspace, source)).rejects.toThrow(
            'simulated delivery-intent interruption',
        );
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('before\n');

        const recovered = await workspaceManager.apply(workspace, source);

        expect(recovered.patchDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');
    } finally {
        dispose(root);
    }
});

test('reclaims a delivery lock left by a killed process and applies once', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const runId = 'run-killed-delivery';
        const workspace = await workspaceManager.prepare(runId, source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        const child = spawnCheckpointChild(
            'apply',
            'delivery-intent-recorded',
            agentDir,
            stateHome,
            source,
            runId,
            workspace,
        );
        const childExit = waitForChildExit(child);

        await waitForChildCheckpoint(child, 'delivery-intent-recorded');
        child.kill('SIGKILL');
        expect(await childExit).toEqual({ code: null, signal: 'SIGKILL' });
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('before\n');

        const delivery = await workspaceManager.apply(workspace, source);

        expect(delivery.patchDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');
    } finally {
        dispose(root);
    }
});

test('serializes concurrent applies from separate processes for one isolated run', async () => {
    const { root, source, stateHome, agentDir, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-concurrent-apply', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        const child = spawn(
            process.execPath,
            [
                '-e',
                `import { GitWorkspaceManager } from ${JSON.stringify(join(import.meta.dir, 'workspace.ts'))};
const manager = new GitWorkspaceManager(process.env.SDD_TEST_AGENT_DIR, {
    stateHome: process.env.SDD_TEST_STATE_HOME,
    onDeliveryCheckpoint(checkpoint) {
        if (checkpoint === 'delivery-intent-recorded') {
            process.stdout.write('delivery-intent-recorded\\n');
            const until = Date.now() + 1_500;
            while (Date.now() < until) {}
        }
    },
});
await manager.apply(JSON.parse(process.env.SDD_TEST_WORKSPACE), process.env.SDD_TEST_SOURCE);`,
            ],
            {
                cwd: source,
                env: {
                    ...process.env,
                    SDD_TEST_AGENT_DIR: agentDir,
                    SDD_TEST_SOURCE: source,
                    SDD_TEST_STATE_HOME: stateHome,
                    SDD_TEST_WORKSPACE: JSON.stringify(workspace),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const childExit = new Promise<number | null>(resolve => {
            child.on('exit', (...args: unknown[]) => {
                resolve(typeof args[0] === 'number' ? args[0] : null);
            });
        });
        let output = '';
        const reachedDeliveryIntent = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(
                    new Error(
                        `child did not acquire the delivery lock: ${output}`,
                    ),
                );
            }, 5_000);
            child.stdout?.on('data', chunk => {
                output += chunk.toString();
                if (output.includes('delivery-intent-recorded')) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
            child.stderr?.on('data', chunk => {
                output += chunk.toString();
            });
            child.on('error', (...args: unknown[]) => {
                clearTimeout(timeout);
                reject(
                    args[0] instanceof Error
                        ? args[0]
                        : new Error(`child process error: ${String(args[0])}`),
                );
            });
            child.on('exit', (...args: unknown[]) => {
                const code = args[0];
                if (!output.includes('delivery-intent-recorded')) {
                    clearTimeout(timeout);
                    reject(new Error(`child exited before locking: ${code} ${output}`));
                }
            });
        });

        await reachedDeliveryIntent;

        await expect(workspaceManager.apply(workspace, source)).rejects.toThrow(
            'SDD workspace lock is already held',
        );
        expect(await childExit).toBe(0);
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('after\n');
    } finally {
        dispose(root);
    }
});

test('leaves the source unchanged when the apply preconditions are not met', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-guard', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'after\n');
        writeFileSync(join(source, 'source-only.txt'), 'dirty\n');
        const statusBefore = git(source, ['status', '--porcelain=v1']);

        await expect(workspaceManager.apply(workspace, source)).rejects.toThrow(
            'SDD apply requires the recorded source worktree to be clean.',
        );
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('before\n');
        expect(git(source, ['status', '--porcelain=v1'])).toBe(statusBefore);
    } finally {
        dispose(root);
    }
});

test('leaves the source unchanged when its HEAD no longer matches the isolated baseline', async () => {
    const { root, source, workspaceManager } = fixture();
    try {
        const workspace = await workspaceManager.prepare('run-head-guard', source);
        writeFileSync(join(workspace.worktreePath, 'keep.txt'), 'isolated\n');
        writeFileSync(join(source, 'keep.txt'), 'source commit\n');
        git(source, ['add', 'keep.txt']);
        git(source, ['commit', '-m', 'source moved']);
        const sourceHead = git(source, ['rev-parse', 'HEAD']).trim();

        await expect(workspaceManager.apply(workspace, source)).rejects.toThrow(
            `SDD apply source HEAD changed: expected ${workspace.baseCommit}, received ${sourceHead}.`,
        );
        expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe(
            'source commit\n',
        );
        expect(git(source, ['status', '--porcelain=v1'])).toBe('');
    } finally {
        dispose(root);
    }
});
