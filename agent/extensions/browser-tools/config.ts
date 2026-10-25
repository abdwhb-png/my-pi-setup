import { loadExtensionConfig } from "../_shared/config-loader.ts";

export function loadBrowserToolsConfig(cwd: string, projectTrusted: boolean) {
    return loadExtensionConfig(cwd, {
        owner: "browserTools",
        defaults: { enabledByDefault: false },
        projectTrusted,
        normalize(raw) {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                throw new Error(
                    "Browser tools configuration must be an object",
                );
            }
            if (!("enabledByDefault" in raw)) return {};
            if (typeof raw.enabledByDefault !== "boolean") {
                throw new Error("enabledByDefault must be a boolean");
            }
            return { enabledByDefault: raw.enabledByDefault };
        },
    });
}
