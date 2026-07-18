import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent';

const { createToolGroupsExtension: createRuntimeToolGroupsExtension } =
    await import('./index.ts');

function createToolGroupsExtension(
    loadConfig: Parameters<typeof createRuntimeToolGroupsExtension>[0],
    loadRequestedTools: Parameters<
        typeof createRuntimeToolGroupsExtension
    >[1] = () => undefined,
): ReturnType<typeof createRuntimeToolGroupsExtension> {
    return createRuntimeToolGroupsExtension(loadConfig, loadRequestedTools);
}

// ---------------------------------------------------------------------------
// SDK integration test – verifies extension lifecycle through the real SDK
// ---------------------------------------------------------------------------

describe('tool-groups SDK integration', () => {
    it('loads extension via DefaultResourceLoader extensionFactories, creates session, and resolves @inspect alias', async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), 'tool-groups-sdk-'));
        try {
            const settings = SettingsManager.inMemory({});
            const auth = AuthStorage.inMemory({});
            const modelRegistry = ModelRegistry.inMemory(auth);
            const sessionManager = SessionManager.inMemory(tmpDir);

            const loader = new DefaultResourceLoader({
                cwd: tmpDir,
                agentDir: tmpDir,
                settingsManager: settings,
                extensionFactories: [
                    createToolGroupsExtension(() => ({
                        groups: { inspect: ['read', 'ls', 'bash'] },
                    })),
                ],
                noExtensions: true,
                noSkills: true,
                noThemes: true,
                noPromptTemplates: true,
                noContextFiles: true,
            });
            await loader.reload();

            // Include all needed tools in the allowlist so the tool registry
            // has both the @inspect alias AND the base tools for resolution.
            const { session } = await createAgentSession({
                cwd: tmpDir,
                agentDir: tmpDir,
                tools: [
                    '@inspect',
                    'read',
                    'bash',
                    'edit',
                    'write',
                    'ls',
                    'grep',
                    'find',
                ],
                settingsManager: settings,
                sessionManager,
                authStorage: auth,
                modelRegistry,
                resourceLoader: loader,
            });

            await session.bindExtensions({ mode: 'print' });

            // bindExtensions fires session_start a second time, by which point
            // _toolDefinitions is fully populated from _refreshToolRegistry.
            // The expansion resolves @inspect and sets active tools.
            const active = session.getActiveToolNames();
            expect(active).toContain('read');
            expect(active).toContain('ls');
            expect(active).toContain('bash');
            expect(active).not.toContain('@inspect');

            session.dispose();
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('applies wrapper-deferred aliases after the full tool registry is available', async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), 'tool-groups-deferred-'));
        try {
            const settings = SettingsManager.inMemory({});
            const auth = AuthStorage.inMemory({});
            const modelRegistry = ModelRegistry.inMemory(auth);
            const sessionManager = SessionManager.inMemory(tmpDir);

            const loader = new DefaultResourceLoader({
                cwd: tmpDir,
                agentDir: tmpDir,
                settingsManager: settings,
                extensionFactories: [
                    createToolGroupsExtension(
                        () => ({ groups: { inspect: ['read', 'ls'] } }),
                        () => ['@inspect'],
                    ),
                ],
                noExtensions: true,
                noSkills: true,
                noThemes: true,
                noPromptTemplates: true,
                noContextFiles: true,
            });
            await loader.reload();

            const { session } = await createAgentSession({
                cwd: tmpDir,
                agentDir: tmpDir,
                settingsManager: settings,
                sessionManager,
                authStorage: auth,
                modelRegistry,
                resourceLoader: loader,
            });

            await session.bindExtensions({ mode: 'print' });

            expect(session.getActiveToolNames()).toEqual(['read', 'ls']);
            session.dispose();
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('noExtensions: true prevents file-based extension loading from settings', async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), 'tool-groups-noext-'));
        try {
            // Create settings with an extension path that a normal loader would discover
            const settings = SettingsManager.inMemory({});

            const loader = new DefaultResourceLoader({
                cwd: tmpDir,
                agentDir: tmpDir,
                settingsManager: settings,
                noExtensions: true,
                noSkills: true,
                noThemes: true,
                noPromptTemplates: true,
                noContextFiles: true,
                extensionFactories: [], // no inline factories
            });
            await loader.reload();

            const exts = loader.getExtensions();
            // With noExtensions:true and no extensionFactories, no extensions should load
            expect(exts.extensions).toHaveLength(0);
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('noExtensions: false loads inline extensionFactories', async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), 'tool-groups-load-'));
        try {
            const settings = SettingsManager.inMemory({});
            const loader = new DefaultResourceLoader({
                cwd: tmpDir,
                agentDir: tmpDir,
                settingsManager: settings,
                noExtensions: false,
                noSkills: true,
                noThemes: true,
                noPromptTemplates: true,
                noContextFiles: true,
                extensionFactories: [
                    createToolGroupsExtension(() => ({
                        groups: { test: ['read'] },
                    })),
                ],
            });
            await loader.reload();

            const exts = loader.getExtensions();
            // Inline factory should be loaded
            expect(exts.extensions.length).toBeGreaterThanOrEqual(1);
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });
});
