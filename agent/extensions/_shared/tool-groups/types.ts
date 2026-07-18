/**
 * Tool groups extension — allow grouping tool names so a group alias
 * (e.g. `@read`) expands to its member tools.
 *
 * @module tool-groups/types
 */

/** Prefix that distinguishes a group alias from a bare tool name. */
export const TOOL_GROUP_PREFIX = '@';

/** Carries an aliased CLI allowlist past Pi's pre-extension registry filter. */
export const TOOL_GROUPS_REQUESTED_TOOLS_ENV = 'PI_TOOL_GROUPS_REQUESTED_TOOLS';

/** Shape persisted in settings.json / tool-groups.json. */
export interface ToolGroupsConfig {
    /** Map of group name -> ordered list of member tool or @group references. */
    groups: Record<string, string[]>;
}

// ── Diagnostics ───────────────────────────────────────

/** Diagnostic code for tool-group resolution. */
export type ToolGroupDiagnosticCode =
    | 'cycle'
    | 'missing-group'
    | 'unknown-tool'
    | 'unmatched-pattern';

/** A single diagnostic emitted during alias resolution. */
export interface ToolGroupDiagnostic {
    code: ToolGroupDiagnosticCode;
    /** Group name that triggered the diagnostic. Use '<active>' for top-level items. */
    group: string;
    /** The member value that triggered the diagnostic (tool name, group alias, pattern). */
    member: string;
    /** Human-readable explanation. */
    message: string;
}

/** Result of a single {@link resolveToolAliases} call. */
export interface ResolveToolAliasesResult {
    /** Ordered deduplicated tool names after full resolution. */
    names: string[];
    /** Ordered deduped group aliases that were expanded (e.g. ['@code', '@inspect']). */
    expandedAliases: string[];
    /** Diagnostics collected during resolution. */
    diagnostics: ToolGroupDiagnostic[];
}

// ── Helpers ──────────────────────────────────────────

/**
 * Prepend the group prefix to a name.
 * ```ts
 * toToolGroupAlias('read') -> '@read'
 * toToolGroupAlias('@read') -> '@read'   // idempotent
 * ```
 */
export function toToolGroupAlias(name: string): string {
    return name.startsWith(TOOL_GROUP_PREFIX)
        ? name
        : `${TOOL_GROUP_PREFIX}${name}`;
}

/**
 * Strip the group prefix from a name.
 * Returns the bare name if the value starts with '@', or undefined if not an alias.
 * ```ts
 * fromToolGroupAlias('@read') -> 'read'
 * fromToolGroupAlias('read')  -> undefined
 * ```
 */
export function fromToolGroupAlias(value: string): string | undefined {
    return value.startsWith(TOOL_GROUP_PREFIX)
        ? value.slice(TOOL_GROUP_PREFIX.length)
        : undefined;
}
