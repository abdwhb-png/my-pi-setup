# brainstorm-forcer

Pi extension that **starts and enforces** a brainstorming workflow programmatically.

## What changed in redesign

Old behavior:
- `/brainstorm <topic>` only armed state
- user had to send a second message manually
- tool allowlists were hardcoded and blocked real environment tools like `hypa_find`
- workflow was mostly a deny-list

New behavior:
- `/brainstorm <topic>` **starts immediately** by sending topic into agent loop
- `/brainstorm arm <topic>` arms only
- tool policy is built from **actual runtime tool inventory** via `pi.getAllTools()`
- discovery allows research wrappers like `hypa_find`, `hypa_ls`, etc.
- only **mutation tools** (`write`, `edit`) are blocked before documenting
- phase advancement is evidence-based

## Commands

- `/brainstorm <topic>` — start immediately
- `/brainstorm start <topic>` — explicit start
- `/brainstorm arm <topic>` — arm only, no LLM turn
- `/brainstorm status` — show phase + evidence counters
- `/brainstorm next` — advance if completion criteria met
- `/brainstorm force-next` — bypass criteria manually
- `/brainstorm phase <name|number>` — jump to phase
- `/brainstorm stop` — clear workflow state

## Phases

1. **Discovery** — research tools + `ask_user_question`; mutation blocked
2. **Understanding** — research tools + `ask_user_question`; mutation blocked
3. **Exploring** — research tools + `ask_user_question`; mutation blocked
4. **Presenting** — research tools + `ask_user_question`; mutation blocked
5. **Documenting** — all tools allowed

## Enforcement

### Runtime tool grouping
Tool groups are derived dynamically from `pi.getAllTools()`:
- **research**: `read`, `grep`, `find`, `ls`, `bash`, `hypa_read`, `hypa_grep`, `hypa_find`, `hypa_ls`, etc.
- **questioning**: `ask_user_question`
- **mutation**: `write`, `edit`

### Evidence gates
- Discovery → requires at least one research tool call
- Understanding → requires at least one `ask_user_question`
- Exploring → requires at least one assistant turn in exploring phase
- Presenting → requires at least one approval/validation capture

## UX

- Footer status uses shared `ui-colors` helper
- Tool blocks notify user visibly
- Custom brainstorm messages render with a dedicated renderer

## Bundled skill

Bundled at:

```text
skills/brainstorm-forcer/SKILL.md
```

Registered through `resources_discover`, so no settings.json entry is required when the extension lives in:

```text
~/.pi/agent/extensions/brainstorm-forcer/
```

## Tests

```bash
cd ~/.pi/agent/extensions/brainstorm-forcer
bun test
```

Current status: **15 passing tests**.
