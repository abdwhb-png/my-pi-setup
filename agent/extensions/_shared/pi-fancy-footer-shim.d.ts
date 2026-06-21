declare module "pi-fancy-footer/api" {
  import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
  } from "@earendil-works/pi-coding-agent";

  // ── Footer icon family ───────────────────────────────────────────────

  export type FooterIconFamily = "nerd" | "emoji" | "unicode" | "ascii";

  // ── Layout primitives ────────────────────────────────────────────────

  export type FooterWidgetAlign = "left" | "middle" | "right";
  export type FooterWidgetFill = "none" | "grow";
  export type FooterWidgetColor =
    | "text"
    | "accent"
    | "muted"
    | "dim"
    | "success"
    | "error"
    | "warning";

  // ── Icon type ────────────────────────────────────────────────────────

  /**
   * Icon for a fancy-footer widget.
   * Can be a literal string, a map per icon family, or a resolver function.
   */
  export type FancyFooterWidgetIcon =
    | string
    | Partial<Record<FooterIconFamily, string>>
    | ((iconFamily: FooterIconFamily) => string | undefined);

  // ── Widget render result ─────────────────────────────────────────────

  export type FancyFooterWidgetResult =
    | string
    | number
    | undefined
    | null
    | false
    | {
        text: string | number;
        icon?: FancyFooterWidgetIcon | false;
        textColor?: FooterWidgetColor;
        iconColor?: FooterWidgetColor;
        raw?: boolean;
      };

  // ── Render context ───────────────────────────────────────────────────

  export interface FooterWidgetEditorDefaults {
    row: number;
    position: number;
    align: FooterWidgetAlign;
    fill: FooterWidgetFill;
    minWidth?: number;
  }

  export type PullRequestCiState = "running" | "failed" | "okay";

  export interface GaugeColorsSnapshot {
    ok: FooterWidgetColor;
    warning: FooterWidgetColor;
    error: FooterWidgetColor;
  }

  export interface ProviderStatusWindow {
    label: string;
    leftPercent: number;
    usedPercent: number;
    resetAt?: number;
  }

  export type ProviderStatusState = "ok" | "warning" | "error" | "unavailable";

  export interface ProviderStatusSnapshot {
    provider: string;
    source: "api" | "headers" | "cache";
    fetchedAt: string;
    state: ProviderStatusState;
    primary?: ProviderStatusWindow;
    secondary?: ProviderStatusWindow;
    credits?: string;
    url?: string;
    error?: string;
  }

  export type ProviderStatusDisplay = "gauge" | "text";

  export interface ProviderStatusConfigSnapshot {
    refreshMs: number;
    cacheTtlMs: number;
    providers: readonly string[];
    display: ProviderStatusDisplay;
    showCredits: boolean;
    showReset: boolean;
  }

  export interface FooterMetrics {
    model: string;
    thinking: string;
    totalTokens: number;
    usedTokensForBar: number;
    totalK: number;
    totalCost: number;
    locationText: string;
    branch: string;
    commit: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    pullRequestUnresolvedReviewThreadCount: number;
    pullRequestCiState: PullRequestCiState | "";
    pullRequestCiUrl: string;
    added: number;
    removed: number;
    gitStatusSymbol: string;
    gitStatusText: string;
  }

  export interface WidgetRenderContext {
    width: number;
    theme: Theme;
    ctx: ExtensionContext;
    gaugeWidth: number;
    gaugeColors: GaugeColorsSnapshot;
    metrics: FooterMetrics;
    providerStatuses: readonly ProviderStatusSnapshot[];
    providerStatusConfig: Pick<
      ProviderStatusConfigSnapshot,
      "display" | "showCredits" | "showReset"
    >;
    defaultIconColor: FooterWidgetColor;
    defaultTextColor: FooterWidgetColor;
  }

  // ── Widget contribution ──────────────────────────────────────────────

  export interface FancyFooterWidgetContribution {
    id: string;
    label?: string;
    description?: string;
    /** Default row position on the footer (0 = top, 1 = bottom). */
    row?: number;
    /** Order within the aligned group (lower = earlier). Max 64. */
    order?: number;
    align?: FooterWidgetAlign;
    /** Whether the widget should grow to fill available space. */
    grow?: boolean;
    /** Minimum width in cells (when grow is true or fill is "grow"). */
    minWidth?: number;
    icon?: FancyFooterWidgetIcon | false;
    textColor?: FooterWidgetColor;
    styled?: boolean;
    /** Hide the widget when this returns false. */
    visible?: (ctx: WidgetRenderContext) => boolean;
    render: (
      ctx: WidgetRenderContext,
      availableWidth?: number,
    ) => FancyFooterWidgetResult;
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Identity helper for typing widget definitions.
   * Use to get type-checking on an inline widget object without declaring the type.
   */
  export function defineFancyFooterWidget<T extends FancyFooterWidgetContribution>(
    widget: T,
  ): T;

  export function contributeFancyFooterWidgets(
    pi: ExtensionAPI,
    provider:
      | FancyFooterWidgetContribution
      | readonly FancyFooterWidgetContribution[]
      | (() => FancyFooterWidgetContribution | readonly FancyFooterWidgetContribution[] | undefined)
      | undefined,
  ): void;

  export function requestFancyFooterWidgetDiscovery(pi: ExtensionAPI): void;
  export function requestFancyFooterRefresh(pi: ExtensionAPI): void;
}
