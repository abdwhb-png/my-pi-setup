import { existsSync, readFileSync } from "node:fs";
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { extensionConfigPath, readExtensionConfig } from "./config-loader.ts";
import { toPortableHomePath } from "./home-path.ts";

export interface LaunchProfile {
    description?: string;
    excludeExtensions: string[];
}
export interface LaunchProfilesConfig {
    profiles: Record<string, LaunchProfile>;
}

export function parseLaunchProfiles(raw: unknown): LaunchProfilesConfig {
    if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).some((k) => k !== "profiles") ||
        !("profiles" in raw)
    )
        throw new Error(
            "Launch profiles configuration must contain a profiles object.",
        );
    const entries = raw.profiles;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
        throw new Error("Launch profiles must be an object.");
    const profiles: Record<string, LaunchProfile> = {};
    for (const [name, entry] of Object.entries(entries)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || name === "edit")
            throw new Error(`Invalid launch profile name: ${name}`);
        if (
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            Object.keys(entry).some(
                (k) => k !== "description" && k !== "excludeExtensions",
            )
        )
            throw new Error(`Invalid launch profile: ${name}`);
        const value = entry as Record<string, unknown>;
        if (
            value.description !== undefined &&
            typeof value.description !== "string"
        )
            throw new Error(`Invalid description for launch profile: ${name}`);
        if (
            !Array.isArray(value.excludeExtensions) ||
            !value.excludeExtensions.every(
                (selector): selector is string =>
                    typeof selector === "string" &&
                    selector.trim().length > 0 &&
                    !selector.startsWith("-"),
            )
        )
            throw new Error(
                `Launch profile ${name} requires an excludeExtensions array of non-empty selectors.`,
            );
        profiles[name] = {
            description: value.description,
            excludeExtensions: value.excludeExtensions,
        };
    }
    return { profiles };
}

export function launchProfilesPath(agentDir = getAgentDir()): string {
    return extensionConfigPath("launchProfiles", { scope: "global", agentDir });
}

export function launchProfilesText(agentDir = getAgentDir()): string {
    const path = launchProfilesPath(agentDir);
    return existsSync(path)
        ? readFileSync(path, "utf8")
        : '{\n  "profiles": {}\n}\n';
}

export function loadLaunchProfiles(
    agentDir = getAgentDir(),
): LaunchProfilesConfig {
    const raw = readExtensionConfig("launchProfiles", {
        scope: "global",
        agentDir,
    });
    return raw === undefined ? { profiles: {} } : parseLaunchProfiles(raw);
}

/** Describe the launcher's option only for top-level help, using Pi's argument parser. */
export function launchProfilesHelp(args: string[]): string | undefined {
    if (!args[0]?.startsWith("-") || !parseArgs(args).help) return undefined;
    return `
Launcher options:
  --profile <name>              Select extension exclusions before other Pi options
                                Usage: pi --profile NAME [Pi options]
                                Configuration: ${toPortableHomePath(launchProfilesPath())}
                                (under PI_CODING_AGENT_DIR when set)
                                Use /profiles to list profiles or /profiles edit to configure them.
                                Changes apply to the next process.
`;
}

/** Consume only the launch prefix, leaving Pi's arguments and values to its native parser. */
export function prepareLaunchProfile(
    args: string[],
    agentDir = getAgentDir(),
): string[] {
    if (args[0] !== "--profile") {
        if (parseArgs(args).unknownFlags.has("profile"))
            throw new Error("Place --profile NAME before other Pi options.");
        return args;
    }
    const name = args[1];
    if (!name || name.startsWith("-"))
        throw new Error("--profile requires a profile name before Pi options.");
    const { profiles } = loadLaunchProfiles(agentDir);
    const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    if (!profile)
        throw new Error(
            `Unknown launch profile: ${name}. Available profiles: ${Object.keys(profiles).join(", ") || "none"}.`,
        );
    if (parseArgs(args.slice(2)).unknownFlags.has("profile"))
        throw new Error("Select one launch profile per process.");
    return [
        ...profile.excludeExtensions.flatMap((selector) => [
            "--exclude-extension",
            selector,
        ]),
        ...args.slice(2),
    ];
}
