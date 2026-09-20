import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type Component, matchesKey } from "@earendil-works/pi-tui";
import {
    createUiColors,
    type UiColorsCreation,
} from "../../_shared/ui/ui-colors.ts";
import { loadAiProvidersConfig } from "../config.ts";

export function registerProvidersCommand(pi: ExtensionAPI): void {
    pi.registerCommand("providers", {
        description:
            "View AI providers and models (auth status, enablement, details)",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify(
                    "The /providers command requires TUI mode.",
                    "warning",
                );
                return;
            }

            const cwd = process.cwd();
            const config = loadAiProvidersConfig(cwd);
            const allModels = ctx.modelRegistry.getAll();

            // Extract all unique providers from registered models
            const modelProviders = Array.from(
                new Set(allModels.map((m) => m.provider)),
            );

            // Extract providers from ai-providers config (even if no models registered yet)
            const configProviders = Object.keys(config.providers);

            // Union of all known providers
            const allProviders = Array.from(
                new Set([...modelProviders, ...configProviders]),
            ).sort();

            if (allProviders.length === 0) {
                ctx.ui.notify("No providers found.", "info");
                return;
            }

            // Gather provider status data
            const providerStatusMap = new Map<string, ProviderStatus>();

            const extensionManagedProviders: string[] = [];
            const builtInProviders: string[] = [];

            for (const provider of allProviders) {
                const displayName =
                    ctx.modelRegistry.getProviderDisplayName(provider) ||
                    provider;
                const authStatusObj =
                    ctx.modelRegistry.getProviderAuthStatus(provider);
                const authStatus = authStatusObj.configured
                    ? "Ready"
                    : "Missing/Not Configured";
                const modelCount = allModels.filter(
                    (m) => m.provider === provider,
                ).length;
                const isEnabledInConfig = config.providers[provider];
                const isExtensionManaged = configProviders.includes(provider);

                providerStatusMap.set(provider, {
                    displayName,
                    authStatus,
                    modelCount,
                    isEnabledInConfig,
                    isExtensionManaged,
                });

                if (isExtensionManaged) {
                    extensionManagedProviders.push(provider);
                } else {
                    builtInProviders.push(provider);
                }
            }

            // Sort: Auth Ready first, then alphabetical
            const sortProviders = (a: string, b: string) => {
                const authA =
                    providerStatusMap.get(a)!.authStatus === "Ready" ? 1 : 0;
                const authB =
                    providerStatusMap.get(b)!.authStatus === "Ready" ? 1 : 0;
                if (authA !== authB) return authB - authA;
                return a.localeCompare(b);
            };

            extensionManagedProviders.sort(sortProviders);
            builtInProviders.sort(sortProviders);

            type LeftPaneRow =
                | { type: "header"; title: string }
                | { type: "provider"; id: string };
            const leftPaneRows: LeftPaneRow[] = [];

            if (extensionManagedProviders.length > 0) {
                leftPaneRows.push({
                    type: "header",
                    title: "--- Custom / Extension Managed ---",
                });
                extensionManagedProviders.forEach((p) =>
                    leftPaneRows.push({ type: "provider", id: p }),
                );
            }
            if (builtInProviders.length > 0) {
                if (leftPaneRows.length > 0)
                    leftPaneRows.push({ type: "header", title: "" });
                leftPaneRows.push({
                    type: "header",
                    title: "--- Built-in Providers ---",
                });
                builtInProviders.forEach((p) =>
                    leftPaneRows.push({ type: "provider", id: p }),
                );
            }

            await ctx.ui.custom<void>(
                (tui, theme, _keybindings, done) => {
                    const uiColors = createUiColors(theme);
                    const dashboard = new ProviderDashboard(
                        leftPaneRows,
                        providerStatusMap,
                        allModels,
                        uiColors,
                        done,
                        config.maxVisibleRows ?? 20,
                    );

                    // Wrap in a container with a border
                    const container = new Container();
                    container.addChild(
                        new DynamicBorder((s: string) => uiColors.primary(s)),
                    );
                    container.addChild(dashboard);
                    container.addChild(
                        new DynamicBorder((s: string) => uiColors.primary(s)),
                    );

                    return {
                        render: (w) => container.render(w),
                        invalidate: () => container.invalidate(),
                        handleInput: (data) => {
                            dashboard.handleInput(data);
                            tui.requestRender();
                        },
                    };
                },
                {
                    overlay: true,
                    overlayOptions: {
                        width: "90%",
                        maxHeight: "80%",
                        margin: 2,
                    },
                },
            );
        },
    });
}

type LeftPaneRow =
    | { type: "header"; title: string }
    | { type: "provider"; id: string };

interface ProviderStatus {
    displayName: string;
    authStatus: string;
    modelCount: number;
    isEnabledInConfig: boolean | undefined;
    isExtensionManaged: boolean;
}

class ProviderDashboard implements Component {
    private leftPaneRows: LeftPaneRow[];
    private providerStatusMap: Map<string, ProviderStatus>;
    private allModels: Model<Api>[];
    private uiColors: UiColorsCreation;
    private done: () => void;
    private maxVisible: number;

    private focusedPane: "left" | "right" = "left";
    private leftIndex = 0;
    private rightIndex = 0;
    private viewingModelDetails = false;

    private currentProviderModels: Model<Api>[] = [];

    constructor(
        leftPaneRows: LeftPaneRow[],
        providerStatusMap: Map<string, ProviderStatus>,
        allModels: Model<Api>[],
        uiColors: UiColorsCreation,
        done: () => void,
        maxVisible: number,
    ) {
        this.leftPaneRows = leftPaneRows;
        this.providerStatusMap = providerStatusMap;
        this.allModels = allModels;
        this.uiColors = uiColors;
        this.done = done;
        this.maxVisible = maxVisible;

        // Initialize leftIndex to the first actual provider
        this.leftIndex = this.leftPaneRows.findIndex(
            (r) => r.type === "provider",
        );
        if (this.leftIndex === -1) this.leftIndex = 0; // Fallback

        this.updateModelsList();
    }

    private updateModelsList() {
        const row = this.leftPaneRows[this.leftIndex];
        if (row && row.type === "provider") {
            const providerId = row.id;
            this.currentProviderModels = this.allModels.filter(
                (m) => m.provider === providerId,
            );
            this.currentProviderModels.sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } else {
            this.currentProviderModels = [];
        }
        this.rightIndex = 0;
    }

    private moveLeftIndex(direction: 1 | -1) {
        let newIndex = this.leftIndex + direction;

        // Wrap around
        if (newIndex < 0) {
            newIndex = this.leftPaneRows.length - 1;
        } else if (newIndex >= this.leftPaneRows.length) {
            newIndex = 0;
        }

        // Find the nearest provider in the direction
        for (let i = 0; i < this.leftPaneRows.length; i++) {
            if (this.leftPaneRows[newIndex].type === "provider") {
                this.leftIndex = newIndex;
                this.updateModelsList();
                break;
            }
            newIndex = newIndex + direction;
            if (newIndex < 0) newIndex = this.leftPaneRows.length - 1;
            if (newIndex >= this.leftPaneRows.length) newIndex = 0;
        }
    }

    private requireProviderStatus(providerId: string): ProviderStatus {
        const status = this.providerStatusMap.get(providerId);
        if (!status) {
            throw new Error(`Missing provider status for ${providerId}`);
        }
        return status;
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.done();
            return;
        }

        if (this.focusedPane === "left") {
            if (matchesKey(data, "down")) {
                this.moveLeftIndex(1);
            } else if (matchesKey(data, "up")) {
                this.moveLeftIndex(-1);
            } else if (matchesKey(data, "right") || matchesKey(data, "enter")) {
                if (this.currentProviderModels.length > 0) {
                    this.focusedPane = "right";
                    this.viewingModelDetails = false;
                }
            }
        } else {
            // focusedPane === "right"
            if (this.viewingModelDetails) {
                if (
                    matchesKey(data, "left") ||
                    matchesKey(data, "escape") ||
                    matchesKey(data, "backspace")
                ) {
                    this.viewingModelDetails = false;
                }
            } else {
                if (matchesKey(data, "down")) {
                    this.rightIndex = this.rightIndex + 1;
                    if (this.rightIndex >= this.currentProviderModels.length)
                        this.rightIndex = 0;
                } else if (matchesKey(data, "up")) {
                    this.rightIndex = this.rightIndex - 1;
                    if (this.rightIndex < 0)
                        this.rightIndex = Math.max(
                            0,
                            this.currentProviderModels.length - 1,
                        );
                } else if (
                    matchesKey(data, "left") ||
                    matchesKey(data, "escape")
                ) {
                    this.focusedPane = "left";
                } else if (matchesKey(data, "enter")) {
                    if (this.currentProviderModels.length > 0) {
                        this.viewingModelDetails = true;
                    }
                }
            }
        }
    }

    invalidate(): void {}

    render(width: number): string[] {
        const leftWidth = Math.floor(width * 0.4) - 1;
        const rightWidth = width - leftWidth - 3;

        const lines: string[] = [];
        const maxVisible = this.maxVisible;

        const leftProviderCount = this.leftPaneRows.filter(
            (r) => r.type === "provider",
        ).length;
        // Count which provider we are on logically (1-based)
        let logicalLeftPos = 0;
        for (let i = 0; i <= this.leftIndex; i++) {
            if (this.leftPaneRows[i]?.type === "provider") logicalLeftPos++;
        }

        const rightCount = this.currentProviderModels.length;
        const logicalRightPos = rightCount > 0 ? this.rightIndex + 1 : 0;

        const leftHeaderTitle = ` AI Providers [${logicalLeftPos}/${leftProviderCount}] `;
        const rightHeaderTitle = this.viewingModelDetails
            ? ` Model Configuration `
            : ` Registered Models [${logicalRightPos}/${rightCount}] `;

        // Header row
        const headerLeft = this.padToWidth(
            this.uiColors.primary(leftHeaderTitle),
            leftWidth,
        );
        const headerRight = this.padToWidth(
            this.uiColors.primary(rightHeaderTitle),
            rightWidth,
        );
        lines.push(
            `${headerLeft} ${this.uiColors.separator("│")} ${headerRight}`,
        );

        const divLeft = this.uiColors.separator("─".repeat(leftWidth));
        const divRight = this.uiColors.separator("─".repeat(rightWidth));
        lines.push(`${divLeft} ${this.uiColors.separator("┼")} ${divRight}`);

        // Left Pane Windowing
        const leftStart = Math.max(
            0,
            Math.min(
                this.leftIndex - Math.floor(maxVisible / 2),
                this.leftPaneRows.length - maxVisible,
            ),
        );
        // Right Pane Windowing
        const rightStart = Math.max(
            0,
            Math.min(
                this.rightIndex - Math.floor(maxVisible / 2),
                this.currentProviderModels.length - maxVisible,
            ),
        );

        // Pre-compute right details lines if viewing details
        const detailsLines: string[] = [];
        if (this.viewingModelDetails && this.currentProviderModels.length > 0) {
            const m = this.currentProviderModels[this.rightIndex];
            detailsLines.push(`  ${this.uiColors.primary("ID:")} ${m.id}`);
            detailsLines.push(`  ${this.uiColors.primary("Name:")} ${m.name}`);
            detailsLines.push(
                `  ${this.uiColors.primary("Context Window:")} ${m.contextWindow}`,
            );
            detailsLines.push(
                `  ${this.uiColors.primary("Max Output Tokens:")} ${m.maxTokens}`,
            );
            if (m.cost) {
                detailsLines.push(
                    `  ${this.uiColors.primary("Cost Input:")} $${m.cost.input}/M tokens`,
                );
                detailsLines.push(
                    `  ${this.uiColors.primary("Cost Output:")} $${m.cost.output}/M tokens`,
                );
            }
            detailsLines.push(
                `  ${this.uiColors.primary("Inputs Supported:")} ${m.input?.join(", ") || "text"}`,
            );
            detailsLines.push(
                `  ${this.uiColors.primary("Supports Reasoning:")} ${m.reasoning ? "Yes" : "No"}`,
            );
            if (m.compat) {
                const supportsDeveloperRole =
                    "supportsDeveloperRole" in m.compat &&
                    m.compat.supportsDeveloperRole === true;
                detailsLines.push(
                    `  ${this.uiColors.primary("Developer Role:")} ${supportsDeveloperRole ? "Yes" : "No"}`,
                );
            }
        }

        // Content rows
        for (let offset = 0; offset < maxVisible; offset++) {
            let leftContent = " ".repeat(leftWidth);
            const iLeft = leftStart + offset;

            if (iLeft < this.leftPaneRows.length) {
                const row = this.leftPaneRows[iLeft];

                if (row.type === "header") {
                    const titleStr = row.title
                        ? this.uiColors.subtle(row.title)
                        : "";
                    leftContent = this.padToWidth(titleStr, leftWidth);
                } else {
                    const providerId = row.id;
                    const s = this.requireProviderStatus(providerId);
                    const isSelected = iLeft === this.leftIndex;

                    let enableStr = "";
                    if (s.isExtensionManaged) {
                        enableStr =
                            s.isEnabledInConfig === false
                                ? this.uiColors.subtle("[Disabled]")
                                : this.uiColors.success("[Enabled]");
                    }

                    const authStr =
                        s.authStatus === "Ready"
                            ? this.uiColors.success("✓")
                            : this.uiColors.danger("✗");

                    const prefix =
                        isSelected && this.focusedPane === "left" ? "▶ " : "  ";
                    let text = `${prefix}${authStr} ${s.displayName} ${enableStr}`;

                    let rawLen = 2 + 1 + 1 + s.displayName.length;
                    if (enableStr)
                        rawLen += s.isEnabledInConfig === false ? 11 : 10;

                    const padding = Math.max(0, leftWidth - rawLen);
                    text += " ".repeat(padding);

                    if (isSelected && this.focusedPane === "left") {
                        leftContent = `[${text.substring(1, text.length - 1)}]`;
                    } else {
                        leftContent = text;
                    }
                }
            }

            let rightContent = " ".repeat(rightWidth);

            if (this.viewingModelDetails) {
                if (offset < detailsLines.length) {
                    rightContent = this.padToWidth(
                        detailsLines[offset],
                        rightWidth,
                    );
                }
            } else {
                const iRight = rightStart + offset;

                if (iRight < this.currentProviderModels.length) {
                    const m = this.currentProviderModels[iRight];
                    const isSelected = iRight === this.rightIndex;

                    const ctxWindow = m.contextWindow
                        ? `${Math.round(m.contextWindow / 1024)}k ctx`
                        : "";
                    const prefix =
                        isSelected && this.focusedPane === "right"
                            ? "▶ "
                            : "  ";

                    const nameStr = this.uiColors.model(m.name);
                    const metaStr = this.uiColors.meta(ctxWindow);

                    const rawLen =
                        2 +
                        m.name.length +
                        1 +
                        (ctxWindow ? ctxWindow.length : 0);
                    const padding = Math.max(0, rightWidth - rawLen);

                    const text =
                        `${prefix}${nameStr} ${metaStr}` + " ".repeat(padding);

                    if (isSelected && this.focusedPane === "right") {
                        rightContent = `[${text.substring(1, text.length - 1)}]`;
                    } else {
                        rightContent = text;
                    }
                } else if (
                    iRight === 0 &&
                    this.currentProviderModels.length === 0
                ) {
                    rightContent = this.padToWidth(
                        this.uiColors.subtle("  No models registered"),
                        rightWidth,
                    );
                }
            }

            lines.push(
                `${leftContent} ${this.uiColors.separator("│")} ${rightContent}`,
            );
        }

        // Footer Hints Row
        const hintsText = this.viewingModelDetails
            ? "  ←/esc back to models  •  q close"
            : "  ↑↓ navigate  •  → focus models  •  ← focus providers  •  enter show config  •  esc/q close";
        const hints = this.uiColors.subtle(hintsText);
        lines.push(this.uiColors.separator("─".repeat(width)));
        lines.push(this.padToWidth(hints, width));

        return lines;
    }

    private padToWidth(textWithAnsi: string, targetWidth: number): string {
        // Quick and dirty pad. Doesn't perfectly account for ANSI length if text is short,
        // but works if we assume the text itself is less than width and we just append spaces.
        // A real implementation uses stringLength from string-width.
        // For now we'll just return it and assume caller handles exact spacing or terminal handles it.
        // We'll use a crude regex to strip ANSI for length calc.
        const ansiRegex = /\x1b\[[0-9;]*m/g;
        const rawLen = textWithAnsi.replace(ansiRegex, "").length;
        if (rawLen >= targetWidth) return textWithAnsi;
        return textWithAnsi + " ".repeat(targetWidth - rawLen);
    }
}
