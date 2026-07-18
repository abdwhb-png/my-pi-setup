/** Canonical global definitions mirrored by agent/tool-groups.json. */
export const PI_LENS_READ_ONLY_TOOLS = [
    'ast_grep_search',
    'ast_grep_outline',
    'ast_grep_dump',
    'ast_dump',
    'lens_diagnostics',
    'lsp_diagnostics',
    'lsp_navigation',
    'module_report',
    'read_symbol',
    'read_enclosing',
] as const;

export const PI_LENS_MUTATING_TOOLS = ['ast_grep_replace'] as const;

export const PI_LENS_WRITE_TOOLS = [
    ...PI_LENS_READ_ONLY_TOOLS,
    ...PI_LENS_MUTATING_TOOLS,
] as const;

export const TOOL_GROUP_DEFINITIONS: Record<string, string[]> = {
    inspect: ['read', 'grep', 'find', 'ls'],
    web: ['web_search', 'fetch_content', 'get_search_content'],
    docs: ['mcp:context7', 'mcp:deepwiki'],
    review: ['@inspect', 'memory_search', '@docs', '@web'],
    memory: ['memory', 'session_search', 'memory_search'],
    'files-write': ['edit', 'write'],
    implement: ['@files-write', 'safe_bash'],
    lens: [...PI_LENS_READ_ONLY_TOOLS],
    'lens-write': ['@lens', ...PI_LENS_MUTATING_TOOLS],
};
