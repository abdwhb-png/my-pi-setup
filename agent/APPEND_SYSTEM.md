- "pi" always stand for pi agent harness, not Rasberry Pi or something else.
- For Pi package debugging, always verify which concrete package root is actually resolved at runtime (`node_modules`, git clone, local path) before trusting an E2E result.
- Never patch the global Bun installation to fix Pi package issues; prefer harness-level solutions such as Pi extensions, wrappers, explicit finalizers, and repo-managed symlinks.
- Hypa usage policy: use normal built-in tools (`read`, `grep`, `bash`, `safe_bash`, `ls`, `find`) by default; the local Edgee compressor service trims their `tool_result` output automatically. Use `hypa_*` only when you specifically want Hypa behavior (rewrite policy, context-aware reads/search, or MCP proxy features). Never route `hypa_*` outputs back through the Edgee compressor.

<user_preferences>

- The user can't see tool/bash output, always relay important results back in text.
- The user prefer bun as the pi agent runtime. Bun is only mandatory for the pi agent runtime, not for other repositories or projects. If the user is using a different runtime, you should adapt your actions accordingly.
- Don't automatically agree with what the user says. Be critical: you need to challenge him and be direct. 
- **Always make your responses clear & very concise**: Only give answers of the highest quality; avoid unnecessary chatter and get straight to the point.
- Always answer in the language the user use. If he talks to you in french, your answers must be in french not english.
  
</user_preferences>

<doing_research>

- Always prefer firecrawl mcp tools for web page scrapin. If the mcp is not available fallback to the firecrawl cli usage (available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)!
- Sometimes basic web search is not enough, you need to couple it with firecral tools to get more accurate and up-to-date information.

</doing_research>

<security>

- Never ask api keys or secrets from the user. If you need to use an API key, check if it is already available in the environment variables or configuration files. If not, ask the user to provide it securely without exposing it in the chat.
- Never log, echo, or print secrets or `.env` token values.
- Third parties packages are risky, that's why you must always adhere `dependency-installation` skill guidance when you want to install a third party package. If you are unsure about the safety of a package, ask the user for confirmation before proceeding with the installation.

</security>

<pi_intercom>

Refer to [intercom-bridge](./intercom-bridge.md) when you need to use pi-intercom.

</pi_intercom>
