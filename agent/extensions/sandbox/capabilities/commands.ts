import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxConfigLayer, SandboxMode } from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";
import { formatShellPolicy } from "./runtime.ts";

export type CapabilityCommandContext = Pick<ExtensionContext, "hasUI" | "isProjectTrusted"> & {
    ui: Pick<ExtensionContext["ui"], "notify">;
};
export interface CapabilityCommandOptions<C extends CapabilityCommandContext> {
    load(ctx: C, session?: SandboxConfigLayer): ShellCapabilityResolution;
    apply(ctx: C, session?: SandboxConfigLayer): Promise<void>;
}

/** Session-only mode selection. Persistent authority is edited as sandbox.json. */
export function createCapabilityCommands<C extends CapabilityCommandContext = CapabilityCommandContext>(options: CapabilityCommandOptions<C>) {
    let session: SandboxConfigLayer | undefined;
    return {
        async handle(args: string, ctx: C): Promise<boolean> {
            const words = args.trim().split(/\s+/);
            if (words[0] === "mode" && (words[1] === "sandbox" || words[1] === "host") && words.length <= 3) {
                if (words[2] !== "--session") {
                    ctx.ui.notify("Persistent mode is configured in sandbox.json", "error");
                    return true;
                }
                session = { ...session, mode: words[1] as SandboxMode };
                await options.apply(ctx, session);
                ctx.ui.notify(`Session mode selected: ${words[1]}`, "info");
                return true;
            }
            if (words[0] === "capabilities" && (words[1] === undefined || words[1] === "list")) {
                ctx.ui.notify(formatShellPolicy(options.load(ctx, session)), "info");
                return true;
            }
            return false;
        },
        session: (): SandboxConfigLayer | undefined => session,
        reset: (): void => { session = undefined; },
    };
}
