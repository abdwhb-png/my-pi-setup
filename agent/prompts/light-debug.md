---
description: Debug a simple issue with systematic-debugging (stays in current role)
argument-hint: '<issue-description>'
---

Debug the issue below using the `systematic-debugging` skill.

This is a **lightweight** pass for simple/trivial bugs (typos, null checks, missing config, obvious logic errors). For hard bugs, multi-component issues, or intermittent failures, use `/debug-issue` instead.

**Follow the skill's 4 phases in order:**

1. **Root cause investigation** — read errors carefully, reproduce consistently, check recent changes. Do not skip to fixes.
2. **Pattern analysis** — find working examples in the codebase, compare.
3. **Hypothesis and testing** — form a single hypothesis, test minimally, one variable at a time.
4. **Implementation** — only if the user explicitly asks for the fix.

**Iron Law:** no fixes without root cause investigation first. If you catch yourself thinking "it's probably X, let me fix that" — STOP, you skipped investigation.

Check memories (`memory_search`) for gotchas about the issue first.

Provide the root cause and recommendations. Only implement the fix if explicitly asked.

ISSUE: $ARGUMENTS
