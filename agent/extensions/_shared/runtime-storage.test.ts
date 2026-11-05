import { afterEach, afterAll, expect, test, mock } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fs = { ...await import('node:fs') };
afterAll(() => { mock.module('node:fs', () => fs); });
const readDirectory = fs.readdirSync;
let processInventory: number[] | undefined;
mock.module('node:fs', () => ({ ...fs, readdirSync: (...args: Parameters<typeof fs.readdirSync>) =>
    args[0] === '/proc' && processInventory ? processInventory.map(String) : Reflect.apply(readDirectory, fs, args) }));
const { acquireRuntimeStorageLock, runtimeChildStdio } = await import('./runtime-storage.ts');

const roots: string[] = [];
afterEach(() => { processInventory = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function installation() {
    const home = mkdtempSync(join(tmpdir(), 'runtime-lock-test-')); roots.push(home);
    const root = join(home, '.pi'); mkdirSync(root, { mode: 0o700 }); return root;
}

test('a killed owner releases its kernel lock without deleting a stale lock file', async () => {
    const root = installation();
    const ready = join(root, 'ready');
    const program = `import {writeFileSync} from 'node:fs';import {acquireRuntimeStorageLock} from ${JSON.stringify(new URL('./runtime-storage.ts', import.meta.url).href)};acquireRuntimeStorageLock(${JSON.stringify(root)});writeFileSync(${JSON.stringify(ready)},'locked');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    try {
        const deadline = Date.now() + 2000;
        while (!existsSync(ready) && Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(stderr || 'Lock holder exited before readiness');
            await Bun.sleep(10);
        }
        expect(existsSync(ready)).toBe(true);
        expect(() => acquireRuntimeStorageLock(root)).toThrow('Runtime storage is busy');
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
    }
    const lock = acquireRuntimeStorageLock(root); lock.release();
    expect(readFileSync(`${root}.runtime.lock`).length).toBe(0);
});

test('a lock symlink cannot modify a file outside its installation', () => {
    const root = installation(), personal = join(root, 'personal.txt');
    writeFileSync(personal, 'preserve'); symlinkSync(personal, `${root}.runtime.lock`);
    expect(() => acquireRuntimeStorageLock(root)).toThrow();
    expect(readFileSync(personal, 'utf8')).toBe('preserve');
});

test('an in-flight child keeps the kernel lock after its parent closes its descriptor', async () => {
    const root = installation(), ready = join(root, 'child-ready');
    const lock = acquireRuntimeStorageLock(root);
    const program = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', program], { stdio: runtimeChildStdio('pipe') });
    try {
        const deadline = Date.now() + 2000;
        while (!existsSync(ready) && Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error('Child exited before readiness');
            await Bun.sleep(10);
        }
        expect(existsSync(ready)).toBe(true);
        lock.release();
        expect(() => acquireRuntimeStorageLock(root)).toThrow('Runtime storage is busy');
    } finally {
        lock.release();
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
    }
    const recovered = acquireRuntimeStorageLock(root); recovered.release();
});

test.each(['valid', 'missing', 'wrong-boot'] as const)('foreign runtime pin %s retains the appropriate legacy fallback', async (pinState) => {
    const root = installation();
    const foreign = installation();
    const release = join(foreign, 'runtime/pi-core/releases/fixture');
    const cli = join(release, 'node_modules/pi-coding-agent/dist/cli.js');
    mkdirSync(join(cli, '..'), { recursive: true, mode: 0o700 });
    const storage = new URL('./runtime-storage.ts', import.meta.url).href;
    writeFileSync(cli, `import {pinRuntimeEntry} from ${JSON.stringify(storage)};pinRuntimeEntry(${JSON.stringify(foreign)},()=>${JSON.stringify(cli)});process.stdout.write('ready');setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await once(child.stdout!, 'data');
        processInventory = [child.pid!];
        const { runtimeProcessIdentity, readRuntimeUsage } = await import('./runtime-storage.ts');
        const identity = runtimeProcessIdentity(child.pid!)!;
        const file = join(`${foreign}.runtime-users`, `${child.pid}-${identity.started}.json`);
        if (pinState === 'missing') rmSync(file);
        if (pinState === 'wrong-boot') {
            const record = JSON.parse(readFileSync(file, 'utf8'));
            record.boot = '00000000-0000-0000-0000-000000000000';
            writeFileSync(file, JSON.stringify(record));
        }
        const lock = acquireRuntimeStorageLock(root);
        try { expect(readRuntimeUsage(lock, true).legacyPi).toBe(pinState !== 'valid'); }
        finally { lock.release(); }
    } finally {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
});
