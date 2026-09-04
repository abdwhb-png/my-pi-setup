# ADR-022: Rewrite local Markdown links from known source paths

## Status

Accepted

## Date

2026-09-04

## Context

Pi presents Markdown from several sources to the model: project context files, `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates, skills, and tool results. Relative links only have meaning when resolved from the file that contained them.

The original `markdown-links` extension recursively read linked Markdown files and injected their contents into the system prompt. That changed ordinary references into implicit includes, increased context use, widened the prompt-injection surface, and still missed prompt templates and skill bodies because their source provenance was lost after Pi expanded them.

Scanning every Markdown file in a repository would not restore provenance. It would introduce unrelated files without proving which source produced a model-visible string.

## Decision

Treat Markdown links as references, not includes.

When model-visible Markdown has a known source path, parse it and rewrite each existing authorized local destination to its canonical absolute path. Preserve labels, titles, query strings, and fragments. Do not read or inject target contents.

Process `.md`, `.markdown`, and `.mdx` sources. Rewrite local destinations regardless of target file type. Leave external schemes, protocol-relative destinations, anchors, images, inline code, and fenced code unchanged.

If a local target is missing or outside `allowedRoots`, keep its original destination, append a short inline HTML diagnostic, and record the diagnostic for `/markdown-links:status`. Canonicalize existing paths and the nearest existing parent before authorization so symlink escapes remain blocked. The source file directory is always authorized. Configuration keeps only `allowedRoots`; `$sourceDir` is the source-directory token and `$contextDirs` remains a backward alias.

Use source-aware ingress points only:

- rewrite context-file blocks, and file-backed default `SYSTEM.md` and `APPEND_SYSTEM.md`, during `before_agent_start`;
- capture prompt-template source through Pi's authoritative `getCommands()` metadata at `input`, then rewrite only static link slices from that template when the expanded user message reaches `message_end`;
- rewrite the body of `<skill location="...">` messages at `message_end`;
- rewrite complete built-in `read` results for Markdown source files;
- expose a synchronous, versioned event-bus request for local extensions that already know `{ sourcePath, content }`, including `context-send`, `load_skill`, `/load-skills`, and BOM-rescued skill fallback.

Partial `read` output starting after line 1 remains unchanged because MDAST offsets cannot be correlated safely without preceding source. Prompt argument links remain unchanged because they did not come from the prompt template.

Use `SlashCommandInfo.sourceInfo.path` from `pi.getCommands()` as the single source of truth for slash-command provenance. Extensions must not duplicate Pi's prompt directory and settings discovery.

Do not rewrite arbitrary inline CLI system prompts or role-expanded content when Pi does not expose a reliable source path. Adding provenance to those paths requires an owning-package or Pi API change and is outside this decision.

## Alternatives Considered

### Recursively inject linked Markdown

Rejected. It turns references into includes, consumes context, reads target bodies unnecessarily, and expands the prompt-injection surface.

### Scan every Markdown file in the repository

Rejected. Repository membership does not identify the source of model-visible content and would process unrelated files.

### Rewrite all user-authored links after prompt expansion

Rejected. Prompt arguments have no prompt-file provenance and must remain relative to the user's own context rather than the template directory.

### Patch Pi core or pi-roles immediately

Rejected for this change. Current source-aware Pi hooks and a shared extension protocol cover owned ingress points without widening package scope. Unsupported provenance paths remain explicit.

## Consequences

The model sees resolvable absolute references without paying for target bodies unless it chooses to read them. Existing Markdown semantics remain visible. Missing and unauthorized targets stay inspectable rather than disappearing behind a silent fallback.

Coverage depends on source provenance. New local producers that read Markdown must call the shared transform request before sending content. Producers without a source path cannot be transformed safely.

Prompt correlation intentionally applies only to static source-template slices. If user-supplied text exactly duplicates an earlier static slice, ordering can still make provenance ambiguous; runtime coverage protects the normal expansion path, while exact structural provenance would require Pi core support.

This ADR supersedes the recursive inclusion, `scope`, `maxDepth`, `maxBytes`, and linked-content injection decisions in [the original Markdown link design](../brainstorming/2026-07-17-markdown-link-context-design.md).
