import { describe, expect, test } from 'bun:test';
import {
    profileSeverity,
    taskStateGlyph,
    verdictColor,
} from './review-render.ts';
import { renderRunObservation } from './extension-tools.ts';

// Minimal fake Theme: fg wraps the (color, text) pair in recognizable brackets
// so tests can assert which ThemeColor was selected without real ANSI escapes.
function fakeTheme() {
    const calls: string[] = [];
    const theme = {
        fg(color: string, text: string) {
            calls.push(`${color}:${text}`);
            return `[${color}|${text}]`;
        },
        calls,
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionContext['ui']['theme'] & {
        calls: string[];
    };
    return theme;
}

describe('review-render helpers', () => {
    describe('profileSeverity', () => {
        test('maps each profile to its severity color', () => {
            const theme = fakeTheme();
            expect(profileSeverity(theme, 'critical')).toBe('[error|critical]');
            expect(profileSeverity(theme, 'standard')).toBe('[warning|standard]');
            expect(profileSeverity(theme, 'light')).toBe('[muted|light]');
            expect(profileSeverity(theme, 'direct')).toBe('[dim|direct]');
        });

        test('returns plain label when theme is undefined (print/json mode)', () => {
            expect(profileSeverity(undefined, 'critical')).toBe('critical');
            expect(profileSeverity(undefined, 'standard')).toBe('standard');
        });
    });

    describe('taskStateGlyph', () => {
        test('maps each task state to glyph + color', () => {
            const theme = fakeTheme();
            expect(taskStateGlyph(theme, 'pending')).toBe('[muted|◦]');
            expect(taskStateGlyph(theme, 'implementing')).toBe('[accent|●]');
            expect(taskStateGlyph(theme, 'reviewing')).toBe('[accent|●]');
            expect(taskStateGlyph(theme, 'fixing')).toBe('[accent|●]');
            expect(taskStateGlyph(theme, 'verified')).toBe('[success|✓]');
            expect(taskStateGlyph(theme, 'needs_input')).toBe('[warning|■]');
            expect(taskStateGlyph(theme, 'failed')).toBe('[error|✗]');
            expect(taskStateGlyph(theme, 'cancelled')).toBe('[error|✗]');
            expect(taskStateGlyph(theme, 'awaiting_direct_agent')).toBe(
                '[muted|◦]',
            );
        });

        test('returns plain glyph when theme is undefined', () => {
            expect(taskStateGlyph(undefined, 'pending')).toBe('◦');
            expect(taskStateGlyph(undefined, 'verified')).toBe('✓');
            expect(taskStateGlyph(undefined, 'failed')).toBe('✗');
        });
    });

    describe('verdictColor', () => {
        test('maps each review verdict to its color', () => {
            const theme = fakeTheme();
            expect(verdictColor(theme, 'pass', 'pass')).toBe('[success|pass]');
            expect(verdictColor(theme, 'changes_required', 'changes')).toBe(
                '[warning|changes]',
            );
            expect(verdictColor(theme, 'blocked', 'blocked')).toBe(
                '[error|blocked]',
            );
        });

        test('returns plain text when theme is undefined', () => {
            expect(verdictColor(undefined, 'pass', 'pass')).toBe('pass');
        });
    });
});

describe('renderRunObservation theming', () => {
    function fakeTheme() {
        return {
            fg: (color: string, text: string) => `[${color}|${text}]`,
            bold: (t: string) => t,
        } as unknown as import('@earendil-works/pi-coding-agent').ExtensionContext['ui']['theme'];
    }

    function observation(): any {
        return {
            snapshot: {
                runId: 'run-1',
                state: 'running',
                tasks: {
                    'task-1': { state: 'verified', launches: 2, maxLaunches: 4 },
                    'task-2': { state: 'failed', launches: 1, maxLaunches: 3, terminalReason: 'budget_exhausted' },
                },
            },
            qualitativeEstimate: 'moderate',
            estimateDrift: 'on_track',
            selectedProfiles: [
                { taskId: 'task-1', profile: 'standard' },
                { taskId: 'task-2', profile: 'critical' },
            ],
            activeRequests: [],
            reviewerVerdicts: [
                { taskId: 'task-1', stage: 'combined', verdict: 'pass', findings: [], evidence: ['e1'] },
            ],
            acceptanceEvidence: [],
            blockedDecision: undefined,
            blockedOutput: undefined,
            manifest: undefined,
            observedAt: 'now',
            elapsedMs: 0,
        };
    }

    test('applies theme tokens in TUI mode', () => {
        const out = renderRunObservation(observation(), fakeTheme());
        expect(out).toContain('[accent|●]');
        expect(out).toContain('[warning|standard]');
        expect(out).toContain('[error|critical]');
        expect(out).toContain('[success|✓]');
        expect(out).toContain('[error|✗]');
        expect(out).toContain('[success|pass]');
    });

    test('emits plain text with no ANSI when theme is undefined (print/json)', () => {
        const out = renderRunObservation(observation(), undefined);
        // No theme color tokens (bracketed [color|...]), but profile labels like [standard] are fine.
        expect(out).not.toMatch(/\[(accent|error|warning|success|muted|dim)\|/);
        expect(out).toContain('● run-1: running');
        expect(out).toContain('task-1: verified [standard]');
        expect(out).toContain('task-1/combined: pass');
        expect(out).toContain('task-2: failed [critical]');
    });
});
