import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Google OAuth constants and helpers for Factory AI cloudcode fallback.
 *
 * Credentials are resolved lazily from environment variables or the ignored
 * agent/ai-providers.secrets.json file so they never enter Git history.
 */

const GOOGLE_OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_USERINFO_ENDPOINT =
	"https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

const CLOUDCODE_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CLOUDCODE_STREAM_PATH = "/v1internal:streamGenerateContent";
const CLOUDCODE_GENERATE_PATH = "/v1internal:generateContent";

interface GoogleTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

function getGoogleOAuthCredentials(options: { agentDir?: string } = {}): {
	clientId: string;
	clientSecret: string;
} {
	const clientId = process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID?.trim();
	const clientSecret =
		process.env.PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
	if (clientId && clientSecret) return { clientId, clientSecret };

	const secretsPath = join(
		options.agentDir ?? getAgentDir(),
		"ai-providers.secrets.json",
	);
	let fileCredentials: unknown;
	try {
		const parsed = JSON.parse(readFileSync(secretsPath, "utf8")) as {
			googleOAuth?: unknown;
		};
		fileCredentials = parsed.googleOAuth;
	} catch {
		throw new Error(
			"Factory Google OAuth credentials are not configured. Set PI_FACTORY_GOOGLE_OAUTH_CLIENT_ID and PI_FACTORY_GOOGLE_OAUTH_CLIENT_SECRET, or create ai-providers.secrets.json in the Pi agent directory",
		);
	}

	if (!fileCredentials || typeof fileCredentials !== "object") {
		throw new Error(
			"Invalid googleOAuth credentials in ai-providers.secrets.json",
		);
	}
	const value = fileCredentials as Record<string, unknown>;
	const fileClientId =
		typeof value.clientId === "string" ? value.clientId.trim() : "";
	const fileClientSecret =
		typeof value.clientSecret === "string" ? value.clientSecret.trim() : "";
	if (!fileClientId || !fileClientSecret) {
		throw new Error(
			"Invalid googleOAuth credentials in ai-providers.secrets.json",
		);
	}
	return { clientId: fileClientId, clientSecret: fileClientSecret };
}

async function exchangeGoogleCode(
	code: string,
	redirectUri: string,
): Promise<GoogleTokenResponse> {
	const { clientId, clientSecret } = getGoogleOAuthCredentials();
	const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Google token exchange failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json();
}

async function refreshGoogleToken(
	refreshToken: string,
): Promise<GoogleTokenResponse> {
	const { clientId, clientSecret } = getGoogleOAuthCredentials();
	const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Google token refresh failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json();
}

async function fetchGoogleUserInfo(accessToken: string): Promise<string> {
	const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		throw new Error(
			`Google userinfo failed: ${response.status} ${await response.text()}`,
		);
	}

	const data = await response.json();
	if (!data.email) throw new Error("Google userinfo returned no email");
	return data.email;
}

export {
	getGoogleOAuthCredentials,
	GOOGLE_OAUTH_SCOPES,
	GOOGLE_TOKEN_ENDPOINT,
	GOOGLE_AUTH_ENDPOINT,
	GOOGLE_USERINFO_ENDPOINT,
	CLOUDCODE_BASE_URL,
	CLOUDCODE_STREAM_PATH,
	CLOUDCODE_GENERATE_PATH,
	exchangeGoogleCode,
	refreshGoogleToken,
	fetchGoogleUserInfo,
};
export type { GoogleTokenResponse };
