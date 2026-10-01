// Shared types for pi-skill-gate

import type { ToggleState } from "../_shared/skill-visibility.ts";
export type {
    ToggleState,
    EditScope,
    SkillGateConfig,
} from "../_shared/skill-visibility.ts";

export interface SkillAnalytics {
    counts: Record<string, number>;
}

// ── UI row data ──

export interface RowData {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation: boolean;
    state: ToggleState;
    source: "global" | "project" | "default";
    globalEnabled: boolean;
    usageCount: number;
}

// ── Theme ──

export interface SkillGateTheme {
    accent: (t: string) => string;
    dim: (t: string) => string;
    muted: (t: string) => string;
    warning: (t: string) => string;
    error: (t: string) => string;
    bold: (t: string) => string;
    enabled: (t: string) => string;
    selCell: (t: string) => string;
    selRow: (t: string) => string;
    nativeDisabled: (t: string) => string;
}
