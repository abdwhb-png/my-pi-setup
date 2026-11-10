# Fast mode

`/fast-mode on|off|status` controls fast mode for supported models. `/codex-fast-mode` remains an alias. An empty argument reports status. The setting starts disabled and lives in the current extension instance; reloading resets it.

The `fast-mode` widget appears below the editor through the shared `pi-fancy-footer` integration. It shows `fast-mode:openai` when enabled for a supported OpenAI model, or `fast-mode:off` when disabled, and clears on shutdown. The label uses the shared muted color, the separator is dim, and an active provider uses the success color. It no longer contributes an extension status. Switching to an unsupported model hides the widget and leaves requests unchanged; switching back preserves the enabled setting. Without the footer integration, the shared helper uses Pi's standard widget API.

## Current support

Native `openai` and `openai-codex` providers using `openai-responses`, `openai-completions`, or `openai-codex-responses` request `service_tier: "priority"` when enabled. OpenAI-compatible proxies under other provider names are excluded. The widget reports the requested setting, not confirmation of the tier served by the provider. Request payloads are copied rather than mutated. The provider contract is documented at https://developers.openai.com/api/docs/guides/fast-mode; offline tests do not qualify the serving tier.

## Adding a provider

Add a module under `providers/`, following `providers/openai.ts`, and include its exported definition in the static list in `provider-registry.ts`:

- `id`: the stable lowercase provider identifier displayed by the widget.
- `label`: the provider name used in command notifications.
- `supports(model)`: check the provider, transport, and any model restrictions.
- `apply(payload)`: return a request with the provider's documented fast-mode fields, preserving unrelated fields.

The same entry controls widget visibility and request modification. The command and widget require no provider-specific changes. Verify the provider's current contract and add request/visibility coverage through `fast-mode.test.ts` before enabling it. There is no runtime registration or provider configuration layer.

## Validation

From `agent/`, run `bun test --isolate extensions/fast-mode/fast-mode.test.ts`. Tests load the public extension with the Pi test harness, discover its footer contribution through the real event bus, and exercise commands, model changes, and request hooks without provider calls. Compatibility tests live under `extensions/__tests__/integration/`: `context-fast-mode-tool-groups.integration.test.ts` and `codex-compaction-fast-mode-tool-groups.integration.test.ts`. They load independent extensions together to verify that their request modifications are preserved. Compaction owns its standalone transport regression in `pi-codex-compaction/checkpoint-transport.test.ts`; the combined tests cover only hook compatibility.
