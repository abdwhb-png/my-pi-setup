import { describe, expect, it, mock, afterAll } from 'bun:test';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';
import {
    compactPromptSessionName,
    promptSessionNameDetector,
    migrateSessionFile,
    migrateSessions,
    runMigrationCli,
    defaultPromptLoader,
    type PromptLoader,
} from './migrate-prompt-session-names.ts';

/** Minimal PromptTemplate fixture helper. */
function tmpl(name: string, content: string): PromptTemplate {
    return {
        name,
        content,
        description: 'test fixture',
        sourceInfo: {
            path: `/test/${name}.md`,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
        },
        filePath: `/test/${name}.md`,
    };
}

/** Build a minimal session JSONL blob for testing. */
function makeSessionJsonl(
    cwd: string,
    firstUserText: string,
    name?: string,
): string {
    const lines = [
        JSON.stringify({ type: 'session', cwd, id: 's1' }),
        JSON.stringify({
            type: 'message',
            id: 'm1',
            message: { role: 'user', content: firstUserText },
        }),
    ];
    if (name) {
        lines.push(
            JSON.stringify({
                type: 'session_info',
                id: 'i1',
                parentId: 'm1',
                name,
            }),
        );
    }
    return lines.join('\n') + '\n';
}

function parseJsonLine(line: string | undefined): unknown {
    try {
        return JSON.parse(line ?? '');
    } catch (cause) {
        throw new Error('Invalid JSONL fixture line', { cause });
    }
}

// ---------------------------------------------------------------------------
// compactPromptSessionName
// ---------------------------------------------------------------------------

describe('compactPromptSessionName', () => {
    it('returns /prompt:name for exact static template match', () => {
        const templates = [
            tmpl('codereview', 'Review the following code for style issues'),
        ];
        expect(
            compactPromptSessionName(
                'Review the following code for style issues',
                templates,
            ),
        ).toBe('/prompt:codereview');
    });

    it('matches static templates across CRLF and LF line endings', () => {
        const templates = [
            tmpl(
                'codereview',
                'Review this code carefully\r\nReport every issue',
            ),
        ];
        expect(
            compactPromptSessionName(
                'Review this code carefully\nReport every issue',
                templates,
            ),
        ).toBe('/prompt:codereview');
    });

    it('does not equate a template newline with a plain space', () => {
        const templates = [
            tmpl(
                'codereview',
                'Review this code carefully\nReport every issue',
            ),
        ];
        expect(
            compactPromptSessionName(
                'Review this code carefully Report every issue',
                templates,
            ),
        ).toBeUndefined();
    });

    it('returns undefined when static template does not match', () => {
        const templates = [
            tmpl('codereview', 'Review the following code for style issues'),
        ];
        expect(
            compactPromptSessionName(
                'Review the following code for performance',
                templates,
            ),
        ).toBeUndefined();
    });

    it('matches template with $ARGUMENTS and returns name + captured text', () => {
        const templates = [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ];
        expect(
            compactPromptSessionName(
                'Explain TypeScript generics in simple terms with examples',
                templates,
            ),
        ).toBe('/prompt:explain TypeScript generics');
    });

    it('matches template with $@ (alias for all args)', () => {
        const templates = [
            tmpl('ask', 'Please help me with $@ and be thorough'),
        ];
        expect(
            compactPromptSessionName(
                'Please help me with understanding generics and be thorough',
                templates,
            ),
        ).toBe('/prompt:ask understanding generics');
    });

    it('returns /prompt:name (no args) when captured text is empty', () => {
        const templates = [
            tmpl(
                'empty',
                'This is a long prefix that definitely ends $ARGUMENTS and continues with a very long suffix',
            ),
        ];
        expect(
            compactPromptSessionName(
                'This is a long prefix that definitely ends  and continues with a very long suffix',
                templates,
            ),
        ).toBe('/prompt:empty');
    });

    it('trims outer separator whitespace from captured text', () => {
        const templates = [
            tmpl(
                'trim',
                'Please run the following command $ARGUMENTS and wait for the result',
            ),
        ];
        expect(
            compactPromptSessionName(
                'Please run the following command  npm test  and wait for the result',
                templates,
            ),
        ).toBe('/prompt:trim npm test');
    });

    it('skips template with fewer than 20 non-whitespace static chars (minimal prefix)', () => {
        const templates = [tmpl('catchall', '$ARGUMENTS')];
        expect(
            compactPromptSessionName('anything at all', templates),
        ).toBeUndefined();
    });

    it('skips template with < 20 static chars (short prefix + empty suffix)', () => {
        const templates = [tmpl('short', 'Ask: $ARGUMENTS')];
        expect(
            compactPromptSessionName('Ask: something', templates),
        ).toBeUndefined();
    });

    it('skips template with < 20 static chars (empty prefix + short suffix)', () => {
        const templates = [tmpl('short2', '$ARGUMENTS then some')];
        expect(
            compactPromptSessionName('x then some', templates),
        ).toBeUndefined();
    });

    it('matches template with >= 20 static chars', () => {
        const templates = [
            tmpl(
                'long',
                'You are an expert at $ARGUMENTS. Please help me understand this topic.',
            ),
        ];
        expect(
            compactPromptSessionName(
                'You are an expert at TypeScript. Please help me understand this topic.',
                templates,
            ),
        ).toBe('/prompt:long TypeScript');
    });

    it('skips template with $1 positional placeholder', () => {
        const templates = [tmpl('greet', 'Hello $1, welcome to $2')];
        expect(
            compactPromptSessionName('Hello Alice, welcome to Bob', templates),
        ).toBeUndefined();
    });

    it('does not treat $ARGUMENTS_EXTRA as an all-args placeholder', () => {
        const templates = [
            tmpl(
                'unsupported',
                'Explain this carefully: $ARGUMENTS_EXTRA with enough static context',
            ),
        ];
        expect(
            compactPromptSessionName(
                'Explain this carefully: TypeScript_EXTRA with enough static context',
                templates,
            ),
        ).toBeUndefined();
    });

    it('skips template with ${} default/slice placeholder', () => {
        const templates = [tmpl('default', 'Hello ${1:-friend}')];
        expect(
            compactPromptSessionName('Hello Alice', templates),
        ).toBeUndefined();
    });

    it('skips template with ${@:N} slice placeholder', () => {
        const templates = [tmpl('slice', 'Args: ${@:2}')];
        expect(
            compactPromptSessionName('Args: rest of args', templates),
        ).toBeUndefined();
    });

    it('skips template with two $ARGUMENTS placeholders', () => {
        const templates = [tmpl('repeat', '$ARGUMENTS and $ARGUMENTS')];
        expect(compactPromptSessionName('x and x', templates)).toBeUndefined();
    });

    it('skips template with $@ and $ARGUMENTS together', () => {
        const templates = [tmpl('mixed', '$@ and $ARGUMENTS')];
        expect(compactPromptSessionName('a and b', templates)).toBeUndefined();
    });

    it('skips when captured text contains unexpanded $ARGUMENTS token', () => {
        const templates = [tmpl('echo', 'Echo: $ARGUMENTS')];
        expect(
            compactPromptSessionName('Echo: $ARGUMENTS', templates),
        ).toBeUndefined();
    });

    it('skips when captured text contains unexpanded $@ token', () => {
        const templates = [tmpl('echo2', 'Repeat: $@')];
        expect(
            compactPromptSessionName('Repeat: $@', templates),
        ).toBeUndefined();
    });

    it('returns undefined when text does not start with prefix', () => {
        const templates = [tmpl('specific', 'Analyze $ARGUMENTS for bugs')];
        expect(
            compactPromptSessionName('Explain TypeScript for bugs', templates),
        ).toBeUndefined();
    });

    it('returns undefined when text does not end with suffix', () => {
        const templates = [tmpl('specific', 'Analyze $ARGUMENTS for bugs')];
        expect(
            compactPromptSessionName(
                'Analyze TypeScript for errors',
                templates,
            ),
        ).toBeUndefined();
    });

    it('returns undefined when two templates match the same text', () => {
        const templates = [
            tmpl('t1', 'Hello $ARGUMENTS world'),
            tmpl('t2', 'Hello $ARGUMENTS world'),
        ];
        expect(
            compactPromptSessionName('Hello beautiful world', templates),
        ).toBeUndefined();
    });

    it('normalizes newlines in captured text via shared normalizeName', () => {
        const templates = [
            tmpl('multi', 'Process $ARGUMENTS carefully with great detail'),
        ];
        expect(
            compactPromptSessionName(
                'Process hello\r\nworld carefully with great detail',
                templates,
            ),
        ).toBe('/prompt:multi hello world');
    });

    it('matches the correct template when only one matches', () => {
        const templates = [
            tmpl('catchall', '$ARGUMENTS'),
            tmpl(
                'specific',
                'Explain $ARGUMENTS in simple terms with examples',
            ),
        ];
        expect(
            compactPromptSessionName(
                'Explain TypeScript generics in simple terms with examples',
                templates,
            ),
        ).toBe('/prompt:specific TypeScript generics');
    });
});

// ---------------------------------------------------------------------------
// defaultPromptLoader
// ---------------------------------------------------------------------------

describe('defaultPromptLoader', () => {
    it('exports a PromptLoader function', () => {
        expect(typeof defaultPromptLoader).toBe('function');
    });
});

// ---------------------------------------------------------------------------
// promptSessionNameDetector
// ---------------------------------------------------------------------------

describe('promptSessionNameDetector', () => {
    it('returns name using injected loader', async () => {
        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);
        const detector = promptSessionNameDetector({ loader });
        const result = await detector({
            entries: [],
            firstUserText:
                'Explain TypeScript generics in simple terms with examples',
            cwd: '/test',
            currentName: undefined,
        });
        expect(result).toBe('/prompt:explain TypeScript generics');
    });

    it('returns undefined for non-matching text', async () => {
        const loader: PromptLoader = mock(async () => [
            tmpl('codereview', 'Review the following code for style issues'),
        ]);
        const detector = promptSessionNameDetector({ loader });
        const result = await detector({
            entries: [],
            firstUserText: 'Explain TypeScript generics',
            cwd: '/test',
            currentName: undefined,
        });
        expect(result).toBeUndefined();
    });

    it('returns undefined when no cwd provided', async () => {
        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);
        const detector = promptSessionNameDetector({ loader });
        const result = await detector({
            entries: [],
            firstUserText:
                'Explain TypeScript generics in simple terms with examples',
            cwd: undefined,
            currentName: undefined,
        });
        expect(result).toBeUndefined();
        // loader should not have been called
        expect(loader).not.toHaveBeenCalled();
    });

    it('returns undefined when no firstUserText provided', async () => {
        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);
        const detector = promptSessionNameDetector({ loader });
        const result = await detector({
            entries: [],
            firstUserText: undefined,
            cwd: '/test',
            currentName: undefined,
        });
        expect(result).toBeUndefined();
        expect(loader).not.toHaveBeenCalled();
    });

    it('caches templates per cwd (cache hit)', async () => {
        const loadFn = mock(async () => [tmpl('test', 'Do $ARGUMENTS')]);
        const loader: PromptLoader = loadFn;
        const cache = new Map<string, PromptTemplate[]>();
        const detector = promptSessionNameDetector({ loader, cache });

        await detector({
            entries: [],
            firstUserText: 'Do thing one',
            cwd: '/same',
            currentName: undefined,
        });
        await detector({
            entries: [],
            firstUserText: 'Do thing two',
            cwd: '/same',
            currentName: undefined,
        });

        // Loader called once; second hit served from cache
        expect(loadFn).toHaveBeenCalledTimes(1);
    });

    it('loads templates separately for different cwds', async () => {
        const loadFn = mock(async (cwd: string) => {
            if (cwd === '/cwd1') {
                return [
                    tmpl(
                        't1',
                        'Please execute the following command $ARGUMENTS and report the output',
                    ),
                ];
            }
            return [
                tmpl(
                    't2',
                    'Please answer the following question $ARGUMENTS and be thorough',
                ),
            ];
        });
        const loader: PromptLoader = loadFn;
        const cache = new Map<string, PromptTemplate[]>();
        const detector = promptSessionNameDetector({ loader, cache });

        const r1 = await detector({
            entries: [],
            firstUserText:
                'Please execute the following command hello and report the output',
            cwd: '/cwd1',
            currentName: undefined,
        });
        const r2 = await detector({
            entries: [],
            firstUserText:
                'Please answer the following question world and be thorough',
            cwd: '/cwd2',
            currentName: undefined,
        });

        expect(r1).toBe('/prompt:t1 hello');
        expect(r2).toBe('/prompt:t2 world');
        expect(loadFn).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// migrateSessionFile
// ---------------------------------------------------------------------------

describe('migrateSessionFile', () => {
    let tmpFiles: string[] = [];

    afterAll(async () => {
        for (const f of tmpFiles) {
            await rm(f, { recursive: true, force: true });
        }
    });

    /** Write a temp session file and track for cleanup. */
    async function writeTempSession(content: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-migrate-test-'));
        const fp = join(dir, 'session.jsonl');
        await writeFile(fp, content);
        tmpFiles.push(dir);
        return fp;
    }

    it('returns would-migrate in dry-run mode without modifying file', async () => {
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        const fp = await writeTempSession(content);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);

        const result = await migrateSessionFile(fp, 'dry-run', loader);

        expect(result).toEqual({
            status: 'would-migrate',
            name: '/prompt:explain TypeScript',
        });

        // File must not be modified
        const after = await Bun.file(fp).text();
        expect(after).toBe(content);
    });

    it('appends session_info line in force mode', async () => {
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        const fp = await writeTempSession(content);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);

        const result = await migrateSessionFile(fp, 'force', loader);

        expect(result).toEqual({
            status: 'migrated',
            name: '/prompt:explain TypeScript',
        });

        // File should have an extra line appended
        const after = await Bun.file(fp).text();
        const lines = after.trim().split('\n');
        expect(lines).toHaveLength(3); // session + message + session_info
        expect(parseJsonLine(lines[2])).toMatchObject({
            type: 'session_info',
            name: '/prompt:explain TypeScript',
        });
    });

    it('skips session with existing name', async () => {
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
            'already-named',
        );
        const fp = await writeTempSession(content);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);

        const result = await migrateSessionFile(fp, 'force', loader);

        expect(result).toEqual({ status: 'skipped' });
        // Loader should not have been called since session already named
        expect(loader).not.toHaveBeenCalled();
    });

    it('propagates loader failure', async () => {
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        const fp = await writeTempSession(content);

        const loader: PromptLoader = mock(async () => {
            throw new Error('loader broke');
        });

        // oxlint-disable-next-line typescript/await-thenable -- Bun's rejects matcher is awaitable at runtime.
        await expect(migrateSessionFile(fp, 'dry-run', loader)).rejects.toThrow(
            'loader broke',
        );
    });
});

// ---------------------------------------------------------------------------
// migrateSessions
// ---------------------------------------------------------------------------

describe('migrateSessions', () => {
    let tmpDirs: string[] = [];

    afterAll(async () => {
        for (const d of tmpDirs) {
            try {
                await rm(d, { recursive: true, force: true });
            } catch {
                // cleanup best-effort
            }
        }
    });

    it('scans directory and returns results for matching sessions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'prompt-migrate-suite-'));
        tmpDirs.push(root);

        // Session 1: unnamed → matches
        const sess1 = makeSessionJsonl(
            '/cwd1',
            'Explain TypeScript in simple terms with examples',
        );
        await writeFile(join(root, 'session1.jsonl'), sess1);

        // Session 2: already named → skipped
        const sess2 = makeSessionJsonl(
            '/cwd2',
            'Do something',
            'existing-name',
        );
        await writeFile(join(root, 'session2.jsonl'), sess2);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);

        const summary = await migrateSessions(root, 'dry-run', loader);

        expect(summary.scanned).toBe(2);
        expect(summary.results).toHaveLength(1);
        expect(summary.results[0].status).toBe('would-migrate');
        expect(summary.results[0].name).toBe('/prompt:explain TypeScript');
        expect(summary.results[0].filePath).toBe(join(root, 'session1.jsonl'));
    });
});

describe('runMigrationCli', () => {
    let tmpCleanup: string[] = [];

    afterAll(async () => {
        for (const d of tmpCleanup) {
            try {
                await rm(d, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
    });

    it('dry-run: prints would migrate and force hint, no file mutation', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-cli-dryrun-'));
        tmpCleanup.push(dir);
        const fp = join(dir, 'session.jsonl');
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        await writeFile(fp, content);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            [],
            dir,
            (msg: string) => output.push(msg),
            loader,
        );

        expect(exitCode).toBe(0);
        const joined = output.join('\n');
        expect(joined).toContain('would migrate');
        expect(joined).toContain('Run with --force');
        expect(joined).toContain('session.jsonl');
        expect(await Bun.file(fp).text()).toBe(content);
    });

    it('invalid args: prints usage and exits 1', async () => {
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            ['--bogus'],
            '/nonexistent',
            (msg: string) => output.push(msg),
        );

        expect(exitCode).toBe(1);
        const joined = output.join('\n');
        expect(joined).toContain('Usage:');
        expect(joined).toContain(
            'bun run scripts/migrate-prompt-session-names.ts',
        );
        expect(joined).toContain('--force');
        expect(joined).toContain('Dry-run');
    });

    it('zero-match: prints no-sessions-found message with safe-current-template wording', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-cli-zero-'));
        tmpCleanup.push(dir);
        const fp = join(dir, 'session.jsonl');
        const content = makeSessionJsonl(
            '/test',
            'Some random text that no prompt matches',
        );
        await writeFile(fp, content);

        const loader: PromptLoader = mock(async () => []);
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            [],
            dir,
            (msg: string) => output.push(msg),
            loader,
        );

        expect(exitCode).toBe(0);
        const joined = output.join('\n');
        expect(joined).toContain('No unnamed prompt-prefixed sessions found');
        expect(joined).toContain('safe current-template');
    });

    it('force-mode: appends session_info, prints migrated, no dry-run guidance', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-cli-force-'));
        tmpCleanup.push(dir);
        const fp = join(dir, 'session.jsonl');
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        await writeFile(fp, content);

        const loader: PromptLoader = mock(async () => [
            tmpl('explain', 'Explain $ARGUMENTS in simple terms with examples'),
        ]);
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            ['--force'],
            dir,
            (msg: string) => output.push(msg),
            loader,
        );

        expect(exitCode).toBe(0);
        const joined = output.join('\n');
        expect(joined).toContain('migrated');
        expect(joined).not.toContain('would migrate');
        expect(joined).not.toContain('Run with --force');
        expect(joined).toContain('session.jsonl');

        // Verify session_info was appended
        const after = await Bun.file(fp).text();
        const lines = after.trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(parseJsonLine(lines[2])).toMatchObject({
            type: 'session_info',
            name: '/prompt:explain TypeScript',
        });
    });

    it('loader failure: reports the file and exits 1', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-cli-fail-'));
        tmpCleanup.push(dir);
        const fp = join(dir, 'session.jsonl');
        const content = makeSessionJsonl(
            '/test',
            'Explain TypeScript in simple terms with examples',
        );
        await writeFile(fp, content);

        const failingLoader: PromptLoader = mock(async () => {
            throw new Error('prompt loading crashed');
        });
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            [],
            dir,
            (msg: string) => output.push(msg),
            failingLoader,
        );

        expect(exitCode).toBe(1);
        const joined = output.join('\n');
        expect(joined).toContain('session.jsonl');
        expect(joined).toContain('failed: prompt loading crashed');
        expect(joined).not.toContain(
            'No unnamed prompt-prefixed sessions found',
        );
    });

    it('continues after a loader failure and reports successful sessions', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-cli-partial-'));
        tmpCleanup.push(dir);
        await writeFile(
            join(dir, 'broken.jsonl'),
            makeSessionJsonl(
                '/broken',
                'Explain TypeScript in simple terms with examples',
            ),
        );
        await writeFile(
            join(dir, 'valid.jsonl'),
            makeSessionJsonl(
                '/valid',
                'Explain TypeScript in simple terms with examples',
            ),
        );
        const loader: PromptLoader = mock(async (cwd) => {
            if (cwd === '/broken') throw new Error('broken project');
            return [
                tmpl(
                    'explain',
                    'Explain $ARGUMENTS in simple terms with examples',
                ),
            ];
        });
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            [],
            dir,
            (message) => output.push(message),
            loader,
        );

        expect(exitCode).toBe(1);
        const joined = output.join('\n');
        expect(joined).toContain('broken.jsonl → failed: broken project');
        expect(joined).toContain(
            'valid.jsonl → would migrate: /prompt:explain TypeScript',
        );
        expect(joined).toContain('Would migrate 1 of 2 session files.');
    });
});

describe('direct execution', () => {
    it('source file has if (import.meta.main) entry point', async () => {
        const source = await Bun.file(
            join(import.meta.dirname, 'migrate-prompt-session-names.ts'),
        ).text();
        expect(source).toContain('if (import.meta.main)');
        expect(source).toContain('process.exitCode');
        expect(source).toContain('runMigrationCli');
    });
});
