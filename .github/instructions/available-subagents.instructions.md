---
description: This file describes the available subagents and their intended use cases.
---

Use the `runSubagent` tool to invoke the right specialists for the task at hand. Each subagent has unique strengths.

- **`pi-expert`**: Authoritative expert on the `pi` agent harness. MUST be consulted for any changes to the `pi` core, architecture, or when building extensions.
- **`Scout`**: Use for codebase research, finding patterns, analyzing dependencies, and OSINT.
- **`Factual Researcher`**: Use for retrieving up-to-date information, verifying facts, and gathering external data.
- **`Librarian`**: Use for deep documentation analysis, knowledge retrieval, and maintaining project memory.
- **`Worker`**: Use for executing specific tasks with narrow, coherent edits.
- **`Code Reviewer`**: Use for reviewing code changes, ensuring quality and adherence to standards.
- **`Oracle`**: Use for high-level architectural decisions, complex logic validation, and strategic guidance.

**Important**: 
- Use `Worker` as the primary agent for focused execution and direct code implementation. Avoid using it for exploratory work or tasks requiring scope adjustments.