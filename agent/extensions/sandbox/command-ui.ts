import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    isKeyRelease,
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { summarizeDockerAccess } from "../_shared/sandbox-runtime/docker-summary.ts";
import { parseSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import {
    subscribeSandboxRuntime,
    type SandboxRuntimeSnapshot,
} from "../_shared/sandbox-runtime/index.ts";
import {
    computeFramedPanelViewportRows,
    renderFramedPanels,
    renderPanelTitle,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "../_shared/ui/framed-panels.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import { persistedCapabilityPath } from "./capabilities/authority.ts";
import { installationReadPaths } from "./capabilities/installations.ts";
import {
    dockerClientInspectionLines,
    type DockerClientInspection,
} from "./docker-client-inspection.ts";
import { sandboxDoctorLines, type SandboxDoctorInspection } from "./doctor.ts";
import type { SandboxExecutableInspection } from "./executable-inspection.ts";
import type { LoadSandboxConfigResult } from "./index.ts";

export const SANDBOX_SECTIONS = [
    "Status",
    "Permissions",
    "Doctor",
    "Docker",
] as const;
export type SandboxSection = (typeof SANDBOX_SECTIONS)[number];
export type SandboxDashboardAction =
    | "mode"
    | "installations"
    | "docker on"
    | "docker off"
    | "docker break-glass"
    | "inspect-command";
export type SandboxDashboardSnapshot = {
    runtime: SandboxRuntimeSnapshot;
    clients?: DockerClientInspection;
    actionProblem?: string;
} & (
    | { resolved: LoadSandboxConfigResult; error?: never }
    | { resolved?: never; error: string }
);
export interface SandboxDashboardSource {
    read(): SandboxDashboardSnapshot;
    inspect(executable?: string): Promise<SandboxDoctorInspection>;
}
export interface SandboxDashboardState {
    section: SandboxSection;
    executable?: string;
}
export interface SandboxDashboardIntent {
    action: SandboxDashboardAction;
    state: SandboxDashboardState;
}
type UiContext = Pick<ExtensionContext, "mode"> & {
    ui: Pick<ExtensionContext["ui"], "custom">;
};
type Tone = "text" | "muted" | "success" | "warning" | "danger";
type Fact = { label: string; value: string; tone?: Tone };
type Item = {
    label: string;
    value?: string;
    tone?: Tone;
    details?: Array<string | Fact>;
    action?: SandboxDashboardAction;
    refresh?: true;
};
type Page = { facts: Fact[]; items: Item[] };
type DoctorState =
    | { state: "idle" }
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; report: SandboxDoctorInspection };
const list = (title: string, values: readonly string[]): string[] => [
    title,
    ...(values.length
        ? values.map((value) => `  ${persistedCapabilityPath(value)}`)
        : ["  None"]),
];
const refreshItem: Item = { label: "Refresh", refresh: true };

function executableResult(
    inspection: SandboxExecutableInspection | undefined,
    admitted: boolean,
): Pick<Fact, "value" | "tone"> {
    if (!inspection) return { value: "Not checked", tone: "muted" };
    if (inspection.state === "exposed")
        return {
            value: admitted ? "Exposed · not executed" : "Exposed · planned",
            tone: admitted ? "success" : "warning",
        };
    const labels = {
        unknown: "Not verified",
        unavailable: "Command not found",
        inaccessible: "Read access blocked",
        "dependency-inaccessible": "Dependency unavailable",
    };
    return {
        value: labels[inspection.state],
        tone: inspection.state === "unknown" ? "warning" : "danger",
    };
}

class SandboxDashboard implements Component {
    private focus: "navigation" | "content";
    private snapshot: SandboxDashboardSnapshot;
    private section: SandboxSection;
    private selected = 0;
    private detail: Item | undefined;
    private offset = 0;
    private capacity = 1;
    private maxScroll = 0;
    private settled = false;
    private doctor: DoctorState = { state: "idle" };
    private inspectionEpoch = 0;
    private readonly unsubscribe: () => void;
    constructor(
        private readonly tui: TUI,
        private readonly theme: Theme,
        private readonly source: SandboxDashboardSource,
        private readonly state: SandboxDashboardState,
        private readonly done: (
            result: SandboxDashboardIntent | undefined,
        ) => void,
    ) {
        this.section = state.section;
        this.focus = state.section === "Status" ? "navigation" : "content";
        this.snapshot = source.read();
        this.unsubscribe = subscribeSandboxRuntime(() => this.refresh());
        if (this.section === "Doctor") void this.inspect();
    }
    invalidate(): void {}
    dispose(): void {
        this.settled = true;
        this.inspectionEpoch += 1;
        this.unsubscribe();
    }
    private async inspect(): Promise<void> {
        const epoch = ++this.inspectionEpoch;
        this.doctor = { state: "loading" };
        let result: DoctorState;
        try {
            const report = await this.source.inspect(this.state.executable);
            result = { state: "ready", report };
        } catch (error) {
            result = {
                state: "error",
                message: error instanceof Error ? error.message : String(error),
            };
        }
        if (this.settled || epoch !== this.inspectionEpoch) return;
        const selectedLabel = this.page().items[this.selected]?.label;
        this.doctor = result;
        this.selected = Math.max(
            0,
            this.page().items.findIndex((item) => item.label === selectedLabel),
        );
        this.tui.requestRender();
    }
    private refresh(snapshot = this.source.read()): void {
        if (this.settled) return;
        this.snapshot = snapshot;
        this.detail = undefined;
        this.offset = 0;
        this.inspectionEpoch += 1;
        this.doctor = { state: "idle" };
        if (this.section === "Doctor") void this.inspect();
        this.tui.requestRender();
    }
    private page(): Page {
        const page = this.sectionPage();
        if (this.snapshot.actionProblem) {
            page.facts.unshift({
                label: "Last action",
                value: truncateToWidth(
                    this.snapshot.actionProblem.split("\n")[0] ??
                        this.snapshot.actionProblem,
                    72,
                ),
                tone: "danger",
            });
            page.items.unshift({
                label: "Last action failed",
                tone: "danger",
                details: [this.snapshot.actionProblem],
            });
        }
        return page;
    }
    private sectionPage(): Page {
        const { resolved, runtime } = this.snapshot;
        if (!resolved)
            return {
                facts: [
                    {
                        label: "Configuration",
                        value: "Blocked",
                        tone: "danger",
                    },
                    {
                        label: "Problem",
                        value: truncateToWidth(
                            this.snapshot.error.split("\n")[0] ??
                                this.snapshot.error,
                            72,
                        ),
                        tone: "danger",
                    },
                    {
                        label: "Next step",
                        value: "Correct sandbox.json, then refresh.",
                    },
                ],
                items: [
                    {
                        label: "Configuration problem",
                        details: [this.snapshot.error],
                    },
                    refreshItem,
                ],
            };
        const { config, shell } = resolved;
        const aligned =
            runtime.state === "enabled" &&
            runtime.sandboxFingerprint === shell.sandboxFingerprint;
        const parsed = aligned
            ? parseSandboxExecutionContext(runtime.contexts?.["bash-general"])
            : undefined;
        const admitted = parsed?.version === 3;
        const policy =
            shell.mode === "host"
                ? "Inactive in host mode"
                : admitted
                  ? "Applied"
                  : aligned
                    ? "Not verified"
                    : runtime.state === "enabled"
                      ? "Changes pending"
                      : "Awaiting runtime";
        if (this.section === "Status") {
            const labels = {
                enabled: "Ready",
                error: "Unavailable",
                disabled: "Disabled",
                uninitialized: "Not started",
                reconfiguring: "Updating",
            };
            const facts: Fact[] = [
                {
                    label: "Shell mode",
                    value:
                        shell.mode === "host"
                            ? "Host · unsandboxed"
                            : "Sandbox",
                    tone: shell.mode === "host" ? "warning" : "text",
                },
                {
                    label: "Runtime",
                    value: labels[runtime.state],
                    tone:
                        runtime.state === "enabled"
                            ? "success"
                            : runtime.state === "error"
                              ? "danger"
                              : "warning",
                },
                {
                    label: "Policy",
                    value: policy,
                    tone:
                        admitted && shell.mode !== "host"
                            ? "success"
                            : "warning",
                },
                {
                    label: "Docker",
                    value:
                        config.docker.mode === "disabled"
                            ? "Off"
                            : config.docker.mode === "full"
                              ? "Full access · host control"
                              : "Targeted access",
                    tone: config.docker.mode === "full" ? "warning" : "text",
                },
            ];
            if (shell.state !== "ready")
                facts.unshift({
                    label: "Shell blocked",
                    value: shell.diagnostic ?? shell.state,
                    tone: "danger",
                });
            if (runtime.state === "error")
                facts.push({
                    label: "Next step",
                    value: "Open Doctor to inspect the configuration and runtime.",
                });
            if (
                runtime.state === "enabled" &&
                runtime.analysis.state === "retrying"
            )
                facts.push({
                    label: "Analysis",
                    value: "Retrying · shell remains available",
                    tone: "warning",
                });
            return {
                facts,
                items: [
                    { label: "Change session mode", action: "mode" },
                    refreshItem,
                    {
                        label: "Technical details",
                        details: [
                            {
                                label: "Profile",
                                value: `${shell.profile} (${shell.state})`,
                            },
                            "Shell commands only; native tools and MCP use the host.",
                            { label: "Runtime", value: runtime.state },
                            { label: "Policy", value: policy },
                            { label: "Source", value: resolved.source },
                            {
                                label: "Global configuration",
                                value: persistedCapabilityPath(
                                    shell.authorityPath,
                                ),
                            },
                        ],
                    },
                ],
            };
        }
        if (this.section === "Permissions")
            return {
                facts: [
                    {
                        label: "Policy",
                        value: policy,
                        tone:
                            admitted && shell.mode !== "host"
                                ? "success"
                                : "warning",
                    },
                ],
                items: [
                    {
                        label: "Files",
                        value: `${config.filesystem.allowRead.length} read locations · ${config.filesystem.allowWrite.length} write locations`,
                        details: [
                            ...list("Read access", config.filesystem.allowRead),
                            "",
                            ...list(
                                "Write access",
                                config.filesystem.allowWrite,
                            ),
                            "",
                            ...list(
                                "Read restrictions",
                                config.filesystem.denyRead,
                            ),
                            "",
                            ...list(
                                "Write restrictions",
                                config.filesystem.denyWrite,
                            ),
                        ],
                    },
                    {
                        label: "Network",
                        value: `${config.network.allowedDomains.length + config.network.allowedHostDomains.length} allowed hosts · direct TCP ${config.network.mediatedDirectTcp.enabled ? "on" : "off"}`,
                        details: [
                            ...list(
                                "External hosts",
                                config.network.allowedDomains,
                            ),
                            "",
                            ...list(
                                "Host-local hosts",
                                config.network.allowedHostDomains,
                            ),
                            "",
                            ...list(
                                "Blocked hosts",
                                config.network.deniedDomains,
                            ),
                            "",
                            ...list(
                                "Direct TCP ports",
                                config.network.mediatedDirectTcp.enabled
                                    ? config.network.mediatedDirectTcp.ports.map(
                                          String,
                                      )
                                    : [],
                            ),
                        ],
                    },
                    {
                        label: "Commands",
                        value: `${config.environment.installations?.length ?? 0} selected installations`,
                        details: [
                            ...list(
                                "Selected installations",
                                config.environment.installations?.flatMap(
                                    (installation) => [
                                        installation.name,
                                        ...installation.roots.flatMap(
                                            installationReadPaths,
                                        ),
                                    ],
                                ) ?? [],
                            ),
                            "",
                            ...list(
                                "Configured command directories",
                                config.environment.path,
                            ),
                            "",
                            ...list(
                                "Environment keys (values hidden)",
                                Object.keys(config.environment.variables),
                            ),
                        ],
                    },
                    {
                        label: "Temporary storage & connections",
                        value: shell.grants.hostTmp
                            ? "Host /tmp"
                            : "Private /tmp",
                        details: [
                            {
                                label: "Temporary storage",
                                value: shell.grants.hostTmp
                                    ? "host /tmp"
                                    : "private /tmp; native file tools use a different /tmp",
                            },
                            "",
                            ...list(
                                "Unix socket grants",
                                config.resources?.unixSockets ?? [],
                            ),
                            "",
                            ...list(
                                "TCP publications",
                                config.resources?.tcpPublications.map(
                                    (item) =>
                                        `${item.scope}: ${item.listen} → ${item.target}`,
                                ) ?? [],
                            ),
                        ],
                    },
                    {
                        label: "Manage local installations",
                        action: "installations",
                    },
                    refreshItem,
                ],
            };
        if (this.section === "Doctor") {
            const items: Item[] = [];
            const facts: Fact[] = [
                {
                    label: "Configuration",
                    value: shell.state === "ready" ? "Valid" : "Blocked",
                    tone: shell.state === "ready" ? "success" : "danger",
                },
                {
                    label: "Inspection",
                    value: "Read-only · commands are not executed",
                    tone: "muted",
                },
            ];
            let problem: string | undefined;
            let nextStep = "Open the failed check for its cause, then refresh.";
            if (shell.state !== "ready")
                problem = shell.diagnostic ?? shell.state;
            else if (runtime.state === "error")
                problem = "Session runtime unavailable";
            if (this.doctor.state === "loading" || this.doctor.state === "idle")
                items.push({
                    label: "Installed runtime",
                    value: "Checking…",
                    tone: "warning",
                });
            else if (this.doctor.state === "error") {
                problem ??= this.doctor.message;
                items.push({
                    label: "Inspection failed",
                    value: "Blocked",
                    tone: "danger",
                    details: [
                        this.doctor.message,
                        "Review the reported configuration or installation, then refresh.",
                    ],
                });
            } else {
                const report = this.doctor.report;
                if (report.runtimeProblem) {
                    problem ??= "Installed runtime failed verification";
                    nextStep =
                        "Open Installed runtime; restore its matching bundle.";
                    items.push({
                        label: "Installed runtime",
                        value: "Verification failed",
                        tone: "danger",
                        details: [
                            report.runtimeProblem,
                            "Restore the matching Zerobox release and runtime bundle, then refresh.",
                        ],
                    });
                } else
                    items.push({
                        label: "Installed runtime",
                        value: report.runtime ? "Verified" : "Not verified",
                        tone: report.runtime ? "success" : "warning",
                        details: report.runtime
                            ? [
                                  {
                                      label: "Version",
                                      value: report.runtime.version,
                                  },
                                  {
                                      label: "Runtime",
                                      value: persistedCapabilityPath(
                                          report.runtime.root,
                                      ),
                                  },
                                  {
                                      label: "Manifest",
                                      value: report.runtime.manifestSha256,
                                  },
                              ]
                            : [
                                  "The installed runtime was not verified. Review its installation before relying on it.",
                              ],
                    });
                if (report.executable) {
                    const { name, inspection } = report.executable;
                    const exposed = inspection.state === "exposed";
                    const result = executableResult(
                        inspection,
                        Boolean(report.admitted),
                    );
                    if (
                        !exposed &&
                        inspection.state !== "unknown" &&
                        !problem
                    ) {
                        problem = `${name}: ${result.value}`;
                        nextStep =
                            inspection.state === "unavailable"
                                ? "Select its installation in Permissions → Commands."
                                : "Authorize the command and its dependencies in Permissions.";
                    }
                    items.push({
                        label: `Command: ${name}`,
                        ...result,
                        details: [
                            {
                                label: "Static inspection",
                                value: inspection.state,
                            },
                            ...(inspection.path
                                ? [
                                      {
                                          label: "Executable",
                                          value: persistedCapabilityPath(
                                              inspection.path,
                                          ),
                                      },
                                  ]
                                : []),
                            ...(inspection.realPath
                                ? [
                                      {
                                          label: "Canonical target",
                                          value: persistedCapabilityPath(
                                              inspection.realPath,
                                          ),
                                      },
                                  ]
                                : []),
                            ...(inspection.source
                                ? [
                                      {
                                          label: "Source",
                                          value: inspection.source,
                                      },
                                  ]
                                : []),
                            ...inspection.issues,
                            exposed
                                ? "No command was executed. Static inspection does not prove dynamic loading or service readiness."
                                : {
                                      label: "Next step",
                                      value: "Review the selected installation, executable read access and dependencies; explicit denials remain authoritative.",
                                  },
                        ],
                    });
                }
                const priority: Record<Tone, number> = {
                    danger: 0,
                    warning: 1,
                    success: 2,
                    text: 3,
                    muted: 3,
                };
                items.sort(
                    (a, b) =>
                        priority[a.tone ?? "text"] - priority[b.tone ?? "text"],
                );
                items.push({
                    label: "Full inspection details",
                    details: sandboxDoctorLines(report),
                });
            }
            if (problem)
                facts.push(
                    {
                        label: "Problem",
                        value: truncateToWidth(
                            problem.split("\n")[0] ?? problem,
                            72,
                        ),
                        tone: "danger",
                    },
                    { label: "Next step", value: nextStep },
                );
            items.push(
                { label: "Inspect a command…", action: "inspect-command" },
                refreshItem,
            );
            return { facts, items };
        }
        const configured = summarizeDockerAccess(config.docker);
        const active = parsed?.version === 3 ? parsed.docker : undefined;
        const clients =
            this.doctor.state === "ready"
                ? this.doctor.report.dockerClients
                : admitted
                  ? this.snapshot.clients
                  : undefined;
        const facts: Fact[] = [
            {
                label: "Configured",
                value:
                    configured.mode === "off"
                        ? "Off"
                        : configured.mode === "full"
                          ? "Full access · host control"
                          : `${configured.targets.length} permitted targets`,
                tone: configured.mode === "full" ? "warning" : "text",
            },
            {
                label: "Applied",
                value:
                    shell.mode === "host"
                        ? "Broker inactive in host mode"
                        : active
                          ? active.mode === "off"
                              ? "Off"
                              : active.mode === "full"
                                ? "Full access"
                                : `${active.targets.length} targets`
                          : "Not verified",
                tone:
                    active && shell.mode !== "host"
                        ? active.mode === "full"
                            ? "warning"
                            : "text"
                        : "warning",
            },
            {
                label: "Docker CLI",
                ...executableResult(
                    clients?.cli,
                    clients?.admission === "admitted",
                ),
            },
            {
                label: "Compose",
                ...executableResult(
                    clients?.compose,
                    clients?.admission === "admitted",
                ),
            },
        ];
        if (configured.hostAccessException)
            facts.push({
                label: "Warning",
                value: "Some targets have a host-access exception",
                tone: "warning",
            });
        if (active?.breakGlass?.length)
            facts.push({
                label: "Temporary exec",
                value: "Active · see target details for expiry",
                tone: "warning",
            });
        return {
            facts,
            items: [
                {
                    label: "Target permissions",
                    details: [
                        "Configured targets",
                        ...configured.targets.flatMap((target) => {
                            const lines: Array<string | Fact> = [
                                target.selector,
                                { label: "Access", value: target.profile },
                                {
                                    label: "Operations",
                                    value: target.operations.join(", "),
                                },
                            ];
                            if (target.boundedInspection)
                                lines.push({
                                    label: "Exec",
                                    value: "Bounded read-only inspection",
                                });
                            return lines;
                        }),
                        "",
                        "Applied targets",
                        ...(active?.targets.flatMap((target) => [
                            target.selector,
                            {
                                label: "Operations",
                                value: target.operations.join(", "),
                            },
                        ]) ?? ["Not verified"]),
                        ...(active?.breakGlass?.map((grant) => ({
                            label: "Temporary exec",
                            value: `${grant.containerId} until ${new Date(grant.expiresAtMs).toISOString()}`,
                        })) ?? []),
                    ],
                },
                {
                    label: "Inspect Docker CLI and Compose",
                    action: "inspect-command",
                },
                {
                    label:
                        config.docker.mode === "disabled"
                            ? "Enable project Docker access"
                            : "Disable project Docker access",
                    action:
                        config.docker.mode === "disabled"
                            ? "docker on"
                            : "docker off",
                },
                ...(config.docker.mode === "targeted"
                    ? [
                          {
                              label: "Temporary exec access…",
                              action: "docker break-glass" as const,
                          },
                      ]
                    : []),
                {
                    label: "Client inspection details",
                    details: dockerClientInspectionLines(clients),
                },
                refreshItem,
            ],
        };
    }
    render(width: number): string[] {
        const colors = createUiColors(this.theme);
        const valueText = (value: string, tone: Tone = "text") =>
            colors[tone](
                `${tone === "success" ? "✓ " : tone === "warning" ? "! " : tone === "danger" ? "× " : ""}${value}`,
            );
        const field = (fact: Fact) =>
            colors.meta(`${fact.label}: `) + valueText(fact.value, fact.tone);
        const page = this.page();
        this.selected = Math.min(
            this.selected,
            Math.max(0, page.items.length - 1),
        );
        const height = Math.max(1, Math.min(22, this.tui.terminal.rows - 2));
        const frameWidth = Math.min(96, width);
        const focused =
            this.detail?.label ??
            (this.focus === "navigation"
                ? this.section
                : (page.items[this.selected]?.label ?? this.section));
        if (height < 7 || width < 24) {
            this.capacity = 1;
            return [
                colors.primary(this.section),
                colors.text(focused),
                colors.muted(
                    this.detail
                        ? "Esc back · ↑↓ scroll"
                        : "Esc close · Tab panes",
                ),
            ]
                .slice(0, height)
                .map((line) => truncateToWidth(line, Math.max(1, width)));
        }
        const resolved = resolveResponsivePanelLayout(frameWidth, [
            {
                mode: "split",
                minWidth: 64,
                panels: [{ minWidth: 18, maxWidth: 18 }, { minWidth: 40 }],
            },
            { mode: "single", minWidth: 4, panels: [{ minWidth: 2 }] },
        ] as const);
        if (!resolved) return [];
        const split = resolved.mode === "split";
        const navigation = SANDBOX_SECTIONS.map((section) =>
            section === this.section
                ? colors.primary(this.theme.bold(`› ${section}`))
                : colors.text(`  ${section}`),
        );
        const contentWidth = resolved.layout.panelWidths[split ? 1 : 0];
        const prelude: string[] = [];
        if (this.snapshot.actionProblem)
            prelude.push(colors.danger("× Last action failed"));
        if (this.snapshot.resolved?.shell.mode === "host")
            prelude.push(colors.warning("⚠ Host mode: unsandboxed"));
        if (this.snapshot.resolved?.config.docker.mode === "full")
            prelude.push(colors.warning("⚠ Full Docker: host control"));
        const body: string[] = [];
        const starts: number[] = [];
        if (this.detail)
            body.push(
                ...(this.detail.details ?? []).map((line) =>
                    typeof line === "string" ? colors.text(line) : field(line),
                ),
            );
        else {
            body.push(...page.facts.map(field), "");
            for (let index = 0; index < page.items.length; index++) {
                const item = page.items[index];
                starts.push(wrapPanelLines(body, contentWidth).length);
                const selected =
                    this.focus === "content" && index === this.selected;
                const marker = selected ? colors.primary("› ") : "  ";
                const label = item.value
                    ? field({
                          label: item.label,
                          value: item.value,
                          tone: item.tone,
                      })
                    : colors.text(item.label);
                body.push(
                    marker + label + (item.details ? colors.subtle("  ▸") : ""),
                );
            }
        }
        const showContent = split || this.focus === "content";
        const lines = wrapPanelLines(
            showContent ? body : navigation,
            contentWidth,
        );
        const titles = split
            ? [
                  renderPanelTitle(
                      this.theme,
                      "Sections",
                      this.focus === "navigation",
                  ),
                  renderPanelTitle(
                      this.theme,
                      this.detail?.label ?? this.section,
                      this.focus === "content",
                  ),
              ]
            : [
                  renderPanelTitle(
                      this.theme,
                      this.focus === "navigation"
                          ? "Sections"
                          : (this.detail?.label ?? this.section),
                      true,
                  ),
              ];
        this.capacity = Math.max(
            1,
            computeFramedPanelViewportRows(height, {
                preludeRows: prelude.length,
                hasPanelTitles: true,
            }),
        );
        if (showContent && !this.detail) {
            const selectedStart = starts[this.selected] ?? 0;
            if (selectedStart < this.offset) this.offset = selectedStart;
            else if (selectedStart >= this.offset + this.capacity)
                this.offset = selectedStart - this.capacity + 1;
        }
        this.capacity = Math.min(
            this.capacity,
            Math.max(split ? navigation.length : 1, lines.length),
        );
        const viewport = slicePanelViewport(lines, this.offset, this.capacity);
        this.offset = viewport.offset;
        this.maxScroll = viewport.maxOffset;
        const navLines = split
            ? wrapPanelLines(navigation, resolved.layout.panelWidths[0])
            : [];
        return renderFramedPanels({
            theme: this.theme,
            title: `Sandbox · ${this.snapshot.resolved ? basename(this.snapshot.resolved.shell.projectRoot) : "Configuration problem"}`,
            layout: resolved.layout,
            prelude,
            panelTitles: titles,
            panelRows: viewport.lines.map((line, index) =>
                split ? [navLines[index] ?? "", line] : [line],
            ),
            footer: colors.muted(
                frameWidth < 64
                    ? this.detail
                        ? "Esc back · Tab panes"
                        : "Esc close · Tab panes"
                    : this.detail
                      ? "Esc back · Tab panes · ↑↓/PgUp/PgDn scroll"
                      : "Esc close · Tab panes · ↑↓ select · Enter open",
            ),
            maxHeight: height,
        });
    }
    private selectSection(direction: number): void {
        this.section =
            SANDBOX_SECTIONS[
                (SANDBOX_SECTIONS.indexOf(this.section) +
                    direction +
                    SANDBOX_SECTIONS.length) %
                    SANDBOX_SECTIONS.length
            ]!;
        this.selected = 0;
        this.detail = undefined;
        this.offset = 0;
        const snapshot = this.source.read();
        if (
            snapshot.runtime !== this.snapshot.runtime ||
            snapshot.resolved?.shell.sandboxFingerprint !==
                this.snapshot.resolved?.shell.sandboxFingerprint ||
            snapshot.resolved?.shell.mode !==
                this.snapshot.resolved?.shell.mode ||
            snapshot.error !== this.snapshot.error
        ) {
            this.refresh(snapshot);
            return;
        }
        this.snapshot = snapshot;
        if (this.section === "Doctor" && this.doctor.state === "idle")
            void this.inspect();
        this.tui.requestRender();
    }
    handleInput(data: string): void {
        if (this.settled || isKeyRelease(data)) return;
        if (matchesKey(data, Key.escape)) {
            if (this.detail) {
                this.detail = undefined;
                this.offset = 0;
                this.tui.requestRender();
            } else this.close();
            return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            this.focus = this.focus === "navigation" ? "content" : "navigation";
            this.offset = 0;
        } else if (matchesKey(data, Key.left)) {
            this.focus = "navigation";
            this.offset = 0;
        } else if (this.focus === "navigation") {
            if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
                this.selectSection(matchesKey(data, Key.up) ? -1 : 1);
                return;
            }
            if (!matchesKey(data, Key.right) && !matchesKey(data, Key.enter))
                return;
            this.focus = "content";
        } else if (this.detail) {
            let next = this.offset;
            if (matchesKey(data, Key.up)) next -= 1;
            else if (matchesKey(data, Key.down)) next += 1;
            else if (matchesKey(data, Key.pageUp)) next -= this.capacity;
            else if (matchesKey(data, Key.pageDown)) next += this.capacity;
            else if (matchesKey(data, Key.home)) next = 0;
            else if (matchesKey(data, Key.end)) next = this.maxScroll;
            else return;
            this.offset = Math.max(0, Math.min(next, this.maxScroll));
        } else if (matchesKey(data, Key.up))
            this.selected = Math.max(0, this.selected - 1);
        else if (matchesKey(data, Key.down))
            this.selected = Math.min(
                this.page().items.length - 1,
                this.selected + 1,
            );
        else if (matchesKey(data, Key.enter)) {
            const item = this.page().items[this.selected];
            if (item?.refresh) {
                this.refresh();
                return;
            }
            if (item?.details) {
                this.detail = item;
                this.offset = 0;
            } else if (item?.action) {
                this.close(item.action);
                return;
            }
        } else return;
        this.tui.requestRender();
    }
    private close(action?: SandboxDashboardAction): void {
        this.dispose();
        this.done(
            action
                ? {
                      action,
                      state: {
                          section: this.section,
                          executable: this.state.executable,
                      },
                  }
                : undefined,
        );
    }
}

export async function showSandboxDashboard(
    ctx: UiContext,
    source: SandboxDashboardSource,
    state: SandboxDashboardState,
): Promise<SandboxDashboardIntent | undefined> {
    let view: SandboxDashboard | undefined;
    try {
        return await ctx.ui.custom<SandboxDashboardIntent | undefined>(
            (tui, theme, _keys, done) =>
                (view = new SandboxDashboard(tui, theme, source, state, done)),
            {
                overlay: true,
                overlayOptions: { width: 96, maxHeight: 22, margin: 1 },
            },
        );
    } finally {
        view?.dispose();
    }
}
