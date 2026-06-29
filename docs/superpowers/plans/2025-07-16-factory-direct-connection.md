# Factory AI Direct Connection Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Refactor the Factory AI provider from subprocess-based inference (droid binary) to dual-transport direct network connection: primary WebSocket relay (`wss://relay.factory.ai`) with HTTP+SSE fallback (`cloudcode-pa.googleapis.com`).

**Architecture:** `streamSimple` tries the official Factory relay first via `connectDaemon()` remote mode (no local binary). On connection failure, falls back to direct HTTP POST with Gemini-shaped request bodies to Google's cloudcode backend, parsing SSE. Auth now captures both the Factory API key (for relay) and Google OAuth tokens (for cloudcode fallback) during `/login factory-ai`.

**Tech Stack:** TypeScript, `@factory/droid-sdk` (existing), `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, Node.js `fetch` + SSE parsing.

**Related:** `docs/adr/ADR-001-factory-ai-direct-connection.md`, `pi-plans/factory-ai-provider-integration.md`

## Global Constraints

- Do NOT break existing `/login factory-ai` flow for users who already have it configured
- Do NOT remove the `@factory/droid-sdk` dependency — it's still used for model discovery and the primary relay path
- Model discovery (`fetchFactoryModels`) remains unchanged
- The `factory-credits` widget remains unchanged
- All existing files keep their current naming conventions and patterns
- New files follow existing conventions: TypeScript, no default exports except entry point

---

### Task 1: Extract Google OAuth constants and helpers

**Files:**
- Create: `agent/extensions/ai-providers/shared/google-oauth.ts`

**Interfaces:**
- Produces: `GOOGLE_OAUTH_CLIENT_ID: string`, `GOOGLE_OAUTH_CLIENT_SECRET: string`, `GOOGLE_OAUTH_SCOPES: string[]`, `GOOGLE_TOKEN_ENDPOINT: string`, `GOOGLE_AUTH_ENDPOINT: string`, `GOOGLE_USERINFO_ENDPOINT: string`, `CLOUDCODE_BASE_URL: string`, `CLOUDCODE_STREAM_PATH: string`, `CLOUDCODE_GENERATE_PATH: string`, `GoogleTokenResponse` (interface), `exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleTokenResponse>`, `refreshGoogleToken(refreshToken: string): Promise<GoogleTokenResponse>`, `fetchGoogleUserInfo(accessToken: string): Promise<string>`

- [ ] **Step 1: Write the file**

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: No errors related to `google-oauth.ts`

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/ai-providers/shared/google-oauth.ts
git commit -m "feat: add Google OAuth constants and helpers for cloudcode fallback"
```

---

### Task 2: Create Gemini format translator

**Files:**
- Create: `agent/extensions/ai-providers/shared/gemini-translator.ts`

**Interfaces:**
- Consumes: `GOOGLE_OAUTH_SCOPES` module (for nothing — independent)
- Produces: `buildGeminiRequest(modelId: string, context: Context, options?: SimpleStreamOptions): object`, `parseGeminiSseLine(line: string, stream: AssistantMessageEventStream, output: AssistantMessage, model: Model<Api>): void`

- [ ] **Step 1: Write the Gemini request builder**

```typescript
/**
 * Gemini ↔ Pi format translator for the Factory AI cloudcode fallback.
 *
 * Converts Pi's internal message format to Gemini's generateContent request
 * shape, and parses SSE stream chunks back into Pi's AssistantMessageEvent
 * stream events.
 *
 * Request format (Gemini generateContent):
 *   { model, request: { messages: [{ role, parts: [{ text }] }], generationConfig: {...}, tools?: [...] } }
 *
 * Response format (SSE, alt=sse):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}],...}\n\n
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
} from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// ── Request building ──

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { name: string; content: string } };
}

interface GeminiContent {
  role: "user" | "model" | "tool";
  parts: GeminiPart[];
}

interface GeminiRequest {
  model: string;
  request: {
    messages: GeminiContent[];
    generationConfig: {
      temperature?: number;
      maxOutputTokens?: number;
      topP?: number;
      thinkingConfig?: { thinkingBudget?: number };
    };
    tools?: Array<{
      functionDeclarations: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
    }>;
    systemInstruction?: { parts: { text: string }[] };
  };
}

function buildGeminiRequest(
  modelId: string,
  context: Context,
  options?: SimpleStreamOptions,
): GeminiRequest {
  const contents: GeminiContent[] = [];

  // System prompt as systemInstruction
  const request: GeminiRequest["request"] = {
    messages: contents,
    generationConfig: {},
  };

  if (context.systemPrompt) {
    request.systemInstruction = {
      parts: [{ text: context.systemPrompt }],
    };
  }

  // Map Pi messages to Gemini contents
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          parts.push({ text: msg.content });
        }
      } else {
        for (const block of msg.content) {
          if (block.type === "text" && block.text.trim()) {
            parts.push({ text: block.text });
          } else if (block.type === "image") {
            parts.push({
              inlineData: { mimeType: block.mimeType, data: block.data },
            });
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          parts.push({ text: block.text });
        } else if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments as Record<string, unknown>,
            },
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "toolResult") {
      contents.push({
        role: "tool",
        parts: [
          {
            functionResponse: {
              name: msg.toolCallId,
              response: {
                name: msg.toolCallId,
                content:
                  typeof msg.content === "string"
                    ? msg.content
                    : msg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
              },
            },
          },
        ],
      });
    }
  }

  // Generation config
  if (options?.maxTokens) {
    request.generationConfig.maxOutputTokens = options.maxTokens;
  } else {
    request.generationConfig.maxOutputTokens = 65536;
  }

  if (options?.reasoning) {
    const budgets: Record<string, number> = {
      minimal: 1024,
      low: 4096,
      medium: 10240,
      high: 20480,
      xhigh: 32768,
    };
    const budget = budgets[options.reasoning.toLowerCase()] ?? 10240;
    request.generationConfig.thinkingConfig = { thinkingBudget: budget };
  }

  // Tools
  if (context.tools && context.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: context.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: (tool.parameters as Record<string, unknown>) || {},
        })),
      },
    ];
  }

  return { model: modelId, request };
}
```

- [ ] **Step 2: Write the SSE parser**

```typescript
// ── SSE parsing ──

/**
 * Parse a single SSE `data:` line into Pi stream events.
 * Pushes text_delta, text_start, text_end, thinking_delta, etc. events
 * into the provided stream.
 */
function parseGeminiSseLine(
  line: string,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
): void {
  // SSE format: "data: <json>"
  const dataMatch = line.match(/^data:\s*(.*)/);
  if (!dataMatch) return;

  const jsonStr = dataMatch[1].trim();
  if (!jsonStr || jsonStr === "[DONE]") return;

  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(jsonStr);
  } catch {
    return; // skip malformed JSON
  }

  const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) return;

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  if (!content) return;

  const parts = content.parts as Array<Record<string, unknown>> | undefined;
  if (!parts) return;

  for (const part of parts) {
    if (part.text !== undefined) {
      const text = String(part.text);
      // Find or create text block
      let idx = output.content.findIndex((c) => c.type === "text");
      if (idx === -1) {
        idx = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: idx, partial: output });
      }
      const block = output.content[idx];
      if (block.type === "text") {
        block.text += text;
        stream.push({
          type: "text_delta",
          contentIndex: idx,
          delta: text,
          partial: output,
        });
      }
    }

    if (part.thought !== undefined) {
      const thought = String(part.thought);
      let idx = output.content.findIndex((c) => c.type === "thinking");
      if (idx === -1) {
        idx = output.content.length;
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
      }
      const block = output.content[idx];
      if (block.type === "thinking") {
        block.thinking += thought;
        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: thought,
          partial: output,
        });
      }
    }

    if (part.functionCall) {
      const fc = part.functionCall as Record<string, unknown>;
      output.content.push({
        type: "toolCall",
        id: crypto.randomUUID(),
        name: String(fc.name),
        arguments: (fc.args as Record<string, unknown>) || {},
      });
    }
  }

  // Usage info
  if (chunk.usageMetadata) {
    const um = chunk.usageMetadata as Record<string, unknown>;
    output.usage.input = Number(um.promptTokenCount) || 0;
    output.usage.output = Number(um.candidatesTokenCount) || 0;
    output.usage.cacheRead = Number(um.cachedContentTokenCount) || 0;
    output.usage.totalTokens =
      (Number(um.totalTokenCount) || 0) ||
      output.usage.input + output.usage.output + output.usage.cacheRead;
    calculateCost(model, output.usage);
  }

  // Finish reason
  if (candidate.finishReason) {
    const reason = String(candidate.finishReason);
    if (reason === "STOP") output.stopReason = "stop";
    else if (reason === "MAX_TOKENS") output.stopReason = "length";
    else if (reason === "TOOL_CALLS") output.stopReason = "toolUse";
  }
}

export { buildGeminiRequest, parseGeminiSseLine };
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add agent/extensions/ai-providers/shared/gemini-translator.ts
git commit -m "feat: add Gemini format translator for cloudcode SSE fallback"
```

---

### Task 3: Refactor OAuth to capture dual credentials

**Files:**
- Modify: `agent/extensions/ai-providers/shared/oauth.ts`

**Interfaces:**
- Consumes: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_SCOPES`, `GOOGLE_AUTH_ENDPOINT`, `exchangeGoogleCode`, `fetchGoogleUserInfo`, `refreshGoogleToken`, `GoogleTokenResponse` from `google-oauth.ts`
- Produces: `createApiKeyOAuth()` (unchanged signature), new `createFactoryOAuth()` exported function, new `FactoryOAuthCredentials` interface, new `getGoogleAccessToken(credentials): string`, new `refreshGoogleAccessToken(credentials): Promise<OAuthCredentials>`

- [ ] **Step 1: Add the Factory-specific OAuth factory**

Add to bottom of `shared/oauth.ts`:

```typescript
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_SCOPES,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  refreshGoogleToken,
} from "./google-oauth.ts";
import type { GoogleTokenResponse } from "./google-oauth.ts";

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
): Promise<OAuthCredentials> {
  if (!isFactoryCredentials(credentials) || !credentials.googleRefreshToken) {
    return credentials;
  }
  const tokenResp = await refreshGoogleToken(credentials.googleRefreshToken);
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
      const state = await generateState();
      const redirectUri = `http://localhost:${callbackPort}/oauth-callback`;

      const authParams = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
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

      const tokenResp = await exchangeGoogleCode(code, redirectUri);
      const email = await fetchGoogleUserInfo(tokenResp.access_token);

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
    ): Promise<OAuthCredentials> {
      // Refresh Google token if present
      if (isFactoryCredentials(credentials) && credentials.googleRefreshToken) {
        return refreshGoogleAccessToken(credentials);
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
```

- [ ] **Step 2: Verify existing callers still compile**

The existing `createApiKeyOAuth` function is unchanged. The new `createFactoryOAuth` is additive.

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: no errors (note: factory-ai.ts will have errors until Task 5)

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/ai-providers/shared/oauth.ts
git commit -m "feat: add createFactoryOAuth with dual Google + API key token capture"
```

---

### Task 4: Refactor SDK bridge for dual transport

**Files:**
- Modify: `agent/extensions/ai-providers/shared/sdk-bridge.ts`

**Interfaces:**
- Consumes: `buildGeminiRequest`, `parseGeminiSseLine` from `gemini-translator.ts`; `CLOUDCODE_BASE_URL`, `CLOUDCODE_STREAM_PATH` from `google-oauth.ts`
- Produces: `streamFactory()` (signature unchanged), new `streamViaRelay()`, new `streamViaCloudCode()`, updated `FactoryStreamConfig` with `googleAccessToken`

- [ ] **Step 1: Update FactoryStreamConfig and add cloudcode streaming**

Add at top of `sdk-bridge.ts`, after existing imports:

```typescript
import { buildGeminiRequest, parseGeminiSseLine } from "./gemini-translator.ts";
import { CLOUDCODE_BASE_URL, CLOUDCODE_STREAM_PATH } from "./google-oauth.ts";
```

Update `FactoryStreamConfig`:

```typescript
export interface FactoryStreamConfig {
  apiKey: string;
  /** Google OAuth access token for cloudcode-pa fallback */
  googleAccessToken?: string;
  cwd?: string;
}
```

- [ ] **Step 2: Add cloudcode streaming function**

Add `streamViaCloudCode()` to `sdk-bridge.ts`, after the existing `handleStreamEvent` function:

```typescript
/**
 * Fallback: stream via direct HTTP POST to cloudcode-pa.googleapis.com.
 *
 * Uses Gemini-shaped request bodies and parses SSE responses.
 * No droid binary or WebSocket needed — just fetch() + SSE parsing.
 */
async function streamViaCloudCode(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  googleAccessToken: string,
): Promise<void> {
  const url = `${CLOUDCODE_BASE_URL}${CLOUDCODE_STREAM_PATH}?alt=sse`;
  const request = buildGeminiRequest(model.id, context, options);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${googleAccessToken}`,
      "User-Agent": "pi-factory-ai/1.0",
    },
    body: JSON.stringify(request),
    signal: options?.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Cloudcode stream request failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }

  if (!response.body) {
    throw new Error("Cloudcode stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE events (delimited by \n\n)
      const lines = buffer.split("\n");
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        parseGeminiSseLine(line, stream, output, model);
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      parseGeminiSseLine(buffer, stream, output, model);
    }

    // Finalize text/thinking blocks
    for (let i = 0; i < output.content.length; i++) {
      const block = output.content[i];
      if (block.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: i,
          content: block.text,
          partial: output,
        });
      } else if (block.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: i,
          content: block.thinking,
          partial: output,
        });
      }
    }

    calculateCost(model, output.usage);
    stream.push({
      type: "done",
      reason: output.stopReason as "stop" | "length" | "toolUse",
      message: output,
    });
    stream.end();
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 3: Refactor streamFactory to try relay first, fall back to cloudcode**

Replace the body of `streamFactory()` (the async IIFE inside it) with dual-transport logic:

```typescript
export function streamFactory(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: FactoryStreamConfig,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: "factory-ai",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    // ── Primary: relay.factory.ai via SDK remote connection ──
    try {
      const { connectDaemon } = await import("@factory/droid-sdk");

      const daemon = await connectDaemon({
        apiKey: config.apiKey,
        // Use remote relay — no local binary needed
        url: "wss://relay.factory.ai",
      });

      const session = await daemon.createSession({
        modelId: model.id,
        cwd: config.cwd ?? process.cwd(),
      });

      stream.push({ type: "start", partial: output });

      try {
        const prompt = buildPrompt(context);
        for await (const event of session.stream(prompt, {
          includePartialMessages: true,
        })) {
          if (options?.signal?.aborted) {
            throw new Error("Request was aborted");
          }
          const shouldContinue = handleStreamEvent(
            event,
            stream,
            output,
            model,
          );
          if (!shouldContinue) return;
        }

        // Stream ended normally without result event
        if (output.stopReason === "stop" && output.errorMessage === undefined) {
          calculateCost(model, output.usage);
          stream.push({
            type: "done",
            reason: "stop",
            message: output,
          });
          stream.end();
        }
      } finally {
        await session.close().catch(() => {});
        await daemon.close().catch(() => {});
      }
      return;
    } catch (relayError) {
      // ── Fallback: cloudcode-pa.googleapis.com via HTTP+SSE ──
      const googleToken = config.googleAccessToken;
      if (!googleToken) {
        throw relayError; // No fallback available
      }

      console.warn(
        `Factory relay unreachable, falling back to cloudcode SSE: ${
          relayError instanceof Error ? relayError.message : String(relayError)
        }`,
      );

      try {
        stream.push({ type: "start", partial: output });
        await streamViaCloudCode(
          model,
          context,
          options,
          stream,
          output,
          googleToken,
        );
      } catch (cloudcodeError) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage =
          cloudcodeError instanceof Error
            ? cloudcodeError.message
            : String(cloudcodeError);
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
        stream.end();
      }
    }
  })();

  return stream;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: errors only in factory-ai.ts (wired in Task 5), no errors in sdk-bridge.ts itself

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/ai-providers/shared/sdk-bridge.ts
git commit -m "feat: dual-transport streamFactory — relay primary, cloudcode SSE fallback"
```

---

### Task 5: Update provider registration to use new OAuth and dual transport

**Files:**
- Modify: `agent/extensions/ai-providers/providers/factory-ai.ts`

**Interfaces:**
- Consumes: `createFactoryOAuth`, `getGoogleAccessToken`, `refreshGoogleAccessToken` from `oauth.ts`; `streamFactory`, `FactoryStreamConfig` from `sdk-bridge.ts`
- Produces: unchanged exports (`registerFactoryProvider`), updated internally

- [ ] **Step 1: Replace OAuth creation**

In `factory-ai.ts`, replace `createFactoryOAuth()`:

```typescript
import {
  createFactoryOAuth,
  getGoogleAccessToken,
  refreshGoogleAccessToken,
} from "../shared/oauth.ts";
import {
  streamFactory,
  type FactoryStreamConfig,
} from "../shared/sdk-bridge.ts";

// ── OAuth Config ──

function createFactoryOAuthConfig() {
  const base = createFactoryOAuth({
    name: PROVIDER_DISPLAY,
    apiKeyUrl: API_KEY_URL,
    validateKey: validateFactoryApiKey,
  });

  return {
    ...base,
    modifyModels(models: Model<Api>[]) {
      const liveModels = getCachedFactoryModels();
      if (liveModels.length === 0) return models;
      return [
        ...models.filter((m) => m.provider !== PROVIDER_NAME),
        ...toResolvedFactoryModels(PROVIDER_NAME, PROVIDER_BASE_URL, PROVIDER_API, liveModels),
      ];
    },
  };
}
```

- [ ] **Step 2: Update validateFactoryApiKey to accept optional googleToken**

```typescript
async function validateFactoryApiKey(
  apiKey: string,
  _googleToken?: string,
): Promise<string | null> {
  try {
    const models = await fetchFactoryModels(apiKey);
    if (models.length === 0) {
      return "Factory returned no available models for this API key.";
    }
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("authentication")
    ) {
      return "Invalid API key. Please check your key at " + API_KEY_URL;
    }
    if (
      msg.includes("ENOENT") ||
      msg.includes("command not found") ||
      msg.includes("droid")
    ) {
      return "Droid CLI not found. Install it first: npm install -g @factory/droid";
    }
    return `API key validation failed: ${msg}`;
  }
}
```

- [ ] **Step 3: Update streamFactorySimple to pass Google token**

```typescript
function streamFactorySimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const apiKey = options?.apiKey ?? "";

  // Try to extract Google access token from stored credentials
  // (credentials may be injected at runtime even though not in the TS type)
  let googleAccessToken: string | undefined;
  try {
    const rawOpts = options as Record<string, unknown> | undefined;
    const cred = rawOpts?.credentials;
    if (cred) {
      googleAccessToken = getGoogleAccessToken(
        cred as import("@earendil-works/pi-ai").OAuthCredentials,
      );
    }
  } catch {
    // credentials not in options — OK, relay-only mode
  }

  const streamConfig: FactoryStreamConfig = {
    apiKey,
    cwd: process.cwd(),
    googleAccessToken,
  };

  return streamFactory(model, context, options, streamConfig);
}
```

- [ ] **Step 4: Update buildProviderConfig to use new OAuth**

```typescript
function buildProviderConfig() {
  return {
    baseUrl: PROVIDER_BASE_URL,
    api: PROVIDER_API,
    models: toProviderModels(),
    oauth: createFactoryOAuthConfig(),
    streamSimple: streamFactorySimple,
  };
}
```

- [ ] **Step 5: Update session_start to refresh Google token**

```typescript
pi.on("session_start", async (_event, ctx) => {
  try {
    const cred = ctx.modelRegistry.authStorage.get(AUTH_STORAGE_KEY);
    if (cred && cred.type === "oauth") {
      // Refresh Google token if available
      let updatedCred = cred;
      try {
        const refreshed = await refreshGoogleAccessToken(
          cred as import("@earendil-works/pi-ai").OAuthCredentials,
        );
        if (refreshed !== cred) {
          updatedCred = { ...cred, ...refreshed };
        }
      } catch {
        // Refresh failed — use existing creds
      }

      await fetchFactoryModels(updatedCred.access, ctx.cwd);
      ctx.modelRegistry.registerProvider(PROVIDER_NAME, buildProviderConfig());
    }
  } catch {
    // If model refresh fails, keep whatever model list we already have cached.
  }
});
```

- [ ] **Step 6: Remove unused import**

Remove `createApiKeyOAuth` from imports (no longer used in this file):

```typescript
// Remove: import { createApiKeyOAuth } from "../shared/oauth.ts";
```

- [ ] **Step 7: Remove unused import**

The `streamFactory` import from `sdk-bridge.ts` is already there. Remove the old `FactoryStreamConfig` type import if it was separate.

- [ ] **Step 8: Verify full TypeScript compilation**

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 9: Commit**

```bash
git add agent/extensions/ai-providers/providers/factory-ai.ts
git commit -m "feat: wire dual-transport streamSimple and Google OAuth to Factory provider"
```

---

### Task 6: End-to-end verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Verify the project builds cleanly**

Run: `cd agent/extensions/ai-providers && npx tsc --noEmit`
Expected: Zero TypeScript errors

- [ ] **Step 2: Verify import graph is intact**

Run: `cd agent/extensions/ai-providers && node -e "require('./dist/index.js')" 2>&1 || echo "No dist yet — compile first"`
Expected: If dist exists, no import errors. Otherwise, verify with `npx tsc --noEmit`.

- [ ] **Step 3: Self-review checklist**

- [ ] `shared/google-oauth.ts` exports all constants and helpers used by other files
- [ ] `shared/gemini-translator.ts` exports `buildGeminiRequest` and `parseGeminiSseLine`
- [ ] `shared/oauth.ts` exports both `createApiKeyOAuth` (unchanged) and new `createFactoryOAuth`, `getGoogleAccessToken`, `refreshGoogleAccessToken`
- [ ] `shared/sdk-bridge.ts` exports `streamFactory` with unchanged signature, `handleStreamEvent` unchanged
- [ ] `providers/factory-ai.ts` no longer imports `createApiKeyOAuth`, uses `createFactoryOAuth` instead
- [ ] `providers/factory-models.ts` completely unchanged
- [ ] `widgets/factory-credits.ts` completely unchanged
- [ ] No dead code: removed imports from `factory-ai.ts` that are no longer used
- [ ] All existing comments and JSDoc preserved on unchanged functions

- [ ] **Step 4: Final commit (if any review fixes needed)**

```bash
git add -A
git commit -m "chore: final review fixes for dual-transport refactor"
```
