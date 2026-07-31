import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerSubagentsOverview from './pi-subagents-overview/index.ts';

export default function registerSubagentsAddons(pi: ExtensionAPI): void {
    registerSubagentsOverview(pi);
}
