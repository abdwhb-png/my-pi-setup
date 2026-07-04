# pi-session-recall

Recall past [pi](https://github.com/earendil-works/pi) sessions. Search through conversation history and query specific sessions with an LLM.

## What it does

Three tools that let the agent recall past sessions:

### `pi_session_search`

Literal text search across all past sessions using ripgrep-style fixed-string matching. It is not semantic search. The agent should search for one distinctive token or exact phrase at a time, such as a filename, package name, error string, function name, issue id, or remembered wording.

Spaces mean exact spaces in an exact phrase. For unrelated concepts, the agent should call `pi_session_search` multiple times instead of combining them into one query.

### `pi_session_query`

Deep-dives into a specific session file. Loads the conversation, sends it to an LLM, and answers your question about it.

For large sessions that exceed the model's context window, it uses smart windowing: keeps the first/last messages plus keyword-relevant sections, marking gaps with `[... N messages omitted ...]`.

### `pi_session_find`

Finds a session directly by session id (UUID suffix from the session filename) and returns the exact matching session path.

### `/pi-session-recall`

Command to configure which model is used for `pi_session_query`. Opens a picker with all your available models.

By default, queries use your **current session model**. If you want to save tokens, pick a cheaper model (e.g. Haiku, GPT-4o mini).

## Configuration

Config is stored at `~/.pi/agent/pi-session-recall.json`:

```json
{
  "queryModel": {
    "provider": "anthropic",
    "id": "claude-haiku-4-5"
  },
  "fallback-models": [
    { "provider": "openrouter", "id": "google/gemini-flash-lite" }
  ]
}
```

If no model is configured (or the configured model isn't available/authed), it tries `fallback-models` in order, then falls back to whatever model is active in your current session.

## Requirements

- [pi](https://github.com/earendil-works/pi) v0.40+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — recommended for fast search, falls back to `grep` or Node-native scan

## License

MIT