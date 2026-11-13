import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.each([
    { mode: 'tools-only', layout: 'system' },
    { mode: 'tools-only', layout: 'mise' },
    { mode: 'private', layout: 'system' },
])(
    'qualification prepares $layout tools and restores locked archives only for $mode installation',
    ({ mode, layout }) => {
        const root = mkdtempSync(join(tmpdir(), 'pi-qualification-shell-'));
        try {
            const source = join(root, 'source');
            const scripts = join(source, '.github/scripts');
            mkdirSync(scripts, { recursive: true });
            symlinkSync(
                resolve(import.meta.dir, 'restore-pi-runtime.py'),
                join(scripts, 'restore-pi-runtime.py'),
            );
            symlinkSync(
                resolve(import.meta.dir, '../fixtures'),
                join(source, '.github/fixtures'),
            );
            mkdirSync(join(source, 'agent'));
            const filename = readdirSync(
                resolve(import.meta.dir, '../fixtures/pi-core-1.5.0/tarballs'),
            ).find((name) =>
                name.startsWith('earendil-works-pi-coding-agent-'),
            );
            if (!filename)
                throw new Error(
                    'The frozen Pi fixture must include the coding agent archive',
                );
            const archive = `../runtime/pi-core/releases/fixture/packed/tarballs/${filename}`;
            writeFileSync(
                join(source, 'agent/package.json'),
                JSON.stringify({
                    dependencies: {
                        '@earendil-works/pi-coding-agent': `file:${archive}`,
                    },
                }),
            );
            const bin = join(root, 'bin');
            mkdirSync(bin);
            const log = join(root, 'commands.jsonl');
            const bashEnvironment = join(root, 'kernel-controls.sh');
            writeFileSync(
                bashEnvironment,
                `test() {
  if [ "$#" -eq 2 ] && [ "$1" = -e ]; then
    case "$2" in
      /proc/sys/kernel/unprivileged_userns_clone|/proc/sys/kernel/apparmor_restrict_unprivileged_userns) return 0 ;;
    esac
  fi
  builtin test "$@"
}\n`,
            );
            const fake = join(bin, 'fake');
            writeFileSync(
                fake,
                `#!/usr/bin/python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['PI_QUALIFICATION_TEST_LOG'],'a') as log: log.write(json.dumps([name,*args])+'\\n')
if name=='uname': print('x86_64' if args==['-m'] else 'Linux fixture')
elif name=='node': print('v24.18.0')
elif name=='bun' and args==['--version']: print('1.3.14')
elif name=='bun' and args[:2]==['bin/pi-fork','import']:
    agent=Path.cwd()/'agent'
    for spec in json.loads((agent/'package.json').read_text())['dependencies'].values():
        if not (agent/spec.removeprefix('file:')).is_file():
            print('Locked Pi archive is missing before import', file=sys.stderr); sys.exit(92)
elif name=='npm' and args[0]=='view': print(args[1].rsplit('@',1)[1])
elif name=='git' and args[0]=='clone':
    destination=Path(args[-1]); destination.mkdir(parents=True)
    (destination/'bootstrap.sh').write_text('#!/bin/sh\\nexit 0\\n')
elif name in ('curl','tar'): sys.exit(91)
`,
                { mode: 0o700 },
            );
            for (const command of [
                'sudo',
                'uname',
                'node',
                'bun',
                'npm',
                'sfw',
                'git',
                'timeout',
                'curl',
                'tar',
            ])
                symlinkSync(fake, join(bin, command));
            const result = spawnSync(
                'bash',
                [
                    resolve(import.meta.dir, 'qualify-portable-setup.sh'),
                    mode,
                    join(root, 'qualification'),
                ],
                {
                    cwd: source,
                    env: {
                        ...process.env,
                        PATH: `${bin}:/usr/bin:/bin`,
                        GITHUB_ACTIONS: 'true',
                        GITHUB_SHA: 'a'.repeat(40),
                        QUALIFICATION_PLATFORM: 'ubuntu',
                        QUALIFICATION_TOOL_LAYOUT: layout,
                        PI_QUALIFICATION_TEST_LOG: log,
                        BASH_ENV: bashEnvironment,
                    },
                    encoding: 'utf8',
                    timeout: 10000,
                },
            );
            expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
            const calls: string[][] = readFileSync(log, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            const apt = new Set(
                calls
                    .filter(
                        (call) => call[0] === 'sudo' && call[1] === 'apt-get',
                    )
                    .flat(),
            );
            expect(apt.has('php-cli')).toBe(layout === 'system');
            expect(apt.has('composer')).toBe(layout === 'system');
            expect(apt.has('golang-go')).toBe(layout === 'system');
            expect(
                calls.some((call) => call[0] === 'git' && call[1] === 'clone'),
            ).toBe(layout === 'mise');
            expect(
                calls.some(
                    (call) =>
                        call[0] === 'timeout' &&
                        call.some((arg) =>
                            arg.endsWith('qualify-tool-discovery.ts'),
                        ),
                ),
            ).toBe(true);
            expect(
                calls.some(
                    (call) =>
                        call[0] === 'bun' &&
                        call.includes('test') &&
                        call.some((arg) =>
                            arg.endsWith('development-tools.test.ts'),
                        ),
                ),
            ).toBe(mode === 'tools-only');
            expect(
                calls.some((call) =>
                    call.some((arg) => arg.includes('bin/pi-fork')),
                ),
            ).toBe(mode !== 'tools-only');
            expect(calls.some((call) => call.includes('sysctl'))).toBe(
                mode !== 'tools-only',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
);
