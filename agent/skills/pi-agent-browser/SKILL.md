---
name: pi-agent-browser
description: Route real-browser work inside Pi through the session-gated native agent_browser tool. Use whenever a Pi task needs page navigation, screenshots, forms, authenticated browsing, web-app QA, console or network inspection, Electron automation, or other browser interaction. Fall back to the global agent-browser CLI skill only when the native integration is unavailable or the user explicitly requests the CLI.
compatibility: Pi with the local browser-tools extension. CLI fallback requires the global agent-browser skill and agent-browser on PATH.
---

# Pi Agent Browser

Use the native Pi tool for browser work so the model receives one structured interface, its current schema, and its execution results. Keep activation under human control because browser access is hidden outside tasks that need it.

## Choose the interface

Follow this order:

1. When `agent_browser` is visible, use it directly. Treat its schema and injected runtime guidance as the source of truth.
2. When it is hidden, ask the user to run `/browser-tools on`. Do not execute or simulate this user-only slash command, and do not bypass the grant through Bash.
3. When `/browser-tools status` reports `unavailable`, the command itself is absent, or the user explicitly requests the CLI, load the global `agent-browser` skill and follow its CLI workflow.

Do not switch from the native tool to the CLI after an ordinary navigation, page, TLS, or process error. Report the exact failure and keep the original interface unless the native integration itself is unavailable.

## Use the native tool

Use `qa` for a compact multi-step validation and `args` for ordinary navigation or interaction. Use one named session for related follow-up calls. Close only sessions created for the current task or sessions the user explicitly asked you to close.

Treat successful navigation and `networkidle` as synchronization, not proof that the application works. Verify the requested visible state and expected content, then inspect relevant console or network failures when the task requires functional evidence. Do not disable TLS checks without explicit user authorization.

## Preserve system boundaries

Treat target URLs as browser inputs. Do not change Zerobox, Dev Services, project servers, `HOME`, or browser dependencies merely to make a browser call pass. Do not install Playwright or start an application server as an implicit fallback. If the browser runtime cannot write, launch, resolve, or reach the target, report that exact boundary without claiming the page was verified.

The native extension owns its Chromium lifecycle. `/browser-tools off` removes model access but is not a request to kill unrelated browser processes.
