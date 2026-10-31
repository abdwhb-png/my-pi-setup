import { test, expect } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archive, run } from './files.ts';

test('archives regular files and internal relative links across different homes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-archive-'));
    try {
        const source = join(root, 'alice');
        const target = join(root, 'bob');
        mkdirSync(source);
        writeFileSync(join(source, 'hello'), 'portable');
        symlinkSync('hello', join(source, 'link'));
        archive('pack', source, join(root, 'setup.tgz'));
        archive('extract', join(root, 'setup.tgz'), target);
        expect(readFileSync(join(target, 'link'), 'utf8')).toBe('portable');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('extraction rejects traversal and symbolic-link parents before writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-unsafe-'));
    try {
        for (const kind of [
            'traversal',
            'link-parent',
            'hardlink',
            'duplicate',
        ]) {
            const input = join(root, `${kind}.tgz`),
                target = join(root, kind);
            run('python3', [
                '-c',
                `import tarfile,io,sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
 k=sys.argv[2]
 a=tarfile.TarInfo('../escape' if k=='traversal' else 'link')
 if k in ('link-parent','hardlink'):
  a.type=tarfile.SYMTYPE if k=='link-parent' else tarfile.LNKTYPE; a.linkname='inside'; t.addfile(a)
 else:
  a.size=1; t.addfile(a,io.BytesIO(b'x'))
 if k in ('link-parent','duplicate'):
  b=tarfile.TarInfo('link/file' if k=='link-parent' else 'link'); b.size=1; t.addfile(b,io.BytesIO(b'x'))`,
                input,
                kind,
            ]);
            expect(() => archive('extract', input, target)).toThrow();
            expect(() => readFileSync(join(root, 'escape'))).toThrow();
            expect(() => readFileSync(join(target, 'link/file'))).toThrow();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
