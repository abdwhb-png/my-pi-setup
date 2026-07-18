import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Mocks — kept minimal so we exercise the real ponytail.ts wrapper logic.
//
// - ./config: stub loadPonytailConfig to control the enabled flag per test.
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
