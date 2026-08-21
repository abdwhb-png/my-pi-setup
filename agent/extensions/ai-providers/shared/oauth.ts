/**
 * Shared OAuth helpers for ai-providers.
 *
 * Provides a simple API-key-based "OAuth" flow where the user enters
 * their API key via the Pi UI. This is not true OAuth but uses Pi's
 * OAuth infrastructure so the key is securely stored and can be used
 * transparently by the provider.
 */

import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import {
	GOOGLE_AUTH_ENDPOINT,
	GOOGLE_OAUTH_SCOPES,
	exchangeGoogleCode,
	fetchGoogleUserInfo,
	getGoogleOAuthCredentials,
	refreshGoogleToken,
} from "./google-oauth.ts";

export interface ApiKeyAuthConfig {
	/** Provider name shown in login UI (e.g., "Factory AI") */
	name: string;
	/** URL where the user can generate an API key */
	apiKeyUrl: string;
	/** Function to validate the API key. Returns error message if invalid. */
	validateKey: (apiKey: string) => Promise<string | null>;
}

/**
 * Create an OAuth config object for API-key-based providers.
 *
 * The "login" flow prompts the user for their API key via ctx.ui.input,
 * validates it, and stores it as OAuth credentials with a fake refresh
 * token (the key itself).
 */
export function createApiKeyOAuth(config: ApiKeyAuthConfig) {
	return {
		name: config.name,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const apiKey = await callbacks.onPrompt({
				message: `Enter your ${config.name} API key\n(Generate one at ${config.apiKeyUrl}):`,
			});

			if (!apiKey || !apiKey.trim()) {
				throw new Error("API key is required");
			}

			const error = await config.validateKey(apiKey.trim());
			if (error) {
				throw new Error(error);
			}

			// Store the key as both access and refresh since there's no token refresh flow
			return {
				access: apiKey.trim(),
				refresh: apiKey.trim(),
				expires: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
			};
		},

		async refreshToken(
			credentials: OAuthCredentials,
			signal: AbortSignal,
		): Promise<OAuthCredentials> {
			// For API keys, refresh is a no-op — just return the existing credentials
			signal.throwIfAborted();
			return credentials;
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

// ── Factory AI Dual-Credential OAuth ──

/**
 * Extended credentials that include both the Factory API key
 * and the raw Google OAuth tokens for the cloudcode fallback.
 */
export interface FactoryOAuthCredentials extends OAuthCredentials {
	/** Google OAuth access token for cloudcode-pa.googleapis.com */
	googleAccessToken: string;
	/** Google OAuth refresh token */
	googleRefreshToken: string;
	/** Expiry timestamp (ms) of the Google access token */
	googleExpires: number;
}

function isFactoryCredentials(
	cred: OAuthCredentials,
): cred is FactoryOAuthCredentials {
	return "googleAccessToken" in cred;
}

/**
 * Get the Google access token from stored credentials.
 * Returns empty string if credentials don't include a Google token.
 */
export function getGoogleAccessToken(credentials: OAuthCredentials): string {
	if (isFactoryCredentials(credentials)) {
		return credentials.googleAccessToken;
	}
	return "";
}

/**
 * Refresh the Google access token using the stored refresh token.
 * Returns updated credentials with a fresh Google access token.
 */
export async function refreshGoogleAccessToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!isFactoryCredentials(credentials) || !credentials.googleRefreshToken) {
		return credentials;
	}
	const tokenResp = await refreshGoogleToken(
		credentials.googleRefreshToken,
		signal,
	);
	return {
		...credentials,
		googleAccessToken: tokenResp.access_token,
		googleExpires: Date.now() + tokenResp.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Create a Factory-specific OAuth config that captures both the
 * Factory API key and Google OAuth tokens during login.
 *
 * Flow:
 * 1. Browser-based Google OAuth (get Google access + refresh tokens)
 * 2. Prompt user for Factory API key
 * 3. Validate both, store combined credentials
 */
export function createFactoryOAuth(config: {
	name: string;
	apiKeyUrl: string;
	validateKey: (apiKey: string, googleToken: string) => Promise<string | null>;
	callbackPort?: number;
}) {
	const callbackPort = config.callbackPort ?? 51121;

	// Generate PKCE-like state for CSRF protection
	async function generateState(): Promise<string> {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	return {
		name: config.name,

		async login(
			callbacks: import("@earendil-works/pi-ai").OAuthLoginCallbacks,
		): Promise<OAuthCredentials> {
			// Phase 1: Google OAuth browser flow
			const { clientId } = getGoogleOAuthCredentials();
			const state = await generateState();
			const redirectUri = `http://localhost:${callbackPort}/oauth-callback`;

			const authParams = new URLSearchParams({
				client_id: clientId,
				response_type: "code",
				redirect_uri: redirectUri,
				scope: GOOGLE_OAUTH_SCOPES.join(" "),
				state,
				access_type: "offline",
				prompt: "consent",
			});

			const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${authParams.toString()}`;
			callbacks.onAuth({ url: authUrl });

			const authCode = await callbacks.onPrompt({
				message:
					"Paste the authorization code from the browser (or the full callback URL):",
			});

			// Parse code from callback URL or raw input
			let code = authCode.trim();
			try {
				const url = new URL(code);
				code = url.searchParams.get("code") ?? code;
			} catch {
				// Not a URL, treat as raw code
			}

			if (!code) {
				throw new Error("No authorization code received");
			}

			const tokenResp = await exchangeGoogleCode(
				code,
				redirectUri,
				callbacks.signal,
			);
			const email = await fetchGoogleUserInfo(
				tokenResp.access_token,
				callbacks.signal,
			);

			// Phase 2: Get Factory API key
			const apiKey = await callbacks.onPrompt({
				message: `Google login successful (${email}).\nEnter your Factory AI API key\n(Generate one at ${config.apiKeyUrl}):`,
			});

			if (!apiKey || !apiKey.trim()) {
				throw new Error("API key is required");
			}

			const error = await config.validateKey(apiKey.trim(), tokenResp.access_token);
			if (error) {
				throw new Error(error);
			}

			return {
				access: apiKey.trim(),
				refresh: tokenResp.refresh_token,
				expires:
					Date.now() + tokenResp.expires_in * 1000 - 5 * 60 * 1000,
				googleAccessToken: tokenResp.access_token,
				googleRefreshToken: tokenResp.refresh_token,
				googleExpires:
					Date.now() + tokenResp.expires_in * 1000 - 5 * 60 * 1000,
			} as FactoryOAuthCredentials;
		},

		async refreshToken(
			credentials: OAuthCredentials,
			signal: AbortSignal,
		): Promise<OAuthCredentials> {
			signal.throwIfAborted();
			// Refresh Google token if present
			if (isFactoryCredentials(credentials) && credentials.googleRefreshToken) {
				return refreshGoogleAccessToken(credentials, signal);
			}
			// For API-key-only creds, no-op
			return credentials;
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		getGoogleToken(credentials: OAuthCredentials): string {
			return getGoogleAccessToken(credentials);
		},
	};
}
