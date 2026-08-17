export const PROFILES = ["direct", "light", "standard", "critical"] as const;
export type Profile = (typeof PROFILES)[number];

export interface VerifyCommand {
    id: string;
    command: string;
    timeoutMs?: number;
}

export interface QaCommand {
    id: string;
    command: string;
    timeoutMs?: number;
}

export interface BrowserScenario {
    id: string;
    baseUrl: string;
    preconditions: string[];
    steps: string[];
    expected: string[];
    cleanup?: string[];
}

export interface ParsedTask {
    id: string;
    ordinal: number;
    title: string;
    body: string;
    dependsOn: string[];
    files: string[];
    verify: VerifyCommand[];
    qa?: QaCommand[];
    browser?: BrowserScenario[];
}

export interface ParsedPlan {
    title: string;
    tasks: ParsedTask[];
}
