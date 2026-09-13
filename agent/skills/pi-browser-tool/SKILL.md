---
name: pi-browser-tool
description: Use this skill for every browser-related task inside Pi. Route page navigation, screenshots, forms, authenticated browsing, web-app QA, console or network inspection, Electron automation, and any other browser interaction through the session-gated native agent_browser tool. Fall back to the global agent-browser CLI skill only when the native integration is unavailable or the user explicitly requests the CLI.
compatibility: Pi with the local browser-tools extension. CLI fallback requires the global agent-browser skill and agent-browser on PATH.
---

# Pi Browser Tool

Use the native Pi integration for browser work so you receive its current structured schema, runtime guidance, and results directly. Preserve the human-controlled grant because browser access is intentionally hidden outside tasks that need it.

## When to Use

Use this skill when browser interaction runs inside Pi, including navigation, screenshots, forms, authenticated sessions, web-app QA, console or network inspection, and Electron automation. Use it whether `agent_browser` is already visible or still requires activation.

## When Not to Use

Do not use this skill for ordinary HTTP requests that do not require a browser. When browser work runs in another harness, use that harness's Agent Browser integration or the global `agent-browser` skill instead.

## Choose the interface

Choose the interface before attempting browser work because the native Pi integration is explicitly granted per session:

1. When `agent_browser` is visible, use it directly. Treat its schema and injected runtime guidance as the source of truth.
2. When it is hidden, ask the user to run `/browser-tools on`. Do not execute or simulate this user-only slash command, and do not bypass the grant through Bash.
3. When `/browser-tools status` reports `unavailable`, the command itself is absent, or the user explicitly requests the CLI, load the global `agent-browser` skill and follow its CLI workflow.

Do not switch from the native tool to the CLI after an ordinary navigation, page, TLS, or process error. Report the exact failure and keep the original interface unless the native integration itself is unavailable.

## Verify browser results

Use `qa` for compact validation and `args` for ordinary navigation or interaction. Keep related calls in one named session so page state remains coherent. Close only sessions you created for the current task or sessions the user explicitly asked you to close.

Treat successful navigation and `networkidle` as synchronization, not proof that the application works. Verify the requested visible state and expected content, then inspect relevant console or network failures when the task requires functional evidence. Do not disable TLS checks without explicit user authorization.

## Trust a local CA

Use Agent Browser's CA support only for locally launched Chromium on Linux. Keep certificate verification enabled and never add `ignoreHttpsErrors`.

For persistent local development trust, set `caCert` in `~/.agent-browser/config.json` to the absolute path obtained by expanding `~/.local/share/dev-services/caddy/pki/authorities/local/root.crt`. Preserve every unrelated configuration field and keep the file private. Start a fresh Agent Browser session after adding or changing the field.

For one fresh session, pass `--ca-cert` before the browser command using the absolute certificate path. With the native Pi tool, use a fresh session so the launch-scoped option reaches a newly launched Chromium process. Do not attach the flag to an existing managed session.

CA import requires `certutil` from `libnss3-tools`. If it is unavailable, report that dependency as the blocker and obtain the authorization required by the current environment before installing it.

The CA path applies only to Agent Browser's isolated NSS database for locally launched Linux Chromium. It does not change WSL system trust, Windows trust, a personal Chrome profile, macOS, or Windows. It does not apply when using `--profile`, `--cdp`, `--auto-connect`, a browser provider, Lightpanda, Safari, or iOS. Do not claim a successful trust import for those modes.

Use `--no-ca-cert` with a fresh session to disable configured CA trust temporarily. To disable it permanently, remove only the `caCert` field from `~/.agent-browser/config.json` and preserve every other field.

## Classify QA failures

Distinguish these outcomes explicitly:

- A TLS error such as `ERR_CERT_AUTHORITY_INVALID` means navigation did not establish a trusted connection.
- An application failure means navigation succeeded but the requested UI, console, network, or functional assertion failed.
- A check listed under `notRunChecks` was never executed because fail-fast stopped the compiled QA batch. Do not report an unreached text or selector assertion as a negative result.

When QA stops during navigation, report the redacted causal TLS error first, then the executed failure and the checks not run. Retry application assertions only after the trust problem is resolved in a fresh session.

## Handle failures without crossing boundaries

Treat target URLs as browser inputs, not permission to reconfigure their infrastructure. Do not change Zerobox, Dev Services, project servers, `HOME`, or browser dependencies merely to make a browser call pass. Do not install Playwright or start an application server as an implicit fallback. If the browser runtime cannot write, launch, resolve, or reach the target, report that exact boundary without claiming the page was verified.

Leave Chromium lifecycle management to the native extension. Treat `/browser-tools off` as revocation of your access, not as a request to kill unrelated browser processes.
