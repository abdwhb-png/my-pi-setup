/**
 * Google OAuth constants and helpers for Factory AI cloudcode fallback.
 *
 * Uses the same Google OAuth client as the official droid CLI and CLIProxyAPI.
 * The client ID and secret are public — they're distributed with every droid
 * binary and the CLIProxyAPI source.
 */

const GOOGLE_OAUTH_CLIENT_ID =
	"REDACTED_GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_OAUTH_CLIENT_SECRET = "REDACTED_GOOGLE_OAUTH_CLIENT_SECRET";

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

async function exchangeGoogleCode(
	code: string,
	redirectUri: string,
): Promise<GoogleTokenResponse> {
	const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
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
	const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
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
	GOOGLE_OAUTH_CLIENT_ID,
	GOOGLE_OAUTH_CLIENT_SECRET,
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
