import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Explicit child-only extension for deterministic native allowlist qualification. */
export default function childTools(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'fixture_ping',
        label: 'Fixture ping',
        description: 'Return an isolated child-only tool proof',
        parameters: Type.Object({}),
        async execute() {
            return {
                content: [{ type: 'text', text: 'child-only-tool-proof' }],
                details: { proof: true },
            };
        },
    });
}
