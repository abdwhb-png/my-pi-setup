Use the `runSubagent` tool to invoke the right specialists for the task at hand. Each subagent has unique strengths.

- **`Ask`**: Use for clarifying requirements or answering specific technical questions.
- **`Codebase Scout`**: Use for finding files and code, returning actionable results.
- **`Explore`**: Use for codebase research, finding patterns, analyzing dependencies, and OSINT.
- **`Factual Researcher`**: Use for retrieving up-to-date information, verifying facts, and gathering external data.
- **`Implementation Worker`**: Use for executing specific, well-defined implementation tasks with narrow, coherent edits.
- **`Librarian`**: Use for deep documentation analysis, knowledge retrieval, and maintaining project memory.
- **`Oracle`**: Use for high-level architectural decisions, complex logic validation, and strategic guidance.
- **`Plan`**: Use to decompose high-level goals into detailed, actionable implementation plans.
- **`Debug`**: Use for diagnosing failures, analyzing logs, and fixing bugs.

**Important**: 
- Use `Implementation Worker` as the primary agent for focused execution and direct code implementation. Avoid using it for exploratory work or tasks requiring scope adjustments.
- Prefer `Codebase Scout` for quick exploration over the more expensive `Explore`. Use `Explore` for deep dives when `Codebase Scout` results are insufficient.