import { expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import contextExtension from '../context.ts';
import { tmpdir } from 'node:os';

test('custom prompt catalog follows outgoing schemas rather than the earlier active tools', async () => {
    const hooks = new Map<string, (event: any, ctx: any) => any>();
    contextExtension({
        on: (name: string, handler: any) => { hooks.set(name, handler); },
        registerCommand() {},
        getActiveTools: () => ['read'],
        getAllTools: () => [{ name: 'read', description: 'old read-only role' }],
    } as unknown as ExtensionAPI);
    hooks.get('before_agent_start')?.({ systemPrompt: 'Custom SYSTEM', systemPromptOptions: { customPrompt: 'Custom SYSTEM' } }, {});
    expect(hooks.has('before_provider_request')).toBe(true);
    const payload = { messages: [{ role: 'system', content: 'Custom SYSTEM' }], tools: [{ type: 'function', function: { name: 'edit', description: 'Edit files', parameters: {} } }] };
    const result = await hooks.get('before_provider_request')!({ payload }, { model: { api: 'openai-completions' }, ui: { notify() {} } });
    expect(result.messages[0].content).toContain('- edit: Edit files');
    expect(result.messages[0].content).not.toContain('- read:');
    expect(result.tools).toEqual(payload.tools);
});

test('/context separates current tools from the last request and reports unsupported formats without logging payloads', async () => {
    const hooks = new Map<string, (event: any, ctx: any) => any>();
    const commands = new Map<string, any>();
    const notices: string[] = [];
    let sent = '';
    const pi = {
        on: (name: string, handler: any) => hooks.set(name, handler),
        registerCommand: (name: string, command: any) => commands.set(name, command),
        getActiveTools: () => ['read'], getAllTools: () => [{ name: 'read' }],
        getCommands: () => [], getThinkingLevel: () => 'off',
        sendMessage: (message: { content: string }) => { sent = message.content; },
    } as unknown as ExtensionAPI;
    contextExtension(pi);
    const ctx = { cwd: tmpdir(), hasUI: false, model: { api: 'openai-completions' },
        ui: { notify: (message: string) => notices.push(message) }, getSystemPrompt: () => 'Do not log this prompt',
        getContextUsage: () => undefined, sessionManager: { getEntries: () => [] } };
    hooks.get('before_agent_start')!({ systemPromptOptions: { customPrompt: 'Custom' } }, ctx);
    hooks.get('before_provider_request')!({ payload: { messages: [], tools: [{ type: 'function', function: { name: 'edit' } }] } }, ctx);
    await commands.get('context').handler('', ctx);
    expect(sent).toContain('Active now: read');
    expect(sent).toContain('Last request #1 (openai-completions): edit');
    expect(sent).toContain('Current vs last request: +[read] -[edit]');
    expect(sent).not.toContain('Do not log this prompt');
    ctx.model.api = 'future-api';
    for (let i = 0; i < 2; i++) hooks.get('before_provider_request')!({ payload: { private: 'Never log this payload' } }, ctx);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('future-api');
    expect(notices[0]).not.toContain('Never log this payload');
    await commands.get('context').handler('', ctx);
    expect(sent).toContain('Catalog unsupported');
    expect(sent).not.toContain('Last request #1');
    ctx.model.api = 'openai-completions';
    hooks.get('before_agent_start')!({ systemPromptOptions: {} }, ctx);
    const defaultPayload = { messages: [{ role: 'system', content: 'Pi default' }], tools: [] };
    expect(hooks.get('before_provider_request')!({ payload: defaultPayload }, ctx)).toBeUndefined();
    await commands.get('context').handler('', ctx);
    expect(sent).toContain('Last request #4 (openai-completions): (none)');
    expect(JSON.stringify(defaultPayload)).not.toContain('<pi-runtime-tools>');
});
