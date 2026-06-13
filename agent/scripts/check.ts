import { spawnSync } from 'node:child_process';

const PHASES: { label: string; script: string }[] = [
    { label: 'Syntax check', script: 'bun run check:parse' },
    { label: 'Type check',   script: 'bun run types:check' },
    { label: 'Lint',         script: 'bun run lint' },
    { label: 'Tests',        script: 'bun test' },
];

for (const phase of PHASES) {
    console.log(`\n── ${phase.label} ──\n`);

    const result = spawnSync(phase.script, [], {
        encoding: 'utf-8',
        cwd: process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: true,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output.trim()) {
        console.log(output.trimEnd());
    }

    if (result.status !== 0) {
        console.log(`\n❌ ${phase.label} failed (exit code ${result.status}).`);
        process.exit(1);
    }

    console.log(`✅ ${phase.label} passed.`);
}

console.log('\n✅ All checks passed!');
process.exit(0);

// ── All passed ──

console.log('\n✅ All checks passed!');
process.exit(0);