import { Value } from "typebox/value";
import { loadExtensionConfig } from "../../_shared/config-loader.ts";
import { PiRolesSettingsSchema, type PiRolesSettings } from "./schemas.ts";

function normalize(raw: unknown): Partial<PiRolesSettings> {
    if (!raw || typeof raw !== "object") return {};
    if (
        "planApprovedRole" in raw &&
        (typeof raw.planApprovedRole !== "string" ||
            !raw.planApprovedRole.trim())
    ) {
        throw new Error(
            "pi-roles.planApprovedRole must be a nonempty role name",
        );
    }
    // Validate but don't throw — coerce/discard unknown fields. Cast is safe
    // because additionalProperties: true on the schema, and Check confirmed
    // every present field matches.
    if (!Value.Check(PiRolesSettingsSchema, raw)) return {};
    return raw;
}

export function loadSettings(
    cwd: string,
    projectTrusted = false,
): PiRolesSettings {
    return loadExtensionConfig(cwd, {
        owner: "roles",
        defaults: {},
        normalize,
        projectTrusted,
    });
}
