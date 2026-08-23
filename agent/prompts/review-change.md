---
description: Inspect an implementation and run parallel plan and code reviews.
---

Review the implementation for: $ARGUMENTS

Invoke `subagent` through one `workflowScript`. Run a fresh `scout` node first to inspect the current diff, relevant files, data flow, and risks. Then run `code-reviewer`, passing the scout output and original requirements explicitly to the node. Return an object containing review outputs.

The review node is read-only. Require concrete file references, severity-rated findings, and a clear verdict.
