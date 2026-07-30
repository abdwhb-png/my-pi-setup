---
description: Debug an issue empirically (full diagnose loop)
argument-hint: '<issue-description>'
role: debug
---

Debug the issue below following the `debug` role discipline and the `diagnose` skill.

**Process is mandatory — do not skip:**

1. **Check memories first** (`memory_search`, `pi_session_search`) for gotchas about this issue or the codebase area.
2. **Load the `diagnose` skill** and follow its 6 phases in order.
3. **Build a feedback loop before hypothesising.** No loop = no diagnosis. If you cannot build one, say so explicitly and list what you tried — do not fall back to static code reading and present hypotheses as conclusions.
4. **Reproduce** the exact user-reported symptom before forming hypotheses.
5. **Form 3-5 ranked falsifiable hypotheses** and show them before testing.

**Debug actions are not implementations.** Reproducing, reading logs, inspecting runtime state, and adding temporary instrumentation are expected — do them freely. Only the final **fix** is gated by user request: do not implement it unless explicitly asked.

**Output must include:**

- **Investigation trace** — what you reproduced, what commands/probes you ran, what the evidence showed.
- **Root cause** — the verified explanation, or an explicit "could not verify — here is what I tried and what I need from you."
- **Recommendation** — proposed fix (not applied).

ISSUE: $ARGUMENTS
