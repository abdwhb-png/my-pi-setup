import {
    getAgentDir,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { DelegationClient } from './delegation-client.ts';
import { registerSddExtension, type SddRuntime } from './extension-tools.ts';
import { openManifestReview } from './review-ui.ts';
import { SddStore } from './store.ts';
import { SddWorkflow } from './workflow.ts';

export {
    collectRunStatuses,
    registerSddExtension,
    shouldContinueAfterReconcile,
    type LegacyQueuedRun,
    type SddRuntime,
} from './extension-tools.ts';

function createRuntime(pi: ExtensionAPI): SddRuntime {
    const agentDir = getAgentDir();
    const store = new SddStore(agentDir);
    const delegation = new DelegationClient(pi.events);
    const workflow = new SddWorkflow(store, delegation, (runId) => {
        const manifest = store.loadManifest(runId);
        return manifest?.state === 'approved' ? manifest : null;
    });
    return {
        agentDir,
        store,
        delegation,
        workflow,
        openReview: openManifestReview,
    };
}

export default function sddOrchestrator(pi: ExtensionAPI): void {
    registerSddExtension(pi, createRuntime(pi));
}
