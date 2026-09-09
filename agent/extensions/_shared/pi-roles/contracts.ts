import { Type, type Static } from "typebox";

/** Origin of a discovered role file. */
export const RoleSourceSchema = Type.Union(
    [Type.Literal("project"), Type.Literal("user"), Type.Literal("built-in")],
    { description: "Origin of a discovered role file." },
);
export type RoleSource = Static<typeof RoleSourceSchema>;

/** Persisted identity of the active role. */
export const ActiveRoleStateSchema = Type.Object(
    {
        name: Type.String(),
        source: RoleSourceSchema,
        path: Type.String(),
        appliedAt: Type.Number(),
    },
    { additionalProperties: false },
);
export type ActiveRoleState = Static<typeof ActiveRoleStateSchema>;

export const ACTIVE_ROLE_ENTRY_TYPE = "pi-roles:active-role" as const;
