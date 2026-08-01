/**
 * Overlay ui components for subagents overview and detail views.
 *
 * - Implements Component interface from @earendil-works/pi-tui
 * - Uses ctx.ui.custom with overlay:true for centered, dismissible dialogs
 * - Uses shared box rendering for consistent header/footer styling
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { cycleFocus } from "../../_shared/ui/focus-navigation.ts";
import { BoxRenderer } from "../../_shared/ui/framed-box";
import {
    computePanelOverlayHeight,
    renderFramedPanelFallback,
    renderFramedPanels,
    renderPanelTitle,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "../../_shared/ui/framed-panels.ts";
import type { LiveRun, LiveRunSnapshot } from "./fleet-store.ts";
import { formatDuration, formatTokens } from "./live-ui.ts";

export const icon = "👥";

// ── Types ──────────────────────────────────────────────

interface ScrollState {
    scrollOffset: number;
}

export interface OverviewField {
    label: string;
    value: string;
}

export interface OverviewAgent {
    name: string;
    description: string;
    tools: string[];
    model: string;
    skills: string[];
    source: "builtin" | "user" | "project";
    context: string | null;
    overrideFields: OverviewField[];
}

export interface SubagentsOverviewData {
    agents: OverviewAgent[];
    overrides: Array<{
        agentName: string;
        fields: OverviewField[];
    }>;
    stats: {
        builtinCount: number;
        userCount: number;
        safeBashAgents: string[];
        plainBashAgents: string[];
        skillCount: number;
    };
}

type CatalogItem =
    | { kind: "agent"; agent: OverviewAgent }
    | { kind: "overrides" }
    | { kind: "stats" };

function isCloseInput(data: string): boolean {
    return matchesKey(data, "escape") || data === "q" || data === "Q";
}

function getScrollDelta(data: string): number | null {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) return -1;
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) return 1;
    if (matchesKey(data, Key.pageUp)) return -10;
    if (matchesKey(data, Key.pageDown)) return 10;
    return null;
}

// ── SubagentsOverviewView ────────────────────────────

export class SubagentsOverviewView implements Component {
    private contentLines: string[];
    private state: ScrollState;
    private tab: "catalog" | "live" = "catalog";
    private catalogFocus: "agents" | "details" = "agents";
    private selectedCatalogItem = 0;
    private catalogDetailOpen = false;
    private compactCatalog = false;
    private selectedRun = 0;
    private detailOpen = false;
    private cancelRefreshTimer: (() => void) | undefined;

    constructor(
        private config: {
            theme: Theme;
            content?: string;
            data?: SubagentsOverviewData;
            done: () => void;
            requestRender?: () => void;
            getTerminalRows?: () => number;
            getLiveSnapshot?: () => LiveRunSnapshot;
            now?: () => number;
            onRefresh?: () => void | Promise<void>;
            onAction?: (
                action: "steer" | "interrupt" | "stop",
                run: LiveRun,
            ) => void | Promise<void>;
            onLiveVisibilityChange?: (visible: boolean) => void;
            refreshMs?: number;
        },
    ) {
        this.contentLines = config.content?.split("\n") ?? [];
        this.state = { scrollOffset: 0 };
        if (config.getLiveSnapshot && config.onRefresh) {
            const refreshTimer = setInterval(() => {
                void config.onRefresh?.();
                config.requestRender?.();
            }, config.refreshMs ?? 500);
            this.cancelRefreshTimer = () => clearInterval(refreshTimer);
            refreshTimer.unref?.();
        }
        if (config.getLiveSnapshot) config.onLiveVisibilityChange?.(false);
    }

    private movePrimaryFocus(direction: -1 | 1): void {
        const current = this.tab === "live" ? "live" : this.catalogFocus;
        const next = cycleFocus(
            ["agents", "details", "live"] as const,
            current,
            direction,
        );

        this.detailOpen = false;
        this.state.scrollOffset = 0;
        if (next === "live") {
            this.tab = "live";
            this.catalogDetailOpen = false;
        } else {
            this.tab = "catalog";
            this.catalogFocus = next;
            this.catalogDetailOpen =
                this.compactCatalog && this.catalogFocus === "details";
        }
        this.config.onLiveVisibilityChange?.(this.tab === "live");
        this.config.requestRender?.();
    }

    handleInput(data: string): void {
        if (isCloseInput(data)) {
            if (this.detailOpen) {
                this.detailOpen = false;
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
            if (this.catalogDetailOpen) {
                this.catalogDetailOpen = false;
                this.catalogFocus = "agents";
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
            this.config.done();
            return;
        }

        const focusDirection =
            matchesKey(data, "tab") ||
            data === "\t" ||
            matchesKey(data, Key.right)
                ? 1
                : matchesKey(data, Key.left)
                  ? -1
                  : null;
        if (this.config.getLiveSnapshot && focusDirection !== null) {
            if (this.config.data) {
                this.movePrimaryFocus(focusDirection);
            } else {
                this.tab = cycleFocus(
                    ["catalog", "live"] as const,
                    this.tab,
                    focusDirection,
                );
                this.detailOpen = false;
                this.state.scrollOffset = 0;
                this.config.onLiveVisibilityChange?.(this.tab === "live");
                this.config.requestRender?.();
            }
            return;
        }

        if (this.tab === "live" && this.config.getLiveSnapshot) {
            const snapshot = this.config.getLiveSnapshot();
            if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
                this.selectedRun = Math.max(0, this.selectedRun - 1);
                this.detailOpen = false;
                this.config.requestRender?.();
                return;
            }
            if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
                this.selectedRun = Math.min(
                    Math.max(0, snapshot.runs.length - 1),
                    this.selectedRun + 1,
                );
                this.detailOpen = false;
                this.config.requestRender?.();
                return;
            }
            if (matchesKey(data, "return")) {
                if (snapshot.runs[this.selectedRun]) {
                    this.detailOpen = !this.detailOpen;
                    this.state.scrollOffset = 0;
                    this.config.requestRender?.();
                }
                return;
            }
            const action =
                data === "s"
                    ? "steer"
                    : data === "i"
                      ? "interrupt"
                      : data === "x"
                        ? "stop"
                        : undefined;
            const run = snapshot.runs[this.selectedRun];
            if (action && run?.source === "async" && run.controllable) {
                void this.config.onAction?.(action, run);
                return;
            }
        }

        if (this.tab === "catalog" && this.config.data) {
            const items = this.catalogItems();
            if (
                this.catalogFocus === "agents" &&
                (matchesKey(data, Key.up) || matchesKey(data, "k"))
            ) {
                this.selectedCatalogItem = Math.max(
                    0,
                    this.selectedCatalogItem - 1,
                );
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
            if (
                this.catalogFocus === "agents" &&
                (matchesKey(data, Key.down) || matchesKey(data, "j"))
            ) {
                this.selectedCatalogItem = Math.min(
                    Math.max(0, items.length - 1),
                    this.selectedCatalogItem + 1,
                );
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
            if (matchesKey(data, "return") && this.catalogFocus === "agents") {
                this.catalogFocus = "details";
                this.catalogDetailOpen = this.compactCatalog;
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
        }

        const delta = getScrollDelta(data);
        if (
            delta !== null &&
            (!this.config.data ||
                this.tab === "live" ||
                this.catalogFocus === "details")
        ) {
            this.state = {
                ...this.state,
                scrollOffset: Math.max(0, this.state.scrollOffset + delta),
            };
            this.config.requestRender?.();
        }
    }

    invalidate(): void {
        this.config.requestRender?.();
    }

    dispose(): void {
        this.cancelRefreshTimer?.();
        this.cancelRefreshTimer = undefined;
        this.config.onLiveVisibilityChange?.(false);
    }

    render(width: number): string[] {
        if (!this.config.data) return this.renderLegacy(width);
        return this.renderStructured(width);
    }

    private renderLegacy(width: number): string[] {
        const { theme } = this.config;
        const box = new BoxRenderer(theme, width);
        const hasLive = this.config.getLiveSnapshot !== undefined;
        const tabLabel = this.tab === "catalog" ? "Catalog" : "Live";
        box.setTitle(
            `${icon}Subagents Overview${hasLive ? ` · ${tabLabel}` : ""} `,
        );
        box.setContent(
            hasLive
                ? this.tab === "catalog"
                    ? ["[Catalog]  Live", "", ...this.contentLines]
                    : this.renderLiveContent()
                : this.contentLines,
        );
        box.scrollTo(this.state.scrollOffset);
        box.setFooter(
            hasLive
                ? this.tab === "catalog"
                    ? "[Tab/←→] Live  [↑↓/PgUp/PgDn] Scroll  [q/Esc] Close"
                    : this.detailOpen
                      ? "[Enter/Esc] Back  [PgUp/PgDn] Scroll  [q] Close"
                      : "[Tab/←→] Catalog  [↑↓] Select  [Enter] Details  [q/Esc] Close"
                : "[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close",
        );
        return box.render();
    }

    private catalogItems(): CatalogItem[] {
        const agents = this.config.data?.agents ?? [];
        return [
            ...agents.map((agent): CatalogItem => ({ kind: "agent", agent })),
            { kind: "overrides" },
            { kind: "stats" },
        ];
    }

    private catalogRosterLines(bodyHeight: number): string[] {
        const { theme } = this.config;
        const items = this.catalogItems();
        this.selectedCatalogItem = Math.min(
            this.selectedCatalogItem,
            Math.max(0, items.length - 1),
        );
        const lines = items.map((item, index) => {
            const marker = index === this.selectedCatalogItem ? "▸" : " ";
            if (item.kind === "agent") {
                const source =
                    item.agent.source === "builtin"
                        ? "B"
                        : item.agent.source === "user"
                          ? "U"
                          : "P";
                const label = `${marker} ${source} ${item.agent.name}`;
                return index === this.selectedCatalogItem
                    ? theme.fg("accent", theme.bold(label))
                    : label;
            }
            const label =
                item.kind === "overrides"
                    ? `${marker} ⚙ Active overrides`
                    : `${marker} ◫ Quick stats`;
            return index === this.selectedCatalogItem
                ? theme.fg("accent", theme.bold(label))
                : theme.fg("muted", label);
        });
        const maxOffset = Math.max(0, lines.length - bodyHeight);
        const offset = Math.min(
            maxOffset,
            Math.max(0, this.selectedCatalogItem - bodyHeight + 1),
        );
        return lines.slice(offset, offset + bodyHeight);
    }

    private catalogDetailLines(): string[] {
        const data = this.config.data;
        if (!data) return ["Catalog unavailable."];
        const item = this.catalogItems()[this.selectedCatalogItem];
        if (!item) return ["No catalog entries."];

        if (item.kind === "overrides") {
            if (data.overrides.length === 0) {
                return [
                    this.config.theme.bold("Active overrides"),
                    "",
                    "No overrides configured.",
                ];
            }
            return [
                this.config.theme.bold("Active overrides"),
                "",
                ...data.overrides.flatMap((override) => [
                    this.config.theme.fg("accent", override.agentName),
                    ...override.fields.map(
                        (field) => `  ${field.label}: ${field.value}`,
                    ),
                    "",
                ]),
            ];
        }

        if (item.kind === "stats") {
            const total = data.stats.builtinCount + data.stats.userCount;
            return [
                this.config.theme.bold("Quick stats"),
                "",
                `Agents: ${total}`,
                `Builtin: ${data.stats.builtinCount}`,
                `User: ${data.stats.userCount}`,
                `Safe bash: ${data.stats.safeBashAgents.join(", ") || "none"}`,
                `Plain bash: ${data.stats.plainBashAgents.join(", ") || "none"}`,
                `Skills referenced: ${data.stats.skillCount}`,
            ];
        }

        const agent = item.agent;
        return [
            this.config.theme.bold(agent.name),
            this.config.theme.fg(
                "muted",
                agent.description || "No description.",
            ),
            "",
            `Source: ${agent.source}`,
            `Model: ${agent.model}`,
            `Context: ${agent.context ?? "—"}`,
            `Tools: ${agent.tools.join(", ") || "—"}`,
            `Skills: ${agent.skills.join(", ") || "—"}`,
            ...(agent.overrideFields.length > 0
                ? [
                      "",
                      this.config.theme.fg("warning", "Override"),
                      ...agent.overrideFields.map(
                          (field) => `  ${field.label}: ${field.value}`,
                      ),
                  ]
                : []),
        ];
    }

    private panelTitle(label: string, active: boolean): string {
        return renderPanelTitle(this.config.theme, label, active);
    }

    private renderStructured(width: number): string[] {
        const { theme } = this.config;
        const frameWidth = Math.max(1, width - 4);
        const rows = this.config.getTerminalRows?.() ?? 32;
        const maxHeight = computePanelOverlayHeight(rows);
        if (frameWidth < 32) {
            return renderFramedPanelFallback({
                theme,
                width: frameWidth,
                maxHeight: Math.min(3, maxHeight),
                title: `${icon} Subagents Overview`,
                message: "Subagents overview needs ≥36 columns.",
                footer: "q/Esc close",
            });
        }
        const bodyHeight = Math.max(1, maxHeight - 6);
        const resolved = resolveResponsivePanelLayout(frameWidth, [
            {
                mode: "compact",
                minWidth: 32,
                panels: [{ minWidth: 30 }],
            },
            {
                mode: "wide",
                minWidth: 72,
                panels: [
                    { minWidth: 24, maxWidth: 30 },
                    { minWidth: 36, weight: 2 },
                ],
            },
        ] as const);
        if (!resolved) return ["Subagents overview cannot fit."];
        if (maxHeight < 7) {
            return renderFramedPanelFallback({
                theme,
                width: frameWidth,
                maxHeight,
                title: `${icon} Subagents Overview`,
                message: `${this.tab === "catalog" ? "Catalog" : "Live"} · q/Esc close`,
            });
        }
        const catalogLayout =
            this.tab === "catalog" && resolved.mode === "wide"
                ? resolved.layout
                : null;
        this.compactCatalog = this.tab === "catalog" && catalogLayout === null;
        const tabs =
            this.tab === "catalog"
                ? `${this.panelTitle("CATALOG", true)}   ${this.panelTitle("LIVE", false)}`
                : `${this.panelTitle("CATALOG", false)}   ${this.panelTitle("LIVE", true)}`;
        const layout =
            catalogLayout ??
            resolveResponsivePanelLayout(frameWidth, [
                { mode: "single", minWidth: 32, panels: [{ minWidth: 30 }] },
            ] as const)?.layout;
        if (!layout) return ["Subagents overview cannot fit."];
        let panelTitles: readonly string[];
        const panelRows: string[][] = [];

        if (this.tab === "catalog") {
            const showDetail = catalogLayout !== null || this.catalogDetailOpen;
            panelTitles = catalogLayout
                ? [
                      this.panelTitle("AGENTS", this.catalogFocus === "agents"),
                      this.panelTitle(
                          "DETAILS",
                          this.catalogFocus === "details",
                      ),
                  ]
                : [this.panelTitle(showDetail ? "DETAILS" : "AGENTS", true)];

            const roster = wrapPanelLines(
                this.catalogRosterLines(bodyHeight),
                layout.panelWidths[0],
            );
            const detailWidth =
                catalogLayout?.panelWidths[1] ?? layout.panelWidths[0];
            const detail = wrapPanelLines(
                this.catalogDetailLines(),
                detailWidth,
            );
            const detailViewport = slicePanelViewport(
                detail,
                this.state.scrollOffset,
                bodyHeight,
            );
            this.state.scrollOffset = detailViewport.offset;
            for (let index = 0; index < bodyHeight; index++) {
                panelRows.push(
                    catalogLayout
                        ? [
                              roster[index] ?? "",
                              detailViewport.lines[index] ?? "",
                          ]
                        : [
                              showDetail
                                  ? (detailViewport.lines[index] ?? "")
                                  : (roster[index] ?? ""),
                          ],
                );
            }
        } else {
            panelTitles = [
                this.panelTitle(this.detailOpen ? "TRANSCRIPT" : "RUNS", true),
            ];
            const live = wrapPanelLines(
                this.renderLiveContent(),
                layout.panelWidths[0],
            );
            const liveViewport = slicePanelViewport(
                live,
                this.state.scrollOffset,
                bodyHeight,
            );
            this.state.scrollOffset = liveViewport.offset;
            for (let index = 0; index < bodyHeight; index++) {
                panelRows.push([liveViewport.lines[index] ?? ""]);
            }
        }

        const footer =
            this.tab === "live"
                ? this.detailOpen
                    ? "Enter/Esc back · PgUp/PgDn scroll · q close"
                    : "↑↓ select · Enter details · Tab catalog · q/Esc close"
                : this.compactCatalog
                  ? this.catalogDetailOpen
                      ? "↑↓/PgUp/PgDn scroll · Tab/←→ focus · Esc back · q close"
                      : "↑↓ select · Enter details · Tab/←→ focus · q/Esc close"
                  : this.catalogFocus === "details"
                    ? "↑↓/PgUp/PgDn scroll · Tab/←→ focus · q/Esc close"
                    : "↑↓ select · Tab/←→ focus · q/Esc close";
        return renderFramedPanels({
            theme,
            title: `${icon} Subagents Overview`,
            layout,
            prelude: [tabs],
            panelTitles,
            panelRows,
            footer,
        });
    }

    private renderLiveContent(): string[] {
        const snapshot = this.config.getLiveSnapshot?.();
        if (!snapshot) return ["Live data unavailable."];
        this.selectedRun = Math.min(
            this.selectedRun,
            Math.max(0, snapshot.runs.length - 1),
        );
        const capability = snapshot.fleetAvailable
            ? `${snapshot.totalActive} active${snapshot.omitted > 0 ? ` · +${snapshot.omitted} omitted` : ""}`
            : "Fleet RPC unavailable · showing tracked async runs only";
        const lines = [this.config.theme.fg("dim", capability), ""];
        if (snapshot.runs.length === 0) {
            lines.push("No subagent runs in this session.");
            return lines;
        }
        const selected = snapshot.runs[this.selectedRun];
        if (this.detailOpen && selected) {
            return [...lines, ...this.renderRunDetail(selected)];
        }
        const now = this.config.now?.() ?? Date.now();
        for (const [index, run] of snapshot.runs.entries()) {
            const marker = index === this.selectedRun ? "›" : " ";
            const state = run.source === "fleet" ? "active" : run.state;
            const durationEnd =
                run.source === "async" && run.completedAt !== undefined
                    ? run.completedAt
                    : now;
            lines.push(
                `${marker} ${run.agent}${run.role ? `:${run.role}` : ""}  ${state}  ${formatDuration(durationEnd - run.startedAt)}  ${formatTokens(run.tokens.total)}`,
            );
            if (run.goal)
                lines.push(`    ${this.config.theme.fg("dim", run.goal)}`);
            if (index === this.selectedRun) {
                lines.push(
                    run.source === "fleet"
                        ? `    ${this.config.theme.fg("warning", "Foreground transcript: Ctrl+Alt+F")}`
                        : run.controllable
                          ? `    ${this.config.theme.fg("accent", "Enter transcript · s steer · i interrupt · x stop")}`
                          : `    ${this.config.theme.fg("dim", "Enter transcript")}`,
                );
            }
            lines.push("");
        }
        return lines;
    }

    private renderRunDetail(run: LiveRun): string[] {
        const lines = [
            `${this.config.theme.bold(run.agent)}${run.role ? ` · ${run.role}` : ""}`,
            `State: ${run.source === "fleet" ? "active" : run.state}`,
            `Model: ${run.model ?? "—"}`,
            `Effort: ${run.effort ?? "—"}`,
            `Tokens: ${run.tokens.input} in · ${run.tokens.output} out · ${run.tokens.total} total`,
            ...(run.goal ? [`Goal: ${run.goal}`] : []),
            "",
        ];
        if (run.source === "fleet") {
            lines.push(
                "This foreground entry exposes display metadata only.",
                "Open the native inspector with Ctrl+Alt+F for its transcript.",
            );
            return lines;
        }
        if (run.activity) lines.push(`Activity: ${run.activity}`);
        if (run.currentTool) lines.push(`Current tool: ${run.currentTool}`);
        if (run.summary) lines.push(`Summary: ${run.summary}`);
        lines.push("", "Transcript", "──────────");
        lines.push(
            ...(run.transcript?.split("\n") ?? ["No transcript output yet."]),
        );
        return lines;
    }
}

// ── AgentDetailView ──────────────────────────────────

export class AgentDetailView implements Component {
    private contentLines: string[];
    private state: ScrollState;

    constructor(
        private config: {
            theme: Theme;
            content: string;
            agentName: string;
            done: () => void;
            requestRender?: () => void;
        },
    ) {
        this.contentLines = config.content.split("\n");
        this.state = { scrollOffset: 0 };
    }

    handleInput(data: string): void {
        if (isCloseInput(data)) {
            this.config.done();
            return;
        }

        const delta = getScrollDelta(data);
        if (delta !== null) {
            this.state = {
                ...this.state,
                scrollOffset: Math.max(0, this.state.scrollOffset + delta),
            };
            this.config.requestRender?.();
        }
    }

    invalidate(): void {
        // Static content, nothing to invalidate
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const box = new BoxRenderer(theme, width, { viewportHeight: 20 });
        box.setTitle(` 🧬 Agent: ${this.config.agentName} `);
        box.setContent(this.contentLines);
        box.scrollTo(this.state.scrollOffset);
        box.setFooter("[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close");
        return box.render();
    }
}
