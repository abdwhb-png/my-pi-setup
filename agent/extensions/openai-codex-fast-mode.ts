import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWidget, type WidgetHandle } from "./_shared/fancy-footer";

const SERVICE_TIER = "priority";
const WIDGET_ID = "codex-fast-mode";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAICodexResponsesPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false;

  const model = payload.model;
  if (typeof model === "string" && model.includes("codex")) return true;

  // Pi's OpenAI Codex Responses payload has this shape. This catches Codex-provider
  // requests even if a non-codex model id is routed through that provider.
  return (
    payload.stream === true &&
    typeof payload.instructions === "string" &&
    Array.isArray(payload.input) &&
    payload.tool_choice === "auto" &&
    "prompt_cache_key" in payload
  );
}

function statusText(enabled: boolean): string {
  return `Codex fast mode: ${enabled ? "enabled" : "disabled"}`;
}

function widgetText(enabled: boolean): string {
  return `codex-fast ${enabled ? "on" : "off"}`;
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let latestWidgetText = widgetText(enabled);
  let widget: WidgetHandle | undefined;

  function updateWidget(ctx: ExtensionContext): void {
    latestWidgetText = widgetText(enabled);
    widget?.update(ctx, latestWidgetText);
  }

  widget = createWidget(pi, {
    id: WIDGET_ID,
    label: "Codex Fast Mode",
    description: "Shows whether OpenAI Codex priority service tier is enabled.",
    row: 0,
    order: 64,
    align: "right",
    render: () => latestWidgetText,
  });

  pi.on("session_start", async (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    widget?.remove(ctx);
  });

  pi.registerCommand("codex-fast-mode", {
    description: "Toggle OpenAI Codex priority service tier (/codex-fast-mode on|off|status)",
    getArgumentCompletions(prefix) {
      const trimmed = prefix.trimStart().toLowerCase();
      const options = ["on", "off", "status"];
      const filtered = options.filter((value) => value.startsWith(trimmed));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        enabled = true;
        updateWidget(ctx);
        ctx.ui.notify(statusText(enabled), "info");
        return;
      }

      if (arg === "off") {
        enabled = false;
        updateWidget(ctx);
        ctx.ui.notify(statusText(enabled), "info");
        return;
      }

      if (arg === "status" || arg === "") {
        updateWidget(ctx);
        ctx.ui.notify(statusText(enabled), "info");
        return;
      }

      ctx.ui.notify(
        `Unknown codex-fast-mode argument: ${arg}\nUsage: /codex-fast-mode [on|off|status]`,
        "warning",
      );
    },
  });

  pi.on("before_provider_request", (event) => {
    if (!enabled) return;
    if (!isOpenAICodexResponsesPayload(event.payload)) return;

    return {
      ...event.payload,
      service_tier: SERVICE_TIER,
    };
  });
}
