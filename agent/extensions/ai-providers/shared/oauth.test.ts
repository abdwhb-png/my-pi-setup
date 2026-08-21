import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai';

mock.module('@earendil-works/pi-coding-agent', () => ({
    getAgentDir: () => '/test/pi/agent',
}));

const { createFactoryOAuth } = await import('./oauth.ts');

const originalClientId = process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID;
const originalClientSecret = process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET;
const originalFetch = globalThis.fetch;

afterEach(() => {
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
});

describe('createFactoryOAuth', () => {
	it('propagates Pi 0.84 refresh cancellation to Google', async () => {
		process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
		process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
		let receivedSignal: AbortSignal | undefined;
		globalThis.fetch = mock(async (_input, init) => {
			receivedSignal = init?.signal ?? undefined;
			return new Response(
				JSON.stringify({
					access_token: 'new-google-token',
					expires_in: 3600,
					token_type: 'Bearer',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}) as unknown as typeof fetch;
		const controller = new AbortController();
		const oauth = createFactoryOAuth({
			name: 'Factory AI',
			apiKeyUrl: 'https://example.com/api-keys',
			validateKey: async () => null,
		});

		await oauth.refreshToken(
			{
				access: 'factory-key',
				refresh: 'google-refresh',
				expires: 0,
				googleAccessToken: 'old-google-token',
				googleRefreshToken: 'google-refresh',
				googleExpires: 0,
			},
			controller.signal,
		);

		expect(receivedSignal).toBe(controller.signal);
	});

    it('uses the configured Google OAuth client ID in the authorization URL', async () => {
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
        process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET =
            'test-client-secret';
        let usedConfiguredClientId = false;
        const stopAfterAuthorization = new Error(
            'stop after authorization URL',
        );
        const callbacks: OAuthLoginCallbacks = {
            onAuth: ({ url }) => {
                usedConfiguredClientId =
                    new URL(url).searchParams.get('client_id') ===
                    'test-client-id';
            },
            onDeviceCode: () => {},
            onPrompt: async () => {
                throw stopAfterAuthorization;
            },
            onSelect: async () => undefined,
        };
        const oauth = createFactoryOAuth({
            name: 'Factory AI',
            apiKeyUrl: 'https://example.com/api-keys',
            validateKey: async () => null,
        });

        await expect(oauth.login(callbacks)).rejects.toBe(
            stopAfterAuthorization,
        );
        expect(usedConfiguredClientId).toBe(true);
    });
});
