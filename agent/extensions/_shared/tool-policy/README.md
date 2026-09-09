# Integrated tool policy

Use this module to declare integrated tool visibility. Keep the only production
`pi.setActiveTools()` call in `tool-groups/index.ts`, including installations
without configured groups. Keep execution gates in the owning features.

## Declare intent

Register a named contribution at factory setup with
`registerToolPolicyContribution(pi, name, evaluate)`. Update your feature state
before calling the returned `refresh()`, and before notifying the user.

- Use `defaults` for convenience additions. Do not widen explicit role lists.
- Use `grants` for explicit session actions such as Herdr, SSH or workflow entry.
- Use `deny` for unavailable, unsafe or inactive managed tools.
- Keep evaluation synchronous and pure. Do not call Pi or mutate policy state
  from an evaluator. Treat its frozen role and registry view as read-only.
- Capture `captureGuard()` before asynchronous entry work. Call it after each
  await and before changing state. Use `captureRefresh()` for subscriptions.
  Reject obsolete callbacks rather than applying them to a replacement session.
- Dispose subscriptions at shutdown and replace them on session start. The
  helper replaces named registrations and invalidates old handles. Do not
  retain filtered active-tool arrays for restoration.

Publish role intent through `getToolPolicy().setRole()` before the existing
`pi-roles:tool-policy` compatibility event. Preserve unresolved references for
late registration. Resolve groups through the existing tool-groups resolver.
Read workflow grants and exclusions from the existing shared lease broker.

## Calculation and lifecycle

Build the role base from explicit names or the full registered catalog for
`all`. Without a role, retain Pi's startup baseline. Expand aliases, add
eligible defaults and explicit grants, intersect CLI and child ceilings, then
apply availability/security exclusions and inactive workflow masks. Preserve
first-occurrence order and remove duplicates and alias placeholders.

Share the coordinator through `Symbol.for('pi.tool-policy.coordinator.v1')`.
Do not rely on module caching or `ExtensionAPI` wrapper identity. Bind the
owner during factory setup, register contributions during session startup,
and reset session state and workflow leases before restoration. Recompute on
declared-policy changes, registry membership changes and session lifecycle.
Handle synchronous invalidation during application with a bounded convergence
loop, never a timer. Reject mutation during evaluation.

Forward concrete CLI ceilings as well as aliases through the Pi wrapper.
Preserve concrete CLI arguments for Pi itself. Keep alias expansion deferred.
Retain the consumed launch ceiling in the process-global registry across
owner reloads, without propagating its environment variable to children.
Direct binary invocation bypasses that wrapper contract.

## External packages: O3

Leave Plannotator and Pi Lens unchanged. Do not intercept their direct writes.
Compare current tools with the last applied result and report outside-owner
drift in `/context`. Do not adopt those writes as role intent or overwrite
them on every request. An integrated policy, registry or lifecycle change may
apply a fresh result. Enforce integrated restrictions at `tool_call` even when
an external writer makes a restricted tool visible.

Do not claim that the coordinator controls these two external packages.

## Provider presentation

Detect custom `SYSTEM.md` through `before_agent_start`, but do not build a
catalog there. `context.ts` only reads catalog diagnostics. The finalizer
implemented by `pi-overrides` is registered last by the `tool-groups` runtime
owner, which is pinned as the final package. In `before_provider_request`,
derive names, descriptions and tool selection from the final request
definitions. Replace only the generated
`<pi-runtime-tools>…</pi-runtime-tools>` block. Preserve arbitrary user headings,
unrelated instructions, multimodal content, schemas and cache metadata.

Use the validated adapters for OpenAI Completions, Responses, Azure Responses,
Codex Responses, Anthropic, Google, Vertex, Bedrock, Mistral and pi-messages.
Include names without descriptions and an explicit empty catalog. Distinguish
callable, disabled, unspecified and deferred definitions. Honor provider-native
`tool_choice` and `toolChoice`; never advertise disabled schemas as callable.
Warn explicitly when an API or shape is unsupported, and show that coverage
gap in `/context`. Do not fall back to a previous catalog or `getActiveTools()`.

Register conditional usage hints through `registerToolPresentation()`.
Keep safe-bash permissions and sandbox descriptions intact. Do not append
repeated reminders to conversation history or edit role `pi-agent`.

Keep `/context` observations limited to catalog metadata, active names,
differences and declared sources. Do not retain or log request payloads,
complete prompts, arguments or secrets. Leave Pi's default prompt unchanged.

Keep `tool-groups` last in the resolved extension order and register the
finalizer after its policy hooks. The architecture and real-runner tests enforce
that invariant and cover a preceding hook which rewrites outgoing tools.

## Validation

Run the focused `bun test --isolate` suites in this directory, `tool-groups`,
`context` and each changed consumer. Keep the real-runtime
`debug → pi-agent → edit` regression and architecture single-writer test.
Use the actual installed request builders with mock HTTP/SDK transports.
Do not call paid providers or change a user session for validation.

Distinguish a truthful schema/catalog from model compliance. These tests prove
availability, restrictions and presentation, not that a model obeys guidance.
