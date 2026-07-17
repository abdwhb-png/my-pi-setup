import { homedir } from 'node:os';

export interface YeetCommandArgs {
    cwd: string;
    autoApprove: boolean;
    instructions: string;
    error?: string;
}

function expandHomePath(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return homedir() + path.slice(1);
    return path;
}

function tokenizeArgs(args: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;

    for (const character of args.trim()) {
        if (character === '"' || character === "'") {
            if (quote === character) quote = null;
            else if (quote === null) quote = character;
            else current += character;
            continue;
        }
        if (/\s/.test(character) && quote === null) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += character;
    }

    if (current) tokens.push(current);
    return tokens;
}

export function parseYeetCommandArgs(
    args: string,
    defaultCwd: string,
): YeetCommandArgs {
    const tokens = tokenizeArgs(args);
    const instructions: string[] = [];
    let cwd = defaultCwd;
    let autoApprove = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--go') {
            autoApprove = true;
            continue;
        }
        if (token === '--cwd') {
            const value = tokens[index + 1];
            if (!value || value.startsWith('--')) {
                return {
                    cwd,
                    autoApprove,
                    instructions: instructions.join(' '),
                    error: '--cwd requires a path',
                };
            }
            cwd = expandHomePath(value);
            index += 1;
            continue;
        }
        if (token.startsWith('--cwd=')) {
            const value = token.slice('--cwd='.length);
            if (!value) {
                return {
                    cwd,
                    autoApprove,
                    instructions: instructions.join(' '),
                    error: '--cwd requires a path',
                };
            }
            cwd = expandHomePath(value);
            continue;
        }
        instructions.push(token);
    }

    return {
        cwd,
        autoApprove,
        instructions: instructions.join(' '),
    };
}
