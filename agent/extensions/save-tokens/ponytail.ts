/**
 * ponytail — lazy senior dev mode for AI agents.
 *
 * Wraps `@dietrichgebert/ponytail` pi extension and gates it behind a
 * `saveTokens.ponytail.enabled` kill-switch in settings.json.
 *
 * Why a wrapper instead of `pi install`:
 *  - pi-installed packages register their own manifest and would
 *    double-register commands / event handlers when we also import them here.
 *  - keep save-tokens as the single orchestrator: caveman (terse prose),
 *    local-tool-result-compressor (tool output shrinking), ponytail (code
 *    minimalism).
 *
 * Sub-path import quirk: the upstream `package.json` does NOT expose
 * `./pi-extension` in its `exports` map (only `.` and `./plugin`). Bun
 * respects `exports` strictly, so a direct `import ... from "@dietrichgebert/ponytail/pi-extension"`
 * fails. We resolve the absolute path via `require.resolve` on the
 * always-resolvable `package.json`, then `createRequire` to load the
 * CommonJS-friendly JS file as a normal module. This is the only robust
 * pattern that survives across bun/node without patch-package.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadPonytailConfig } from './config';
import { SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV } from './subagent-profile.ts';

type PonytailFactory = (pi: ExtensionAPI) => void;

let cachedFactory: PonytailFactory | null | undefined = null;

const PONYTAIL_DEFAULT_MODE_ENV = 'PONYTAIL_DEFAULT_MODE';
const PONYTAIL_DEFAULT_MODES = new Set([
    'off',
    'lite',
    'full',
    'ultra',
    'review',
]);

function normalizePonytailDefaultMode(
    value: string | undefined,
): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized && PONYTAIL_DEFAULT_MODES.has(normalized)
        ? normalized
        : undefined;
}

/**
 * Resolve a Ponytail default without overriding its documented shell escape
 * hatch. The private profile variable is set only in pi-subagents children.
 */
export function resolvePonytailDefaultMode(
    configuredDefaultMode: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    return (
        normalizePonytailDefaultMode(env[PONYTAIL_DEFAULT_MODE_ENV]) ??
        normalizePonytailDefaultMode(
            env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV],
        ) ??
        normalizePonytailDefaultMode(configuredDefaultMode)
    );
}

function applyPonytailDefaultMode(
    configuredDefaultMode: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (normalizePonytailDefaultMode(env[PONYTAIL_DEFAULT_MODE_ENV])) return;

    const resolved = resolvePonytailDefaultMode(configuredDefaultMode, env);
    if (resolved) env[PONYTAIL_DEFAULT_MODE_ENV] = resolved;
}

/**
 * Resolve the upstream `ponytailExtension` factory once per process.
 * Returns null if the package or its default export is missing/unexpected,
 * so callers can no-op gracefully.
 */
function loadPonytailFactory(): PonytailFactory | null {
    if (cachedFactory !== null) return cachedFactory ?? null;

    const hostRequire = createRequire(import.meta.url);

    // Resolve the upstream package root. The subpath
    // `@dietrichgebert/ponytail/package.json` does NOT work under pi-runtime
    // because bun enforces `exports` strictly there (the upstream `exports`
    // map omits `./package.json`, and only bun-test loosens this). Instead
    // we resolve the package main entrypoint `.` (which IS in `exports`)
    // and walk up to the package root.
    //
    // Layout: <pkg-root>/.opencode/plugins/ponytail.mjs
    //         → <pkg-root>/pi-extension/index.js (what we load below)
    //
    // Walking up 3 levels gets us from ponytail.mjs back to <pkg-root>.
    let ponytailRoot: string;
    try {
        const mainPath = hostRequire.resolve('@dietrichgebert/ponytail');
        ponytailRoot = dirname(dirname(dirname(mainPath)));
    } catch {
        cachedFactory = null;
        return null;
    }

    try {
        // CommonJS-require the file directly; bun transpiles its top-level
        // `export default` into `module.exports.default` transparently.
        //
        // Package-boundary cost: the upstream ponytail package ships no TS
        // declarations, and its `default` is only known at runtime. We type
        // it via a structural PonytailFactory so the cast is verifiable.
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        const mod: { default?: PonytailFactory } = hostRequire(
            join(ponytailRoot, 'pi-extension', 'index.js'),
        );
        const factory = mod.default;
        if (typeof factory === 'function') {
            cachedFactory = factory;
            return cachedFactory;
        }
    } catch {
        // fall through
    }

    cachedFactory = null;
    return null;
}

/**
 * pi-extension entry: gated wrapper around upstream ponytailExtension.
 *
 * Reads `saveTokens.ponytail.enabled` once at startup. `undefined` defaults
 * to enabled (opt-out via explicit `false`). When enabled and the upstream
 * package is loadable, registers all ponytail commands + before_agent_start
 * injection via the upstream factory.
 */
export default function ponytail(pi: ExtensionAPI): void {
    const cfg = loadPonytailConfig();
    // Kill-switch: undefined = enabled.
    if (cfg.enabled === false) return;

    applyPonytailDefaultMode(cfg.defaultMode);

    const factory = loadPonytailFactory();
    // Defensive: the loader guarantees a function or null, but stale cache
    // or test-injection could violate the invariant — guard at runtime.
    if (typeof factory !== 'function') {
        pi.on('session_start', async (_event, ctx) => {
            ctx.ui.notify(
                'Ponytail: upstream package not loadable. Install @dietrichgebert/ponytail or set saveTokens.ponytail.enabled=false.',
                'warning',
            );
        });
        return;
    }

    factory(pi);
}

// Exported for tests so they can reset the cached factory between cases.
export function resetPonytailCacheForTests(): void {
    cachedFactory = null;
}

// Re-exported for tests that want to inject a stub without going through
// the real resolver.
export function setFactoryForTests(factory: PonytailFactory | null): void {
    cachedFactory = factory;
}

// ---------------------------------------------------------------------------
// Telemetry helper — detect Ponytail mode from system prompt marker
// ---------------------------------------------------------------------------

const PONYTAIL_MODE_RE = /PONYTAIL MODE ACTIVE\s*[—–-]\s*level:\s*(\S+)/i;

/**
 * Scan a system prompt string for the canonical Ponytail mode marker.
 *
 * The upstream Ponytail extension prepends `PONYTAIL MODE ACTIVE — level:
 * <mode>` to the system prompt when a non-off mode is active. This function
 * extracts that mode for telemetry snapshots.
 *
 * @returns The mode string (e.g. `"lite"`, `"full"`, `"ultra"`), or `null` if
 *          the marker is absent (mode off or Ponytail not injected).
 */
export function detectPonytailMode(systemPrompt: string): string | null {
    if (typeof systemPrompt !== 'string') return null;
    const match = systemPrompt.match(PONYTAIL_MODE_RE);
    return match ? match[1]!.toLowerCase() : null;
}
