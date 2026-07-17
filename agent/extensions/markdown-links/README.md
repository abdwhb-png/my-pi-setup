<!-- markdownlint-disable MD013 -->

# pi-extension-markdown-links

Resolves local Markdown links from Pi context roots and injects linked Markdown into the system prompt.

## Install

Add this directory to Pi extensions or package settings. Runtime parser dependency is pinned to Sätteri `0.9.5`.

## Configuration

Add `markdownLinks` to `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`:

```json
{
    "markdownLinks": {
        "scope": "all",
        "maxDepth": 10,
        "maxBytes": 500000,
        "allowedRoots": ["$cwd", "$agentDir", "$agentDir/..", "$contextDirs"]
    }
}
```

`all` follows links from loaded context files plus file-backed `SYSTEM.md` and `APPEND_SYSTEM.md`. `context` limits roots to `AGENTS.md`/`CLAUDE.md` files. External URLs are ignored.

Use `/markdown-links:status` to inspect the latest scan.
