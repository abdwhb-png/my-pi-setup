# AGENTS.md

- You must always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- Use the `factual-research` skill for factual research.
- Firecrawl mcp is not available so use firecrawl-cli (some available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)


**Mandatory:** Always refer to [copilot-instructions](./.github/copilot-instructions.md) for complete guidance.

**Test Driven Development (TDD) is mandatory for any code changes.** Follow the TDD cycle: Write a failing test → Write minimal code to pass the test → Refactor → Run the test suite to confirm all tests pass (follow `tdd` skill).

**Test Runner: Bun test.** I prefer `bun test` over vitest because bun's native test runner is significantly faster — 10x faster startup and 2.5-8x faster execution. All tests use `bun:test` imports. Use `mock.module()` instead of `vi.mock()` for module mocking (not hoisted — use `await import()` after the mock setup).