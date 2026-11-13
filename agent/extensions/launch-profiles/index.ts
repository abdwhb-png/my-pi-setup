import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    withFileMutationQueue,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    launchProfilesPath,
    launchProfilesText,
    loadLaunchProfiles,
    parseLaunchProfiles,
} from "../_shared/launch-profiles.ts";

export default function launchProfiles(pi: ExtensionAPI): void {
    pi.registerCommand("profiles", {
        description:
            "List launch profiles or edit their configuration: /profiles [name|edit]",
        handler: async (args, ctx) => {
            try {
                const name = args.trim();
                if (name === "edit") {
                    if (!ctx.hasUI)
                        throw new Error(
                            `Edit ${launchProfilesPath()} before the next launch.`,
                        );
                    const before = launchProfilesText();
                    const edited = await ctx.ui.editor(
                        "Launch profiles (JSON)",
                        before,
                    );
                    if (edited === undefined) return;
                    const config = parseLaunchProfiles(JSON.parse(edited));
                    const path = launchProfilesPath();
                    await withFileMutationQueue(path, async () => {
                        if (launchProfilesText() !== before)
                            throw new Error(
                                "Launch profiles changed while editing. Reopen /profiles edit.",
                            );
                        mkdirSync(dirname(path), { recursive: true });
                        const temporary = `${path}.${randomUUID()}.tmp`;
                        try {
                            writeFileSync(
                                temporary,
                                `${JSON.stringify(config, null, 2)}\n`,
                                { mode: 0o600 },
                            );
                            renameSync(temporary, path);
                        } finally {
                            rmSync(temporary, { force: true });
                        }
                    });
                    ctx.ui.notify(
                        "Launch profiles saved. Use pi --profile NAME for the next process; this process keeps its current extensions.",
                        "info",
                    );
                    return;
                }
                const { profiles } = loadLaunchProfiles();
                if (name) {
                    const profile = Object.hasOwn(profiles, name)
                        ? profiles[name]
                        : undefined;
                    if (!profile)
                        throw new Error(
                            `Unknown launch profile: ${name}. Use /profiles to list available profiles.`,
                        );
                    ctx.ui.notify(
                        `pi --profile ${name}\n${profile.description ?? ""}\nExcluded extensions: ${profile.excludeExtensions.join(", ") || "none"}`,
                        "info",
                    );
                    return;
                }
                const lines = Object.entries(profiles).map(
                    ([key, profile]) =>
                        `${key}: ${(profile.description ?? profile.excludeExtensions.join(", ")) || "no additional exclusions"}`,
                );
                ctx.ui.notify(
                    `${lines.join("\n") || "No launch profiles configured."}\nUse /profiles edit to add or change profiles. Start with pi --profile NAME before other Pi options.`,
                    "info",
                );
            } catch (error) {
                ctx.ui.notify(
                    error instanceof Error ? error.message : String(error),
                    "error",
                );
            }
        },
    });
}
