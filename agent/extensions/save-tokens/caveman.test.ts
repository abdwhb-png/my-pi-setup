import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Mock the pi skill-loader API before importing the module under test.
// mock.module() is NOT hoisted in bun:test — executes in order.
//
// The caveman extension calls `readFileSync(skill.filePath)` after resolving
// the skill via `loadSkillsFromDir`. To exercise the real read path, tests
// create a REAL temp file and point the mocked skill's `filePath` at it.
// ---------------------------------------------------------------------------

const MOCK_SKILL_BODY = `\
Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Rules

Drop: articles, filler, pleasantries. Fragments OK. Short synonyms.

## Intensity

| Level | What change |
|-------|------------|
| **full** | Drop articles, fragments OK |
| **wenyan-full** | Maximum classical terseness 文言文 |

ACTIVE EVERY RESPONSE. 文言文`;

let mockSkillsResult: { skills: Skill[]; diagnostics: never[] } = {
    skills: [],
    diagnostics: [],
};

// Top-level mock reference: keeps a stable handle so tests can assert call
// counts without recreating the import resolution chain via require().
const loadSkillsFromDirMock = mock(
    (_opts: { dir: string; source: string }) => mockSkillsResult,
);

mock.module('@earendil-works/pi-coding-agent', () => ({
    // Skill loader — returns whatever mockSkillsResult currently holds
    loadSkillsFromDir: loadSkillsFromDirMock,

    // Frontmatter stripper — drops a leading ---yaml--- block if present
    stripFrontmatter: mock((content: string) => {
        const m = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        return m ? m[1]! : content;
    }),

    // Path helper used by both loader and extension
    getAgentDir: mock(() => '/mock/agent'),

    // Settings helper re-exported from pi-tui bridge
    getSettingsListTheme: mock(() => ({})),

    // Session API (only method used by caveman.ts)
    appendEntry: mock(() => {}),

    // SettingsManager consumed by ./config.ts (transitive import)
    SettingsManager: class {
        static create() {
            return new this();
        }
        getGlobalSettings() {
            return {};
        }
        getProjectSettings() {
            return {};
        }
    },

    // Typebox schema helper
    Type: Object.assign(() => ({}), {
        Object: () => ({}),
        String: () => ({}),
        Optional: (_t: unknown) => ({}),
    }),
}));

const {
    loadCavemanSkillBody,
    buildCavemanPrompt,
    detectCavemanLevel,
    LEVELS,
    resetCavemanCacheForTests,
    resolveCavemanInitialLevel,
} = await import('./caveman.ts');

describe('Caveman subagent defaults', () => {
    it('uses the ultra profile for a fresh child session', () => {
        expect(
            resolveCavemanInitialLevel(
                null,
                'full',
                {
                    PI_SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL: 'ultra',
                },
            ),
        ).toBe('ultra');
    });

    it('falls back to the configured default when the profile is invalid', () => {
        expect(
            resolveCavemanInitialLevel(
                null,
                'full',
                {
                    PI_SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL: 'not-a-level',
                },
            ),
        ).toBe('full');
    });

    it('preserves a resumed session level over the child profile', () => {
        expect(
            resolveCavemanInitialLevel(
                'lite',
                'full',
                {
                    PI_SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL: 'ultra',
                },
            ),
        ).toBe('lite');
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Per-test temp dir: each `makeSkill("caveman", body)` writes a REAL file so
// `readFileSync(skill.filePath)` in the extension hits the actual FS, exactly
// like production. Cleaned up in afterEach.
let tmpRoot: string;

function makeSkill(name: string, body: string): Skill {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'SKILL.md');
    writeFileSync(filePath, body, 'utf8');
    return {
        name,
        description: 'test',
        filePath,
        baseDir: dir,
        sourceInfo: {} as Skill['sourceInfo'],
        disableModelInvocation: false,
    };
}

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'caveman-test-'));
    mockSkillsResult = { skills: [], diagnostics: [] };
    loadSkillsFromDirMock.mockClear();
    // Critical: the extension caches the resolved skill body for its lifetime.
    // Each test must start from a clean cache.
    resetCavemanCacheForTests();
});

afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// LEVELS — wenyan alignment with skill (wenyan-full, not bare wenyan)
// ---------------------------------------------------------------------------

describe('LEVELS alignment with skill', () => {
    it('uses wenyan-full instead of bare wenyan', () => {
        expect(LEVELS).toContain('wenyan-full');
        expect(LEVELS).not.toContain('wenyan');
    });

    it('keeps wenyan-lite and wenyan-ultra', () => {
        expect(LEVELS).toContain('wenyan-lite');
        expect(LEVELS).toContain('wenyan-ultra');
    });

    it('keeps the canonical intensity levels', () => {
        expect(LEVELS).toContain('off');
        expect(LEVELS).toContain('lite');
        expect(LEVELS).toContain('full');
        expect(LEVELS).toContain('ultra');
        expect(LEVELS).toContain('micro');
    });
});

// ---------------------------------------------------------------------------
// loadCavemanSkillBody — single source of truth: the installed skill
// ---------------------------------------------------------------------------

describe('loadCavemanSkillBody', () => {
    it('returns the stripped skill body when the caveman skill is installed', () => {
        mockSkillsResult = {
            skills: [
                makeSkill(
                    'caveman',
                    `---\nname: caveman\n---\n${MOCK_SKILL_BODY}`,
                ),
            ],
            diagnostics: [],
        };

        const body = loadCavemanSkillBody();
        expect(typeof body).toBe('string');
        expect(body).toContain('ACTIVE EVERY RESPONSE');
        expect(body).toContain('文言文');
        // Frontmatter must be stripped
        expect(body).not.toContain('name: caveman');
    });

    it('returns undefined when the caveman skill is not installed', () => {
        mockSkillsResult = {
            skills: [makeSkill('other-skill', 'body')],
            diagnostics: [],
        };

        expect(loadCavemanSkillBody()).toBeUndefined();
    });

    it('returns undefined when no skills at all are installed', () => {
        expect(loadCavemanSkillBody()).toBeUndefined();
    });

    it('caches the body across calls (does not re-resolve)', () => {
        mockSkillsResult = {
            skills: [makeSkill('caveman', MOCK_SKILL_BODY)],
            diagnostics: [],
        };
        resetCavemanCacheForTests();

        loadCavemanSkillBody();
        loadCavemanSkillBody();
        loadCavemanSkillBody();

        // Cache: the loader is called at most once.
        expect(loadSkillsFromDirMock.mock.calls.length).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// buildCavemanPrompt — orchestrator thin layer over skill body
// ---------------------------------------------------------------------------

describe('buildCavemanPrompt', () => {
    function withSkill(body: string, fn: () => void) {
        const prev = mockSkillsResult;
        mockSkillsResult = {
            skills: [makeSkill('caveman', `---\nname: caveman\n---\n${body}`)],
            diagnostics: [],
        };
        // The extension caches the resolved skill body for its lifetime;
        // each isolated `withSkill` block must force a fresh resolution.
        resetCavemanCacheForTests();
        try {
            fn();
        } finally {
            mockSkillsResult = prev;
        }
    }

    it('returns null for level=off (no injection)', () => {
        withSkill(MOCK_SKILL_BODY, () => {
            expect(buildCavemanPrompt('off')).toBeNull();
        });
    });

    it('returns null when skill body is missing (graceful fallback)', () => {
        // Skill not installed → no body → no injection, no crash
        expect(buildCavemanPrompt('full')).toBeNull();
    });

    it('injects the skill body for level=full', () => {
        withSkill(MOCK_SKILL_BODY, () => {
            const prompt = buildCavemanPrompt('full');
            expect(prompt).not.toBeNull();
            expect(prompt).toContain('ACTIVE EVERY RESPONSE');
            expect(prompt).toContain('文言文');
        });
    });

    it('prepends a short active-level marker so the model knows which intensity row to apply', () => {
        withSkill(MOCK_SKILL_BODY, () => {
            const prompt = buildCavemanPrompt('ultra')!;
            // Short runtime directive — must signal the current level
            expect(prompt.toLowerCase()).toContain('ultra');
            // And the skill body must follow
            expect(prompt).toContain('ACTIVE EVERY RESPONSE');
        });
    });

    it('supports wenyan-full level (new aligned name)', () => {
        withSkill(MOCK_SKILL_BODY, () => {
            const prompt = buildCavemanPrompt('wenyan-full');
            expect(prompt).not.toBeNull();
            expect(prompt!.toLowerCase()).toContain('wenyan-full');
        });
    });

    it('micro mode produces a prompt even when the skill lacks a micro spec', () => {
        // The skill does not document `micro` — extension keeps a minimal local
        // layer so this experimental level still works.
        withSkill(MOCK_SKILL_BODY, () => {
            const prompt = buildCavemanPrompt('micro');
            expect(prompt).not.toBeNull();
        });
    });

    it('falls back gracefully for an unknown level string (typed-safe)', () => {
        // Cast to bypass TS — simulate bad persisted session entry.
        // Should not throw; should return null or a generic prompt.
        withSkill(MOCK_SKILL_BODY, () => {
            const prompt = buildCavemanPrompt('wenyan' as never);
            // Bare "wenyan" is no longer a valid level — must not produce
            // a prompt that claims an unknown intensity row.
            // Either null or a prompt that does NOT mention "wenyan" alone.
            if (prompt !== null) {
                expect(prompt.toLowerCase()).not.toMatch(/\bwenyan\b(?!-)/);
            }
        });
    });
});

// ---------------------------------------------------------------------------
// detectCavemanLevel — telemetry helper: scan systemPrompt for marker
// ---------------------------------------------------------------------------

describe('detectCavemanLevel', () => {
    it('extracts level from canonical ACTIVE LEVEL marker', () => {
        const sp = 'Some preamble\nACTIVE LEVEL: full.\nRest of prompt\n';
        expect(detectCavemanLevel(sp)).toBe('full');
    });

    it('returns lowercased level regardless of marker case', () => {
        expect(detectCavemanLevel('ACTIVE LEVEL: Ultra.')).toBe('ultra');
        expect(detectCavemanLevel('active level: LITE.')).toBe('lite');
    });

    it('returns null when marker is absent', () => {
        expect(detectCavemanLevel('No caveman here')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(detectCavemanLevel('')).toBeNull();
    });

    it('handles malformed input gracefully (no crash)', () => {
        // Cast to bypass TS — simulate runtime non-string value
        expect(detectCavemanLevel(null as never)).toBeNull();
        expect(detectCavemanLevel(undefined as never)).toBeNull();
    });
});
