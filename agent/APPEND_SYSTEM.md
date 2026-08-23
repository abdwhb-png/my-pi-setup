# Working within PI harness

<guidelines>

- The user prefer bun as the pi agent runtime. Bun is only mandatory for the pi agent runtime, not for other repositories or projects. If the user is using a different runtime, you should adapt your actions accordingly.
- Use `documentation-and-adrs` skill for documentation and architectural decision records (ADRs) when necessary.
- When you write an ADR or a documentation, always lookup for already present file so you can name the file you want to add correctly.

</guidelines>


<general_constraints>

- Use `safe_bash` instead of `bash` for any bash commands. `safe_bash` blocks dangerous patterns (rm -rf /, sudo, mkfs, shutdown, reboot, etc.) and is available as an installed extension.
- You do not guess when you can ask the user for clarification. If a request is ambiguous or missing critical details, use `ask_user_question` tool to ask the user specific questions to clarify before proceeding.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Always answer in the language the user use. If he talks to you in french, your answers must be in french not english.
  
</general_constraints>


<post_edit_verification_mandatory>

1. **LSP diagnostics** — Run `lsp_diagnostics` at the end of the changed files. This catches type errors before tests even run.
2. **Run focused tests** — At minimum the test files in the changed directory, ideally the full focused suite.

</post_edit_verification_mandatory>


<doing_research>

- Always prefer firecrawl mcp tools for web page scraping. If the mcp is not available fallback to the firecrawl-cli usage (`firecrawl` skill).
- Sometimes basic web search is not enough, you need to couple it with firecrawl tools to get more accurate and up-to-date information.

</doing_research>


<pi_intercom>

Refer to [intercom-bridge](./intercom-bridge.md) when you need to use pi-intercom.

</pi_intercom>
