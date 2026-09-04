<!-- markdownlint-disable MD013 -->

# pi-extension-markdown-links

Rewrites local Markdown references from their containing file path. It never includes linked file contents.

## Behavior

For model-visible `.md`, `.markdown`, and `.mdx` sources with known provenance:

- existing authorized local destinations become canonical absolute paths;
- link labels, titles, query strings, and fragments stay intact;
- missing or unauthorized destinations stay unchanged and receive an inline diagnostic;
- external URLs, protocol-relative URLs, anchors, images, and code stay unchanged;
- target files are never read or injected.

Covered sources include Pi context files, file-backed default `SYSTEM.md` and `APPEND_SYSTEM.md`, prompt templates, loaded skill bodies, complete built-in `read` results, `context-send`, `load_skill`, `/load-skills`, and BOM-rescued skill fallback.

Prompt arguments are not rewritten relative to a prompt template. Partial `read` output starting after line 1 stays unchanged because its source offsets are incomplete. Arbitrary CLI system prompts and role-expanded content without exposed source paths are unsupported.

## Configuration

Add `markdownLinks.allowedRoots` to `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`:

```json
{
    "markdownLinks": {
        "allowedRoots": ["$cwd", "$agentDir", "$agentDir/..", "$sourceDir"]
    }
}
```

Supported tokens:

- `$cwd`: current project directory;
- `$agentDir`: Pi agent directory;
- `$agentDir/..`: parent of Pi agent directory;
- `$sourceDir`: directory containing current Markdown source;
- `$contextDirs`: backward alias for `$sourceDir`;
- `~` and `~/...`: home-relative paths.

Source directory is always authorized. Authorization uses canonical paths and blocks symlink escapes.

## Shared producer protocol

Local extensions that already know a Markdown source path call `requestMarkdownLinkTransform(pi.events, { sourcePath, content, cwd, sourceKind })` from `agent/extensions/_shared/markdown-links.ts` before sending content to model context. If extension is absent, helper returns original content.

## Status

Run `/markdown-links:status` to inspect processed source count, rewrite count, and bounded diagnostics. Status never prints target contents.

See [ADR-022](../../../docs/adr/ADR-022-source-aware-markdown-link-rewriting.md) for design and provenance boundaries.
