---
description: Inspect an implementation and run code review.
---

Review the implementation. $ARGUMENTS

Inspect the current diff, relevant files, data flow, and risks using a fresh `scout` node first.

Ask the user if specialized reviewers (`style-reviewer`, `api-reviewer`, `security-reviewer`) should be launched alongside the default `code-reviewer`.

Invoke `subagent` through one `workflowScript`. Run `code-reviewer` by default (plus any selected specialized reviewers in parallel via `runs.all`), passing the scout output and original requirements explicitly. Return an object containing the review outputs.

The review nodes are read-only. Require concrete file references, severity-rated findings, and a clear verdict.
