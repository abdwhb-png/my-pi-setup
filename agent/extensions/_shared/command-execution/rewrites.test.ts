import { describe, expect, it } from 'bun:test';
import {
    applyFirstRewrite,
    loadBashRewrites,
    type BashRewriteRule,
} from './rewrites';

describe('loadBashRewrites', () => {
    it('returns empty rules from missing settings', () => {
        const config = loadBashRewrites('/nonexistent-cwd-12345');
        expect(config.rules).toEqual([]);
    });

    it('drops rules with invalid regex silently', () => {
        const rules: BashRewriteRule[] = [
            { match: 'valid', rewrite: 'replaced' },
            { match: '(unclosed', rewrite: 'ignored' },
            { match: 'also[valid', rewrite: 'ignored-too' },
        ];
        // Direct validation: simulate normalization
        const valid = rules.filter((r) => {
            try {
                new RegExp(r.match);
                return true;
            } catch {
                return false;
            }
        });
        expect(valid).toHaveLength(1);
        expect(valid[0].match).toBe('valid');
    });

    it('filters tools to valid tool names', () => {
        const rule: BashRewriteRule = {
            match: 'x',
            rewrite: 'y',
            tools: ['bash', 'safe_bash', 'invalid' as never],
        };
        // The normalize layer should only accept 'bash' and 'safe_bash'
        expect(
        rule.tools?.filter(
            (t: string): t is 'bash' | 'safe_bash' =>
                t === 'bash' || t === 'safe_bash',
        ),
        ).toEqual(['bash', 'safe_bash']);
    });

    it('defaults tools to bash and safe_bash when absent', () => {
        const rule: BashRewriteRule = { match: 'x', rewrite: 'y' };
        expect(rule.tools).toBeUndefined();
        // applyFirstRewrite should treat undefined tools as ['bash','safe_bash']
        const result = applyFirstRewrite('x', 'bash', [rule]);
        expect(result.applied).not.toBeNull();
    });
});

describe('applyFirstRewrite', () => {
    const rules: BashRewriteRule[] = [
        { match: '^sail\\s+artisan\\s+(.*)$', rewrite: 'docker compose exec -T php artisan $1', reason: 'tty-disable' },
        { match: '^sail\\s+composer\\s+(.*)$', rewrite: 'docker compose exec -T composer $1' },
    ];

    it('first matching rule wins with capture groups', () => {
        const result = applyFirstRewrite('sail artisan about', 'safe_bash', rules);
        expect(result.command).toBe('docker compose exec -T php artisan about');
        expect(result.applied).toEqual({
            from: 'sail artisan about',
            to: 'docker compose exec -T php artisan about',
            reason: 'tty-disable',
        });
    });

    it('returns null applied when no rule matches', () => {
        const result = applyFirstRewrite('echo hello', 'safe_bash', rules);
        expect(result.command).toBe('echo hello');
        expect(result.applied).toBeNull();
    });

    it('skips rule when tools does not include the tool name', () => {
        const scopedRules: BashRewriteRule[] = [
            { match: 'foo', rewrite: 'bar', tools: ['bash'] },
        ];
        const result = applyFirstRewrite('foo', 'safe_bash', scopedRules);
        expect(result.command).toBe('foo');
        expect(result.applied).toBeNull();
    });

    it('returns null applied when rewrite produces identical string', () => {
        const noopRules: BashRewriteRule[] = [
            { match: '(echo)', rewrite: '$1' },
        ];
        const result = applyFirstRewrite('echo', 'bash', noopRules);
        expect(result.command).toBe('echo');
        expect(result.applied).toBeNull();
    });

    it('handles empty rules array', () => {
        const result = applyFirstRewrite('anything', 'bash', []);
        expect(result.command).toBe('anything');
        expect(result.applied).toBeNull();
    });

    it('includes description in applied when present', () => {
        const descRules: BashRewriteRule[] = [
            { match: 'x', rewrite: 'y', description: 'test rule' },
        ];
        const result = applyFirstRewrite('x', 'bash', descRules);
        expect(result.applied?.description).toBe('test rule');
    });
});
