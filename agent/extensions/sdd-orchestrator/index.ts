import {
    getAgentDir,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SddActivityStore } from "./activity-store.ts";
import { openSddLive } from "./activity-ui.ts";
import { DelegationClient } from "./delegation-client.ts";
import { registerSddExtension, type SddRuntime } from "./extension-tools.ts";
import { openManifestReview } from "./review-ui.ts";
import { createSddAgentGate } from "./sdd-agents.ts";
import { SddStore } from "./store.ts";
import { SddWorkflow } from "./workflow.ts";
import { GitWorkspaceManager } from "./workspace.ts";

export {
    collectRunStatuses,
    registerSddExtension,
    shouldContinueAfterReconcile,
    type LegacyQueuedRun,
    type SddRuntime,
} from "./extension-tools.ts";

export function createRuntime(
    pi: ExtensionAPI,
    agentDir = getAgentDir(),
): SddRuntime {
    const store = new SddStore(agentDir);
    const delegation = new DelegationClient(pi.events);
    const activity = new SddActivityStore();
    const workspace = new GitWorkspaceManager(agentDir);
    const workflow = new SddWorkflow(
        store,
        delegation,
        (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === "approved" ? manifest : null;
        },
        activity,
        workspace,
        undefined,
        createSddAgentGate(),
    );
    return {
        agentDir,
        store,
        delegation,
        workflow,
        workspace,
        activity,
        openReview: openManifestReview,
        openLive: openSddLive,
    };
}

export default function sddOrchestrator(pi: ExtensionAPI): void {
    registerSddExtension(pi, createRuntime(pi));
}
