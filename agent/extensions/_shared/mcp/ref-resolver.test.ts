import { expect, test } from 'bun:test';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { createMcpRefResolver } from './ref-resolver.ts';

test('resolves native namespaces from the current registry including late tools', () => {
    let tools: Array<Pick<ToolInfo, 'name' | 'namespace' | 'exposure'>> = [];
    const resolve = createMcpRefResolver(() => tools);
    expect(resolve('mcp:my-docs')).toEqual([]);
    tools = [{ name: 'mcp__my_docs__search', namespace: { name: 'mcp__my_docs' }, exposure: 'deferred' }];
    expect(resolve('mcp:my-docs')).toEqual(['mcp__my_docs__search']);
    expect(resolve('mcp:my-docs/search')).toEqual(['mcp__my_docs__search']);
    expect(resolve('mcp:my-docs/missing')).toEqual([]);
    expect(resolve('read')).toEqual(['read']);
    tools[0]!.exposure = 'hidden';
    expect(resolve('mcp:my-docs')).toEqual([]);
});
