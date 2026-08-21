---
description: Inspect an implementation and run parallel plan and code reviews.
---

Review the implementation for: $ARGUMENTS

Invoke `subagent` through one `workflowScript`. Run a fresh `scout` node first to inspect the current diff, relevant files, data flow, and risks. Then use `runs.all` to run `plan-reviewer` and `code-reviewer` in parallel, passing the scout output and original requirements explicitly to both nodes. Return an object containing both review outputs.

The review nodes are read-only. Require concrete file references, severity-rated findings, and a clear verdict. Do not use legacy top-level `chain`, `tasks`, or `parallel` payloads; `runs.all` inside `workflowScript` is the supported parallel boundary.
