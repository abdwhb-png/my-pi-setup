## Plan: Refactor yeet extension — no push by default

**What:** Update `extensions/yeet.ts` to remove the push step from the default prompt. Pushing only happens when the user explicitly requests it via the optional argument.

**Why:** The user wants push to be opt-in, not automatic, to avoid accidental pushes or pushing without review.

**How:** Rewrite the `YEET_PROMPT` to only cover `git add -A` → commit. The existing arg-passing mechanism stays the same: any user-provided args are appended as "Additional instructions from the user" for the agent to interpret.

---

### Steps

1. Edit `extensions/yeet.ts` — replace the `YEET_PROMPT` constant:
   - Remove "push" from the title/description
   - Replace the 3-step process with 2 steps (add + commit only)
   - Keep the existing arg-appending logic untouched
   - Update the `description` field of `registerCommand` to reflect no-push default

2. Verify the file parses cleanly with `npx tsc --noEmit extensions/yeet.ts` (or just read it once more).

---

### Relevant files

- `extensions/yeet.ts` — the only file to change

### Verification

1. Read the file and confirm the prompt no longer mentions pushing
2. Confirm the arg-appending logic still works (no structural changes to the handler)

### Decisions

- **Append-as-instructions model kept**: Args are appended verbatim as "Additional instructions from the user". No subcommand parsing.
- **No push by default**: The prompt only covers add + commit. If the user wants push, they pass `push` as the argument, e.g. `/yeet push` or `/yeet push --force`.