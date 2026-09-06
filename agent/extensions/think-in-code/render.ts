import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import {
    parseThinkArtifactSearchFailurePayload,
    parseThinkExecuteHeader,
    parseThinkFailurePayload,
} from "./public-contract.ts";

interface RenderContext {
    lastComponent?: Component;
}

interface RenderOptions {
    expanded: boolean;
}

interface RenderResult {
    content?: unknown;
    details?: unknown;
}

type ThinkRenderArgs = Record<string, unknown>;

function asArgs(value: unknown): ThinkRenderArgs {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as ThinkRenderArgs)
        : {};
}

function textComponent(context: RenderContext, value: string): Text {
    const component =
        context.lastComponent instanceof Text
            ? context.lastComponent
            : new Text("", 0, 0);
    component.setText(value);
    return component;
}

function firstText(content: unknown, index = 0): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const item = content[index];
    if (typeof item !== "object" || item === null) return undefined;
    const value = Reflect.get(item, "text");
    return Reflect.get(item, "type") === "text" && typeof value === "string"
        ? value
        : undefined;
}

function bounded(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n… (${value.length - limit} caractères masqués)`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

function programSummary(args: ThinkRenderArgs, expanded: boolean): string {
    const program = typeof args.program === "string" ? args.program : "…";
    return bounded(program, expanded ? 2_000 : 180);
}

export function renderThinkExecuteCall(
    value: unknown,
    theme: Theme,
    context: RenderContext,
): Component {
    const args = asArgs(value);
    const action = typeof args.action === "string" ? args.action : "…";
    const language = typeof args.language === "string" ? args.language : "…";
    const expanded = Reflect.get(context, "expanded") === true;
    const lines = [
        theme.fg("toolTitle", theme.bold(`🧠 Think Execute · ${action}`)),
        theme.fg("muted", `analyseur: ${language}`),
        theme.fg("toolOutput", programSummary(args, expanded)),
    ];
    return textComponent(context, lines.join("\n"));
}

export function renderThinkExecuteResult(
    result: RenderResult,
    options: RenderOptions,
    theme: Theme,
    context: RenderContext,
    retentionHours: number,
): Component {
    const failure = parseThinkFailurePayload(result.content);
    if (failure) {
        const lines = [
            theme.fg(
                "error",
                `✗ error · ${failure.action} · ${failure.stage} · ${failure.code}`,
            ),
            theme.fg("muted", `récupération: ${failure.recovery}`),
        ];
        if (options.expanded) {
            lines.push(theme.fg("toolOutput", bounded(failure.reason, 2_000)));
        }
        return textComponent(context, lines.join("\n"));
    }

    const header = parseThinkExecuteHeader(result.content);
    if (!header) {
        return textComponent(
            context,
            theme.fg("error", "✗ résultat Think illisible"),
        );
    }

    const archiveLabel = `${header.archiveIds.length} archive${header.archiveIds.length === 1 ? "" : "s"}`;
    const batch =
        header.total === undefined
            ? ""
            : ` · batch ${header.succeeded ?? 0}/${header.total}`;
    const indexLabel =
        header.indexStatus === "indexed"
            ? "indexé"
            : header.indexStatus === "failed"
              ? "indexation échouée"
              : "indexation inconnue";
    const lines = [
        theme.fg(
            header.status === "success" ? "success" : "warning",
            `${header.status === "success" ? "✓" : "!"} ${header.status} · ${header.action}${batch}`,
        ),
        theme.fg(
            "muted",
            `${formatBytes(header.sourceBytes)} → ${formatBytes(header.resultBytes)} · ${archiveLabel} · ${indexLabel} · expiration ≤${retentionHours}h${header.truncated ? " · tronqué" : ""}`,
        ),
    ];
    if (options.expanded) {
        const derivation = firstText(result.content, 1);
        if (derivation)
            lines.push(theme.fg("toolOutput", bounded(derivation, 4_000)));
    }
    return textComponent(context, lines.join("\n"));
}

export function renderThinkArtifactSearchCall(
    value: unknown,
    theme: Theme,
    context: RenderContext,
): Component {
    const args = asArgs(value);
    const query = typeof args.query === "string" ? args.query : "…";
    return textComponent(
        context,
        theme.fg(
            "toolTitle",
            theme.bold(`🧠 Think Artifact Search · ${bounded(query, 240)}`),
        ),
    );
}

export function renderThinkArtifactSearchResult(
    result: RenderResult,
    options: RenderOptions,
    theme: Theme,
    context: RenderContext,
    retentionHours: number,
): Component {
    const failure = parseThinkArtifactSearchFailurePayload(result.content);
    if (failure) {
        const lines = [
            theme.fg("error", `✗ recherche d’artefacts · ${failure.code}`),
            theme.fg("muted", `récupération: ${failure.recovery}`),
        ];
        if (options.expanded) {
            lines.push(theme.fg("toolOutput", bounded(failure.reason, 2_000)));
        }
        return textComponent(context, lines.join("\n"));
    }
    const output = firstText(result.content) ?? "Aucun résultat lisible";
    const lines = [
        theme.fg(
            "success",
            `✓ recherche d’artefacts · expiration ≤${retentionHours}h`,
        ),
    ];
    if (options.expanded) {
        lines.push(theme.fg("toolOutput", bounded(output, 4_000)));
    } else {
        lines.push(
            theme.fg("muted", bounded(output.split("\n", 1)[0] ?? output, 240)),
        );
    }
    return textComponent(context, lines.join("\n"));
}
