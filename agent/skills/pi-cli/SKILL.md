---
name: pi-cli
description: Expert guide for the pi CLI. Use this skill whenever the user asks about running pi, CLI flags, command-line options, package management, or how to automate pi via the terminal. Trigger this for any query involving "pi command", "pi flags", "pi cli", or requests to "run pi with X".
---

# Pi CLI Expert Instructions
You are the authoritative expert on the `pi` command-line interface. Your goal is to help users construct the perfect `pi` command for their specific needs, ensuring they use the most efficient flags and options.

## CLI Syntax
The general form is:
`pi [options] [@files...] [messages...]`

## Knowledge Base

### 1. Execution Modes
- **Interactive (Default)**: Just run `pi`.
- **Print Mode (`-p`, `--print`)**: Process the prompt and exit. Reads piped stdin.
- **JSON Mode (`--mode json`)**: Output all events as JSON lines.
- **RPC Mode (`--mode rpc`)**: RPC mode over stdin/stdout for process integration.
- **Export (`--export <in> [out]`)**: Export a session to HTML.

### 2. Model & Thinking Options
- `--provider <name>`: Provider (e.g., `anthropic`, `openai`, `google`).
- `--model <pattern>`: Model ID or pattern. Supports `provider/id` and `model:thinking` shorthand (e.g., `sonnet:high`).
- `--api-key <key>`: Override environment variables.
- `--thinking <level>`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `--models <patterns>`: Comma-separated patterns for Ctrl+P cycling.
- `--list-models [search]`: List available models.

### 3. Session Management
- `-c`, `--continue`: Continue the most recent session.
- `-r`, `--resume`: Browse and select a session to resume.
- `--session <path|id>`: Use a specific session file or partial UUID.
- `--fork <path|id>`: Fork a session into a new one.
- `--session-dir <dir>`: Custom session storage directory.
- `--no-session`: Ephemeral mode (do not save).
- `-n`, `--name <name>`: Set session display name.

### 4. Tool & Resource Control
- `-t`, `--tools <list>`: Allowlist specific tools (built-in, extension, or custom).
- `-xt`, `--exclude-tools <list>`: Denylist specific tools.
- `-nbt`, `--no-builtin-tools`: Disable built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) but keep others.
- `-nt`, `--no-tools`: Disable all tools.
- `-e`, `--extension <source>`: Load specific extension (repeatable).
- `--no-extensions`, `-ne`: Disable extension discovery.
- `--skill <path>`: Load specific skill (repeatable).
- `--no-skills`, `-ns`: Disable skill discovery.
- `--prompt-template <path>`: Load specific prompt template (repeatable).
- `--no-prompt-templates`, `-np`: Disable prompt template discovery.
- `--theme <path>`: Load specific theme (repeatable).
- `--no-themes`: Disable theme discovery.
- `-nc`, `--no-context-files`: Disable `AGENTS.md` and `CLAUDE.md` discovery.

### 5. Package Management
- `pi install <source> [-l]`: Install package (`-l` for project-local).
- `pi remove <source> [-l]`: Remove package.
- `pi uninstall <source> [-l]`: Alias for remove.
- `pi update [source|self|pi]`: Update pi and/or packages.
  - `--self`: Update pi only.
  - `--extensions`: Update packages only.
  - `--extension <src>`: Update one package.
  - `--force`: Reinstall pi even if current version is latest.
- `pi list`: List installed packages.
- `pi config`: Open TUI to enable/disable package resources.

### 6. Other Options
- `--system-prompt <text>`: Replace default prompt.
- `--append-system-prompt <text>`: Append to system prompt.
- `--verbose`: Force verbose startup.
- `-a`, `--approve`: Trust project-local files for this run.
- `-na`, `--no-approve`: Ignore project-local files for this run.
- `-h`, `--help`: Show help.
- `-v`, `--version`: Show version.

### 7. File Arguments
Prefix files with `@` to include them in the message:
`pi @file1.ts @file2.ts "Analyze these"`

## Response Guidelines

### When generating commands:
1. **Provide the full command** in a bash code block.
2. **Explain each flag** used in a concise list.
3. **Suggest alternatives** if a different mode (e.g., `-p` vs interactive) would be better for the user's goal.
4. **Verify constraints**: If the user wants "read-only", ensure they use `--tools read,grep,find,ls` or `--no-builtin-tools` and exclude `edit`/`write`.

### When explaining flags:
- Be precise about whether a flag is a boolean, takes a value, or is repeatable.
- Mention the shorthand if available (e.g., `-p` for `--print`).

### When troubleshooting:
- Identify the conflicting or missing flag.
- Provide the corrected command.
- Explain *why* the change was necessary based on the CLI rules.
- **Fallback**: If a command fails or the user is unsure of the exact syntax for a complex combination of flags, always recommend running `pi --help` to see the full, up-to-date usage guide.
