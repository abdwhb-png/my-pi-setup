import { expect, test } from 'bun:test';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { createMcpRefResolver } from '../mcp/ref-resolver.ts';
import { resolveToolAliases } from './resolver.ts';

for (const grouped of [false, true]) {
    test.each(['mcp:docs', 'mcp:docs/search'])(
        'valid reference %s remains unresolved (grouped=' + grouped + ')',
        (reference) => {
            const result = resolveToolAliases(
                grouped ? ['@docs'] : [reference],
                [],
                { docs: [reference] },
                createMcpRefResolver(() => []),
            );
            expect(result.names).toEqual([]);
            expect(result.diagnostics).toEqual([
                expect.objectContaining({
                    code: 'unresolved-mcp-reference',
                    group: grouped ? 'docs' : '<active>',
                    member: reference,
                }),
            ]);
        },
    );

    test.each(['mcp:', 'mcp:/search', 'mcp:docs/'])(
        'malformed reference %s remains invalid (grouped=' + grouped + ')',
        (reference) => {
            const result = resolveToolAliases(
                grouped ? ['@docs'] : [reference],
                [],
                { docs: [reference] },
                createMcpRefResolver(() => []),
            );
            expect(result.names).toEqual([]);
            expect(result.diagnostics).toEqual([
                expect.objectContaining({
                    code: 'invalid-mcp-reference',
                    member: reference,
                    group: grouped ? 'docs' : '<active>',
                }),
            ]);
        },
    );
}

test('late native registration resolves the reference and hidden tools stay excluded', () => {
    let tools: Array<Pick<ToolInfo, 'name' | 'namespace' | 'exposure'>> = [];
    const resolveMcp = createMcpRefResolver(() => tools);
    const resolve = () => resolveToolAliases(
        ['@docs'],
        tools.map((tool) => tool.name),
        { docs: ['mcp:docs/search'] },
        resolveMcp,
    );
    expect(resolve().names).toEqual([]);
    tools = [{ name: 'mcp__docs__search', namespace: { name: 'mcp__docs' }, exposure: 'deferred' }];
    expect(resolve()).toMatchObject({ names: ['mcp__docs__search'], diagnostics: [] });
    tools[0]!.exposure = 'hidden';
    expect(resolve().names).toEqual([]);
    expect(resolve().diagnostics[0]?.code).toBe('unresolved-mcp-reference');
});
