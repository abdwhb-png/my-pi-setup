import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

test.skipIf(process.env.PI_PORTABLE_PROFILE_CONTRACT !== '1')(
    'the installed footer consumes both restored preference files when rendering',
    async () => {
        assert.equal(
            process.env.GITHUB_ACTIONS,
            'true',
            'Installed runtime checks require disposable CI hosts',
        );
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        assert(agentDir);
        const cwd = mkdtempSync(join(tmpdir(), 'pi-installed-footer-'));
        const originalFetch = globalThis.fetch;
        let networkAttempts = 0;
        let disposeFooter = () => {};
        let closeSession: (() => Promise<void>) | undefined;
        globalThis.fetch = Object.assign(
            async () => {
                networkAttempts++;
                throw new Error(
                    'Network access is forbidden in the footer contract',
                );
            },
            { preconnect: originalFetch.preconnect },
        );
        try {
            const { DefaultPackageManager, SettingsManager, Theme } =
                await import('@earendil-works/pi-coding-agent');
            const { TuiMainScreen, visibleWidth } =
                await import('@earendil-works/pi-tui');
            const { createWidget } =
                await import('../../extensions/_shared/fancy-footer.ts');
            const { createTestSession } =
                await import('@abdwhb-png/pi-test-harness');
            const manager = new DefaultPackageManager({
                cwd,
                agentDir,
                settingsManager: SettingsManager.create(cwd, agentDir),
            });
            const footerPackage = manager
                .listConfiguredPackages()
                .find(({ source }) =>
                    source.startsWith(
                        'git:github.com/abdwhb-png/pi-fancy-footer@',
                    ),
                );
            assert(
                footerPackage?.installedPath,
                'Expected the pinned installed footer package',
            );
            const installedRoot = realpathSync(footerPackage.installedPath);
            const resources = await manager.resolve(async () => 'error');
            const entries = resources.extensions.filter(
                ({ enabled, metadata }) =>
                    enabled &&
                    metadata.packageRoot &&
                    realpathSync(metadata.packageRoot) === installedRoot,
            );
            assert.equal(
                entries.length,
                1,
                'Expected one declared footer extension entrypoint',
            );
            console.info(`Footer package under test: ${installedRoot}`);
            const harness = await createTestSession({
                cwd,
                extensions: [entries[0]!.path],
                extensionFactories: [
                    (pi) => {
                        createWidget(pi, {
                            id: 'local-compressor',
                            label: 'Compressor',
                            row: 0,
                            order: 12,
                            render: () => 'COMPRESSOR_PREF',
                        });
                    },
                ],
            });
            closeSession = () => harness.close();
            const factory = harness.events.uiCallsFor('setFooter').at(-1)
                ?.args[0];
            assert.equal(
                typeof factory,
                'function',
                'session_start must install a footer',
            );
            assert(typeof factory === 'function');
            const theme = new Theme(
                {
                    accent: '',
                    border: '',
                    borderAccent: '',
                    borderMuted: '',
                    success: '',
                    error: '',
                    warning: '',
                    muted: '',
                    dim: '',
                    text: '',
                    thinkingText: '',
                    userMessageText: '',
                    customMessageText: '',
                    customMessageLabel: '',
                    toolTitle: '',
                    toolOutput: '',
                    mdHeading: '',
                    mdLink: '',
                    mdLinkUrl: '',
                    mdCode: '',
                    mdCodeBlock: '',
                    mdCodeBlockBorder: '',
                    mdQuote: '',
                    mdQuoteBorder: '',
                    mdHr: '',
                    mdListBullet: '',
                    toolDiffAdded: '',
                    toolDiffRemoved: '',
                    toolDiffContext: '',
                    syntaxComment: '',
                    syntaxKeyword: '',
                    syntaxFunction: '',
                    syntaxVariable: '',
                    syntaxString: '',
                    syntaxNumber: '',
                    syntaxType: '',
                    syntaxOperator: '',
                    syntaxPunctuation: '',
                    thinkingOff: '',
                    thinkingMinimal: '',
                    thinkingLow: '',
                    thinkingMedium: '',
                    thinkingHigh: '',
                    thinkingXhigh: '',
                    bashMode: '',
                },
                {
                    selectedBg: '',
                    userMessageBg: '',
                    customMessageBg: '',
                    toolPendingBg: '',
                    toolSuccessBg: '',
                    toolErrorBg: '',
                },
                'truecolor',
            );
            const tui = new TuiMainScreen({
                columns: 145,
                rows: 31,
                kittyProtocolActive: false,
                start() {},
                stop() {},
                async drainInput() {},
                write() {},
                moveBy() {},
                hideCursor() {},
                showCursor() {},
                clearLine() {},
                clearFromCursor() {},
                clearScreen() {},
                setTitle() {},
                setProgress() {},
                setProgramStatus() {},
            });
            type FooterFactory = NonNullable<
                Parameters<ExtensionUIContext['setFooter']>[0]
            >;
            const footerData: Parameters<FooterFactory>[2] = {
                getGitBranch: () => null,
                getExtensionStatuses: () =>
                    new Map([
                        ['fixture-hidden', 'HIDDEN_PREF'],
                        ['fixture-visible', 'VISIBLE_PREF ' + 'x'.repeat(160)],
                        ['fixture-second', 'SECOND_PREF'],
                        ['fixture-third', 'THIRD_PREF'],
                    ]),
                getAvailableProviderCount: () => 1,
                onBranchChange: () => () => {},
            };
            const footer: ReturnType<FooterFactory> = factory(
                tui,
                theme,
                footerData,
            );
            disposeFooter = () => footer.dispose?.();
            const model = harness.session.model;
            assert(model);
            const rendered = footer.render(120).join('\n');
            expect(rendered.trim().length).toBeGreaterThan(0);
            expect(rendered).not.toContain(model.name);
            const widgetFactory = harness.events
                .uiCallsFor('setWidget')
                .find(({ args }) => args[0] === 'pi-fancy-footer:above')
                ?.args[1];
            assert(typeof widgetFactory === 'function');
            const widget: Component = widgetFactory(tui, theme);
            const aboveLines = widget.render(145);
            const above = aboveLines.join('\n');
            expect(above).toContain('VISIBLE_PREF');
            expect(above).toContain('SECOND_PREF');
            expect(above).toContain('THIRD_PREF');
            expect(above).toContain('COMPRESSOR_PREF');
            expect(above.indexOf('COMPRESSOR_PREF')).toBeGreaterThan(
                above.indexOf('THIRD_PREF'),
            );
            expect(aboveLines.every((line) => visibleWidth(line) <= 145)).toBe(
                true,
            );
            expect(above).not.toContain('HIDDEN_PREF');
            expect(networkAttempts).toBe(0);
        } finally {
            try {
                disposeFooter();
                await closeSession?.();
            } finally {
                globalThis.fetch = originalFetch;
                rmSync(cwd, { recursive: true, force: true });
            }
        }
    },
);

test.skipIf(process.env.PI_PORTABLE_PROFILE_CONTRACT !== '1')(
    'the installed role command completes every committed user role',
    async () => {
        assert.equal(
            process.env.GITHUB_ACTIONS,
            'true',
            'Installed runtime checks require disposable CI hosts',
        );
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        assert(agentDir);
        const roleFiles: string[] = JSON.parse(
            process.env.PI_PORTABLE_ROLE_FILES ?? '[]',
        );
        assert(
            roleFiles.length > 0,
            'Expected role paths from the committed source tree',
        );
        const cwd = mkdtempSync(join(tmpdir(), 'pi-installed-roles-'));
        const { createTestSession } =
            await import('@abdwhb-png/pi-test-harness');
        const { loadRoleFile } =
            await import('../../extensions/pi-roles/core/roles.ts');
        const harness = await createTestSession({
            cwd,
            extensions: [join(agentDir, 'extensions/pi-roles/index.ts')],
        });
        try {
            const command = harness.session.extensionRunner.getCommand('role');
            assert(command?.getArgumentCompletions);
            const names =
                (await command.getArgumentCompletions(''))?.map(
                    (item) => item.value,
                ) ?? [];
            for (const path of roleFiles.filter((path) =>
                /^agent\/roles\/[^/]+\.md$/.test(path),
            )) {
                const role = loadRoleFile(
                    join(agentDir, path.slice('agent/'.length)),
                    'user',
                );
                expect(names).toContain(role.frontmatter.name);
            }
        } finally {
            await harness.close();
            rmSync(cwd, { recursive: true, force: true });
        }
    },
);
