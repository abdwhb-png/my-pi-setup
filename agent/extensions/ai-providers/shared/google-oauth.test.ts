import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('@earendil-works/pi-coding-agent', () => ({
    getAgentDir: () => '/test/pi/agent',
}));

const googleOauth = await import('./google-oauth.ts');

const originalFetch = globalThis.fetch;
const originalClientId = process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID;
const originalClientSecret = process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET;
const temporaryDirectories: string[] = [];

afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) {
        delete process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID;
    } else {
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
        delete process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET;
    } else {
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET =
            originalClientSecret;
    }
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('google-oauth import guard', () => {
    it('exports at least one symbol', () => {
        expect(Object.keys(googleOauth).length).toBeGreaterThan(0);
    });
});

describe('exchangeGoogleCode', () => {
    it('uses OAuth credentials from the environment at request time', async () => {
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET =
            'test-client-secret';
        let usedConfiguredCredentials = false;

        globalThis.fetch = (async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
            >;
            usedConfiguredCredentials =
                body.client_id === 'test-client-id' &&
                body.client_secret === 'test-client-secret';
            return new Response(
                JSON.stringify({
                    access_token: 'access',
                    refresh_token: 'refresh',
                    expires_in: 3600,
                    token_type: 'Bearer',
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            );
        }) as typeof fetch;

        await googleOauth.exchangeGoogleCode(
            'authorization-code',
            'http://localhost/callback',
        );

        expect(usedConfiguredCredentials).toBe(true);
    });

    it('rejects a successful HTTP response with an invalid token payload', async () => {
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET =
            'test-client-secret';
        globalThis.fetch = (async (_input, _init) =>
            new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })) as typeof fetch;

        await expect(
            googleOauth.exchangeGoogleCode(
                'authorization-code',
                'http://localhost/callback',
            ),
        ).rejects.toThrow('Google token exchange returned invalid response');
    });
});

describe('getGoogleOAuthCredentials', () => {
    it('falls back to the ignored agent secrets file', async () => {
        delete process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID;
        delete process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET;
        const agentDir = await mkdtemp(join(tmpdir(), 'pi-oauth-secrets-'));
        temporaryDirectories.push(agentDir);
        await writeFile(
            join(agentDir, 'ai-providers.secrets.json'),
            JSON.stringify({
                googleOAuth: {
                    clientId: 'file-client-id',
                    clientSecret: 'file-client-secret',
                },
            }),
        );

        let credentials:
            | ReturnType<typeof googleOauth.getGoogleOAuthCredentials>
            | undefined;
        try {
            credentials = googleOauth.getGoogleOAuthCredentials({ agentDir });
        } catch {
            credentials = undefined;
        }

        expect(credentials).toEqual({
            clientId: 'file-client-id',
            clientSecret: 'file-client-secret',
        });
    });
});

describe('fetchGoogleUserInfo', () => {
    it('rejects a non-object response with the domain error', async () => {
        globalThis.fetch = (async (_input, _init) =>
            new Response('null', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })) as typeof fetch;

        await expect(
            googleOauth.fetchGoogleUserInfo('access-token'),
        ).rejects.toThrow('Google userinfo returned no email');
    });
});
