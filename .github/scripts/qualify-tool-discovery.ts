import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    contained,
    json,
    object,
    run,
    writeJson,
} from '../../agent/bin/setup/files.ts';
import { resolveDevelopmentTools } from '../../agent/extensions/sandbox/development-tools.ts';

assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Real host tool qualification requires a disposable CI host',
);
const source = process.argv[2];
const evidence = process.argv[3];
assert(source && evidence);
const layout = process.env.QUALIFICATION_TOOL_LAYOUT;
assert(layout === 'system' || layout === 'mise');
const profile = json(
    join(source, 'agent/config/sandbox.development.example.json'),
);
const discovered = resolveDevelopmentTools(profile.tools, {
    systemLibraries: profile.systemLibraries,
    variables: object(profile.environment).variables,
});
writeJson(join(evidence, 'tool-discovery.json'), {
    layout,
    tools: discovered.tools,
    installations: discovered.installations,
    unavailable: discovered.unavailable,
});
assert.deepEqual(discovered.unavailable, []);
assert.deepEqual(
    new Set(discovered.tools.map((tool) => tool.command)),
    new Set(['node', 'bun', 'python3', 'go', 'php', 'composer', 'pnpm']),
);
for (const tool of discovered.tools) {
    const executable = realpathSync(tool.executable);
    if (layout === 'mise') {
        // This pinned dev-tools revision deliberately links distro PHP into mise.
        assert(
            tool.command === 'php'
                ? executable.startsWith('/usr/bin/php')
                : contained(
                      join(homedir(), '.local/share/mise/installs'),
                      executable,
                  ),
            `Unexpected ${tool.command} origin in mise qualification: ${executable}`,
        );
    } else {
        assert(
            !contained(join(homedir(), '.local/share/mise'), executable),
            `Unexpected mise fallback for ${tool.command}`,
        );
    }
}
discovered.assertUnchanged();
const retained = resolveDevelopmentTools(profile.tools, {
    systemLibraries: profile.systemLibraries,
    existing: discovered.installations,
    path: join(evidence, 'no-ambient-tools'),
});
assert.deepEqual(retained.unavailable, []);
assert.deepEqual(retained.installations, discovered.installations);
retained.assertUnchanged();

writeFileSync(
    join(evidence, 'main.go'),
    'package main\nimport "fmt"\nfunc main(){fmt.Print("GO_OK")}\n',
);
const checks: Array<[string, string[], string]> = [
    ['node', ['-e', 'console.log("NODE_OK")'], 'NODE_OK'],
    ['bun', ['-e', 'console.log("BUN_OK")'], 'BUN_OK'],
    [
        'python3',
        ['-I', '-S', '-B', '-c', 'import json,ssl,sys; print("PYTHON_OK")'],
        'PYTHON_OK',
    ],
    ['go', ['run', 'main.go'], 'GO_OK'],
    ['php', ['-r', 'echo json_encode(["PHP_OK"]);'], 'PHP_OK'],
    ['composer', ['--no-plugins', '--no-scripts', '--version'], 'Composer'],
    [
        'pnpm',
        ['--version'],
        discovered.tools.find((tool) => tool.command === 'pnpm')!.version,
    ],
];
for (const [command, args, marker] of checks) {
    const tool = discovered.tools.find((candidate) => candidate.command === command);
    assert(tool);
    const output = run(tool.executable, args, evidence, {
        ...process.env,
        COREPACK_ENABLE_NETWORK: '0',
        GOTOOLCHAIN: 'local',
        GOENV: 'off',
        CGO_ENABLED: '0',
        GOPROXY: 'off',
        GOSUMDB: 'off',
        COMPOSER_ALLOW_SUPERUSER: '0',
        COMPOSER_HOME: join(evidence, 'composer-home'),
    });
    assert(
        output.includes(marker),
        `${command} startup did not return its expected marker`,
    );
}
const absent = resolveDevelopmentTools(profile.tools, {
    systemLibraries: profile.systemLibraries,
    path: join(evidence, 'missing-bin'),
});
assert.equal(
    absent.unavailable.length,
    Object.keys(object(profile.tools)).length,
);
assert.deepEqual(absent.installations, {});
writeJson(join(evidence, 'tool-contracts.json'), {
    status: 'passed',
    layout,
    commands: discovered.tools.map((tool) => tool.command),
    cases: [
        'fresh discovery',
        'canonical executable origin',
        'retained authority without ambient PATH',
        'runtime startup',
        'missing commands',
    ],
    unrelatedSystemPhpPresent: existsSync('/usr/share/php'),
    scope: 'Host tool discovery and startup; native sandbox execution is qualified separately on Ubuntu and WSL2',
});
