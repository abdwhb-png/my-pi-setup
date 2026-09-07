/** Safe display metadata for the active runtime. Contains no Engine endpoint or credentials. */
export interface DockerAccessSummary {
    mode: "off" | "targeted" | "full";
    profile: string;
    targets: {
        selector: string;
        profile: string;
        operations: string[];
        hostAccessException: boolean;
    }[];
    hostAccessException: boolean;
}
