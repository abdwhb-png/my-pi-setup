import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV } from './subagent-profile.ts';

// ---------------------------------------------------------------------------
// Mocks — kept minimal so we exercise the real ponytail.ts wrapper logic.
//
// - ./config: stub loadPonytailConfig to control enabled and defaultMode per test.
// - The wrapper exposes __setFactoryForTests to inject a fake ponytail
//   factory without going through the real npm resolver.
// ---------------------------------------------------------------------------

let mockConfig: {
    enabled?: boolean;
    defaultMode?: string;
    showStatus?: boolean;
} = {};

mock.module('./config', () => ({
    loadPonytailConfig: mock(() => mockConfig),
}));

// @earendil-works/pi-coding-agent is consumed only for types at compile time
// and for the optional `pi` helpers the upstream factory may call. Provide a
// bare stub so dynamic runtimeresolution never crashes.
mock.module('@earendil-works/pi-coding-agent', () => ({
    ExtensionAPI: class {},
}));

const {
    default: ponytail,
    detectPonytailMode,
    resolvePonytailDefaultMode,
    setFactoryForTests,
    resetPonytailCacheForTests,
} = await import('./ponytail.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi() {
    const pi = {
        registerCommand: mock(() => {}),
        on: mock(() => {}),
        appendEntry: mock(() => {}),
        sendUserMessage: mock(() => {}),
    } as unknown as ExtensionAPI & {
        on: ReturnType<typeof mock>;
        registerCommand: ReturnType<typeof mock>;
    };
    return pi;
}

beforeEach(() => {
    mockConfig = {};
    setFactoryForTests(null);
    resetPonytailCacheForTests();
});

// ---------------------------------------------------------------------------
// Kill-switch — saveTokens.ponytail.enabled
// ---------------------------------------------------------------------------

describe('ponytail wrapper — kill-switch', () => {
    it('does NOT call the upstream factory when enabled === false', () => {
        mockConfig = { enabled: false };
        const factory = mock(() => {});
        setFactoryForTests(factory as never);

        const pi = makePi();
        ponytail(pi);

        expect(factory).toHaveBeenCalledTimes(0);
    });

    it('calls the upstream factory once when enabled is unset (default = enabled)', () => {
        mockConfig = {}; // no enabled key
        const factory = mock(() => {});
        setFactoryForTests(factory as never);

        const pi = makePi();
        ponytail(pi);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(pi);
    });

    it('calls the upstream factory once when enabled === true', () => {
        mockConfig = { enabled: true };
        const factory = mock(() => {});
        setFactoryForTests(factory as never);

        const pi = makePi();
        ponytail(pi);

        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('passes saveTokens.ponytail.defaultMode to the upstream extension', () => {
        const previousMode = process.env.PONYTAIL_DEFAULT_MODE;
        try {
            delete process.env.PONYTAIL_DEFAULT_MODE;
            mockConfig = { enabled: true, defaultMode: 'ultra' };
            const factory = mock(() => {
                expect(process.env.PONYTAIL_DEFAULT_MODE).toBe('ultra');
            });
            setFactoryForTests(factory as never);

            ponytail(makePi());

            expect(factory).toHaveBeenCalledTimes(1);
        } finally {
            if (previousMode === undefined) delete process.env.PONYTAIL_DEFAULT_MODE;
            else process.env.PONYTAIL_DEFAULT_MODE = previousMode;
        }
    });

    it('keeps a valid PONYTAIL_DEFAULT_MODE shell override over profile and settings', () => {
        const previousMode = process.env.PONYTAIL_DEFAULT_MODE;
        const previousProfile =
            process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];
        try {
            process.env.PONYTAIL_DEFAULT_MODE = 'lite';
            process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] = 'ultra';
            mockConfig = { enabled: true, defaultMode: 'full' };
            const factory = mock(() => {
                expect(process.env.PONYTAIL_DEFAULT_MODE).toBe('lite');
            });
            setFactoryForTests(factory as never);

            ponytail(makePi());

            expect(factory).toHaveBeenCalledTimes(1);
        } finally {
            if (previousMode === undefined) delete process.env.PONYTAIL_DEFAULT_MODE;
            else process.env.PONYTAIL_DEFAULT_MODE = previousMode;
            if (previousProfile === undefined) {
                delete process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];
            } else {
                process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] =
                    previousProfile;
            }
        }
    });

    it('uses the child profile over saveTokens.ponytail.defaultMode', () => {
        const previousMode = process.env.PONYTAIL_DEFAULT_MODE;
        const previousProfile =
            process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];
        try {
            delete process.env.PONYTAIL_DEFAULT_MODE;
            process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] = 'ultra';
            mockConfig = { enabled: true, defaultMode: 'full' };
            const factory = mock(() => {
                expect(process.env.PONYTAIL_DEFAULT_MODE).toBe('ultra');
            });
            setFactoryForTests(factory as never);

            ponytail(makePi());

            expect(factory).toHaveBeenCalledTimes(1);
        } finally {
            if (previousMode === undefined) delete process.env.PONYTAIL_DEFAULT_MODE;
            else process.env.PONYTAIL_DEFAULT_MODE = previousMode;
            if (previousProfile === undefined) {
                delete process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];
            } else {
                process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] =
                    previousProfile;
            }
        }
    });

    it('ignores an invalid shell mode and falls back to the valid profile', () => {
        expect(
            resolvePonytailDefaultMode('full', {
                PONYTAIL_DEFAULT_MODE: 'invalid',
                [SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV]: 'ultra',
            }),
        ).toBe('ultra');
    });

    it('ignores an invalid shell mode and falls back to settings without a profile', () => {
        expect(
            resolvePonytailDefaultMode('full', {
                PONYTAIL_DEFAULT_MODE: 'invalid',
            }),
        ).toBe('full');
    });
});

// ---------------------------------------------------------------------------
// Missing upstream package — graceful no-op + warning
// ---------------------------------------------------------------------------

describe('ponytail wrapper — upstream missing', () => {
    it('registers a session_start warning when factory resolves to null', () => {
        // Don't inject a factory — __setFactoryForTests(null) was called in
        // beforeEach, simulating an unloadable upstream.
        const pi = makePi();
        ponytail(pi);

        // Must register at least one event handler (session_start) to warn.
        expect(
            (pi as unknown as { on: ReturnType<typeof mock> }).on,
        ).toHaveBeenCalled();
    });

    it('does not throw when the kill-switch is off AND upstream is missing', () => {
        mockConfig = { enabled: false };
        const pi = makePi();
        expect(() => ponytail(pi)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Robustness — default export shape from upstream
// ---------------------------------------------------------------------------

describe('ponytail wrapper — upstream shape', () => {
    it('does not call a non-function default export (defensive)', () => {
        // Simulate upstream breaking shape: default export is an object, not a fn.
        setFactoryForTests({ notAFn: true } as never);
        const pi = makePi();
        expect(() => ponytail(pi)).not.toThrow();
        // No factory call — ponytail() falls through to the warning registration.
        expect(
            (pi as unknown as { registerCommand: ReturnType<typeof mock> })
                .registerCommand,
        ).toHaveBeenCalledTimes(0);
    });
});

// ---------------------------------------------------------------------------
// detectPonytailMode — telemetry helper: scan systemPrompt for marker
// ---------------------------------------------------------------------------

describe('detectPonytailMode', () => {
    it('extracts mode from canonical PONYTAIL MODE ACTIVE marker (em dash)', () => {
        const sp = 'Some text\nPONYTAIL MODE ACTIVE — level: full\nMore text\n';
        expect(detectPonytailMode(sp)).toBe('full');
    });

    it('extracts mode with hyphen dash', () => {
        const sp = 'PONYTAIL MODE ACTIVE - level: ultra\n';
        expect(detectPonytailMode(sp)).toBe('ultra');
    });

    it('returns lowercased mode regardless of case', () => {
        expect(detectPonytailMode('PONYTAIL MODE ACTIVE — level: LITE')).toBe('lite');
    });

    it('returns null when marker is absent', () => {
        expect(detectPonytailMode('No ponytail here')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(detectPonytailMode('')).toBeNull();
    });

    it('handles non-string input gracefully', () => {
        expect(detectPonytailMode(null as never)).toBeNull();
        expect(detectPonytailMode(undefined as never)).toBeNull();
    });
});
