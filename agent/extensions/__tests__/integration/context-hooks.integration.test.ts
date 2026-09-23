import { expect, test } from 'bun:test';
import { createTestSession } from '@abdwhb-png/pi-test-harness';

import { publicExtensionEntrypoint } from './public-extension-session.ts';

for (const order of ['first', 'last'] as const) test(`catalog ${order}: real Pi hooks preserve GLM/Codex options across requests and model changes`, async () => {
    const context = publicExtensionEntrypoint('context');
    const sidecars = [
        publicExtensionEntrypoint('openai-codex-fast-mode'),
        publicExtensionEntrypoint('pi-glm-tweaks'),
    ];
    const owner = publicExtensionEntrypoint('tool-groups');
    const session = await createTestSession({ systemPrompt: 'Custom SYSTEM',
        extensions: order === 'first' ? [context, ...sidecars, owner] : [...sidecars, context, owner] });
    try {
        const runner = session.session.extensionRunner;
        if (!runner) throw new Error('Missing real Pi runner');
        session.session.agent.state.model = { ...session.session.agent.state.model, provider: 'zai', id: 'glm-5.2', api: 'openai-completions' };
        await runner.emitBeforeAgentStart('Please inspect this fixture thoroughly before doing anything else. '.repeat(3), undefined, { cwd: session.cwd, customPrompt: 'Custom SYSTEM' });
        const params = { model: 'glm-5.2', messages: [{ role: 'system', content: 'Custom SYSTEM' }], tools: [{ type: 'function', function: { name: 'edit', parameters: {} } }], thinking: { type: 'enabled' } };
        const first = await runner.emitBeforeProviderRequest(params) as typeof params;
        expect(JSON.stringify(first)).toContain('- edit');
        expect(first.thinking).toMatchObject({ clear_thinking: true });
        expect(first.tools).toEqual(params.tools);
        const next = await runner.emitBeforeProviderRequest({ ...first, tools: [] }) as typeof params;
        expect(JSON.stringify(next)).not.toContain('- edit');
        expect(JSON.stringify(next)).toContain('(no immediate function tools)');

        session.session.agent.state.model = { ...session.session.agent.state.model, provider: 'openai-codex', id: 'fixture', api: 'openai-codex-responses' };
        await session.session.prompt('/codex-fast-mode on'); // Extension command, no agent/provider call.
        const response = await runner.emitBeforeProviderRequest({ model: 'fixture', stream: true, instructions: 'Custom SYSTEM', input: [], tool_choice: 'auto', prompt_cache_key: 'fixture', tools: [{ type: 'function', name: 'safe_bash', parameters: {} }] });
        expect(response).toMatchObject({ service_tier: 'priority' });
        expect(JSON.stringify(response)).toContain('- safe_bash');

        await runner.emitBeforeAgentStart('default', undefined, { cwd: session.cwd, customPrompt: 'Pi default prompt' });
        expect(await runner.emitBeforeProviderRequest(params)).toEqual(params);
    } finally {
        await session.session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
    }
});
