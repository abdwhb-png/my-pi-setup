import { expect, test } from 'bun:test';
import { Type } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { injectProviderToolsCatalog, appendToolsListPrompt, CATALOG_START } from './provider-catalog.ts';

const fn = { name: 'edit', description: 'Edit a file', parameters: { type: 'object' } };

test('pi-messages catalogs the current transcript tools and updates the transmitted prompt', () => {
    const edit = { name: 'edit', description: 'Edit a file', parameters: Type.Object({}) };
    const read = { name: 'read', description: 'Read a file', parameters: Type.Object({}) };
    const safeBash = { name: 'safe_bash', description: 'Run a command', parameters: Type.Object({}) };
    const context = normalizeContext({
        systemPrompt: 'Custom',
        tools: [edit, read],
        messages: [
            { role: 'user', content: 'Continue', timestamp: 1 },
            { role: 'system', content: 'Later instructions', toolsRemoved: [{ name: 'read' }], toolsAdded: [safeBash], timestamp: 2 },
        ],
    });
    const before = structuredClone(context);
    const result = injectProviderToolsCatalog('pi-messages', { context, options: { toolChoice: 'auto' } });
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error(result.reason);
    expect(result.tools.map(tool => tool.name)).toEqual(['edit', 'safe_bash']);
    const sent = result.payload as { context: typeof context };
    expect(getCurrentSystemPrompt(sent.context.messages)).toContain('- safe_bash: Run a command');
    expect(getCurrentSystemPrompt(sent.context.messages)).not.toContain('- read: Read a file');
    expect(sent.context).not.toHaveProperty('systemPrompt');
    expect(context).toEqual(before);
});
const cases: Array<[string, Record<string, unknown>]> = [
    ['openai-completions', { messages: [{ role: 'system', content: 'Custom' }], tools: [{ type: 'function', function: fn }] }],
    ['mistral-conversations', { messages: [{ role: 'system', content: 'Custom' }], tools: [{ type: 'function', function: fn }] }],
    ['openai-responses', { input: [{ role: 'developer', content: 'Custom' }], tools: [{ type: 'function', ...fn }] }],
    ['azure-openai-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }] }],
    ['openai-codex-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }] }],
    ['anthropic-messages', { messages: [], system: [{ type: 'text', text: 'Custom', cache_control: { type: 'ephemeral' } }], tools: [{ ...fn, input_schema: {} }] }],
    ['google-generative-ai', { contents: [], config: { systemInstruction: 'Custom', tools: [{ functionDeclarations: [fn] }] } }],
    ['google-vertex', { contents: [], config: { systemInstruction: { parts: [{ text: 'Custom' }] }, tools: [{ functionDeclarations: [fn] }] } }],
    ['bedrock-converse-stream', { messages: [], system: [{ text: 'Custom' }, { cachePoint: { type: 'default' } }], toolConfig: { tools: [{ toolSpec: { ...fn, inputSchema: { json: {} } } }] } }],
    ['pi-messages', { context: normalizeContext({ systemPrompt: 'Custom', messages: [], tools: [{ ...fn, parameters: Type.Object({}) }] }) }],
];
for (const [api, payload] of cases) {
    test(`${api}: injects exactly the request tools and preserves the original payload`, () => {
        const original = structuredClone(payload);
        const result = injectProviderToolsCatalog(api, payload);
        expect(result.supported).toBe(true);
        if (!result.supported) throw new Error(result.reason);
        expect(result.tools.map(t => t.name)).toEqual(['edit']);
        expect(JSON.stringify(result.payload)).toContain('- edit: Edit a file');
        expect(payload).toEqual(original);
        const repeated = injectProviderToolsCatalog(api, result.payload);
        expect(repeated).toEqual(result);
    });
}
test('replaces stale lists while retaining unrelated headings and descriptions without text', () => {
    const prompt = 'User explanation of Available tools:\nKeep this text.';
    const first = appendToolsListPrompt(prompt, [{ name: 'read' }]);
    const second = appendToolsListPrompt(first, [{ name: 'edit' }]);
    expect(second).toContain(prompt);
    expect(second).toContain('- edit');
    expect(second).not.toContain('- read');
    expect(second.split(CATALOG_START)).toHaveLength(2);
});
test('separates deferred schemas and ignores provider-native tools', () => {
    const payload = { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', ...fn }] }], tools: [{ type: 'web_search_preview' }, { type: 'function', name: 'read', parameters: {} }] };
    const result = injectProviderToolsCatalog('openai-responses', payload);
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error(result.reason);
    expect(result.tools).toEqual([{ name: 'read', description: undefined, deferred: false }, { name: 'edit', description: 'Edit a file', deferred: true }]);
    expect(result.block).toContain('Deferred tools');
    expect((result.payload as typeof payload).input).toContainEqual(payload.input[0]);
});
test('reports an explicit empty catalog', () => {
    const result = injectProviderToolsCatalog('openai-completions', { messages: [{ role: 'system', content: 'Custom' }] });
    expect(result.supported && result.block).toContain('(no immediate function tools)');
});
test('does not advertise schemas as callable when OpenAI disables tool selection', () => {
    const result = injectProviderToolsCatalog('openai-completions', {
        messages: [{ role: 'system', content: 'Custom' }],
        tools: [{ type: 'function', function: fn }],
        tool_choice: 'none',
    });
    expect(result).toMatchObject({
        supported: true,
        selection: { mode: 'none' },
        callableTools: [],
    });
    expect(result.supported && result.block).toContain('(no immediately callable function tools)');
    expect(result.supported && result.block).toContain('Schemas disabled for this request:');
    expect(result.supported && result.block).toContain('- edit: Edit a file');
});
for (const [api, payload] of [
    ['mistral-conversations', { messages: [], tools: [{ type: 'function', function: fn }], toolChoice: 'none' }],
    ['openai-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }], tool_choice: 'none' }],
    ['azure-openai-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }], tool_choice: 'none' }],
    ['openai-codex-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }], tool_choice: 'none' }],
    ['anthropic-messages', { messages: [], system: 'Custom', tools: [{ ...fn, input_schema: {} }], tool_choice: { type: 'none' } }],
    ['google-generative-ai', { contents: [], config: { systemInstruction: 'Custom', tools: [{ functionDeclarations: [fn] }], toolConfig: { functionCallingConfig: { mode: 'NONE', allowedFunctionNames: ['edit'] } } } }],
    ['google-vertex', { contents: [], config: { systemInstruction: 'Custom', tools: [{ functionDeclarations: [fn] }], toolConfig: { functionCallingConfig: { mode: 'NONE' } } } }],
    ['pi-messages', { context: normalizeContext({ systemPrompt: 'Custom', messages: [], tools: [{ ...fn, parameters: Type.Object({}) }] }), options: { toolChoice: 'none' } }],
] as const) {
    test(`${api}: honors the provider-native disabled selection`, () => {
        const result = injectProviderToolsCatalog(api, payload);
        expect(result).toMatchObject({
            supported: true,
            selection: { mode: 'none' },
            callableTools: [],
        });
        expect(result.supported && result.block).toContain('(no immediately callable function tools)');
        expect(result.supported && result.block).toContain('Schemas disabled for this request:\n- edit: Edit a file');
    });
}
test('restricts callable tools to a provider-selected name', () => {
    const result = injectProviderToolsCatalog('openai-responses', {
        input: [], instructions: 'Custom',
        tools: [{ type: 'function', ...fn }, { type: 'function', name: 'read', parameters: {} }],
        tool_choice: { type: 'function', name: 'edit' },
    });
    expect(result).toMatchObject({
        supported: true,
        selection: { mode: 'named', names: ['edit'] },
        callableTools: [{ name: 'edit' }],
    });
    expect(result.supported && result.block).toContain('Schemas disabled for this request:\n- read');
});
test('keeps valid empty system block shapes for Google and Bedrock', () => {
    const google = injectProviderToolsCatalog('google-vertex', { contents: [], config: { systemInstruction: { parts: [] }, tools: [] } });
    const bedrock = injectProviderToolsCatalog('bedrock-converse-stream', { messages: [], system: [] });
    expect(google.supported && google.payload).toMatchObject({ config: { systemInstruction: { parts: [{ text: expect.any(String) }] } } });
    expect(JSON.stringify(google.supported && google.payload)).not.toContain('"type":"text"');
    expect(JSON.stringify(bedrock.supported && bedrock.payload)).not.toContain('"type":"text"');
    const optionalParts = injectProviderToolsCatalog('google-vertex', { contents: [], config: { systemInstruction: { role: 'user' }, tools: [] } });
    expect(optionalParts.supported && optionalParts.payload).toMatchObject({ config: { systemInstruction: { role: 'user', parts: [{ text: expect.any(String) }] } } });
});
test('rejects unknown API and malformed schema rather than using live or cached tools', () => {
    expect(injectProviderToolsCatalog('future-api', {}).supported).toBe(false);
    expect(injectProviderToolsCatalog('openai-completions', { messages: [], tools: [{}] }).supported).toBe(false);
    expect(injectProviderToolsCatalog('google-vertex', { messages: [], tools: [] }).supported).toBe(false);
    expect(injectProviderToolsCatalog('openai-completions', { messages: [], tools: [], tool_choice: 'surprise' }).supported).toBe(false);
});
