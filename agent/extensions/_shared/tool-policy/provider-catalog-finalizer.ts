import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findLatestActiveRoleState } from "../pi-roles/protocol.ts";
import {
    PROVIDER_CATALOG_ENTRY_TYPE,
    type ProviderCatalogAuditEntry,
    claimProviderCatalogRecorder,
} from "./provider-catalog-state.ts";
import { injectProviderToolsCatalog } from "./provider-catalog.ts";

/**
 * Register the provider-payload presentation hook. The tool-groups runtime
 * owner calls this last so the catalog observes every earlier payload mutation.
 */
export function registerProviderCatalogFinalizer(pi: ExtensionAPI): void {
    const recorder = claimProviderCatalogRecorder();
    let customPrompt = false;
    let requestNumber = 0;
    let warning: string | undefined;

    pi.on("session_start", () => {
        customPrompt = false;
        requestNumber = 0;
        warning = undefined;
        recorder.reset();
    });
    pi.on("before_agent_start", (event) => {
        customPrompt = event.systemPromptOptions?.customPrompt !== undefined;
    });
    pi.on("before_provider_request", (event, ctx) => {
        const model: Model<Api> | undefined = ctx.model;
        const api = model?.api ?? "unknown";
        const result = injectProviderToolsCatalog(api, event.payload);
        requestNumber++;
        recorder.record({
            api,
            requestNumber,
            injected: customPrompt && result.supported,
            observation: result.supported
                ? {
                      supported: true,
                      tools: result.tools,
                      callableTools: result.callableTools,
                      selection: result.selection,
                      block: result.block,
                  }
                : result,
        });
        const audit: ProviderCatalogAuditEntry = {
            schemaVersion: 1,
            provider: model?.provider ?? null,
            modelId: model?.id ?? null,
            roleName:
                findLatestActiveRoleState(ctx.sessionManager.getBranch())
                    ?.name ?? null,
            api,
            injected: customPrompt && result.supported,
            observation: result.supported
                ? {
                      supported: true,
                      tools: result.tools.map(({ name, deferred }) => ({
                          name,
                          deferred: deferred === true,
                      })),
                      callableToolNames:
                          result.callableTools?.map(({ name }) => name) ?? null,
                      selection: result.selection,
                  }
                : result,
        };
        try {
            pi.appendEntry(PROVIDER_CATALOG_ENTRY_TYPE, audit);
        } catch {
            ctx.ui.notify(
                "Tool catalog observation could not be saved to the session.",
                "warning",
            );
        }
        if (!result.supported) {
            if (warning !== result.reason)
                ctx.ui.notify(
                    "Tools catalog unavailable: " + result.reason,
                    "warning",
                );
            warning = result.reason;
            return undefined;
        }
        warning = undefined;
        return customPrompt ? result.payload : undefined;
    });
    pi.on("session_shutdown", () => recorder.dispose());
}

export default registerProviderCatalogFinalizer;
