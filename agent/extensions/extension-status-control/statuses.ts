/**
 * Severity classifier shared between panel UI and grouping.
 *
 * Mirrors pi-fancy-footer's extension-statuses keyword buckets so the command
 * panel classifies statuses identically to how the footer colors them.
 */

export type ExtensionStatusSeverity = "error" | "warning" | "info";

const ERROR_KEYWORDS = [
  "error",
  "missing",
  "unconfigured",
  "locked",
  "off",
];

const WARNING_KEYWORDS = ["warning", "no-key", "setup"];

export function classifyStatus(status: string): ExtensionStatusSeverity {
  const lower = status.toLowerCase();
  if (ERROR_KEYWORDS.some((keyword) => lower.includes(keyword))) return "error";
  if (WARNING_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return "warning";
  }
  return "info";
}

export const SEVERITY_ICON: Record<ExtensionStatusSeverity, string> = {
  error: "●",
  warning: "!",
  info: "·",
};

export interface DecoratedStatus {
  id: string;
  status: string;
  severity: ExtensionStatusSeverity;
  icon: string;
  label: string;
}

/**
 * Build a decorated, ordered list ready for display. Order follows the snapshot
 * order already produced by pi-fancy-footer (positions/hidden ids resolved there
 * before publish).
 */
export function decorateStatuses(
  statuses: readonly { id: string; status: string }[],
): DecoratedStatus[] {
  return statuses.map((entry) => {
    const severity = classifyStatus(entry.status);
    const icon = SEVERITY_ICON[severity];
    const trimmedStatus = entry.status.trim();
    const label = `${icon} ${entry.id} — ${trimmedStatus}`;
    return { ...entry, status: trimmedStatus, severity, icon, label };
  });
}

/** Filter decorated statuses by a fuzzy query against id or status text. */
export function filterStatuses(
  statuses: readonly DecoratedStatus[],
  query: string,
): DecoratedStatus[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...statuses];
  return statuses.filter(
    (entry) =>
      entry.id.toLowerCase().includes(trimmed) ||
      entry.status.toLowerCase().includes(trimmed),
  );
}

/** Completion entries for the slash command argument autocomplete. */
export function toCompletions(
  statuses: readonly DecoratedStatus[],
  limit = 30,
): { value: string; label: string; description?: string }[] {
  return statuses.slice(0, limit).map((entry) => ({
    value: entry.id,
    label: entry.label,
    description: entry.status,
  }));
}
