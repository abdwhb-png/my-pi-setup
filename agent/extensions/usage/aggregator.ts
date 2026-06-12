import type { UsageRecord, ModelRates, ModelUsageAggregate, TimeWindowReport } from "./types";

/**
 * Supported time windows for usage reports.
 */
export const TIME_WINDOWS = [1, 7, 30, 90] as const;

/**
 * Check if a record falls within the last N days.
 */
export function isWithinWindow(record: UsageRecord, days: number, now: Date): boolean {
  return record.timestamp.getTime() >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

/**
 * Group records by sourceKey and sum their usage.
 * Returns a map of sourceKey → aggregated model usage.
 */
export function groupByModel(records: UsageRecord[]): Map<string, ModelUsageAggregate> {
  const map = new Map<string, ModelUsageAggregate>();

  for (const record of records) {
    const existing = map.get(record.sourceKey);
    if (existing) {
      existing.messageCount += 1;
      existing.input += record.input;
      existing.output += record.output;
      existing.cacheRead += record.cacheRead;
      existing.totalTokens += record.totalTokens;
      existing.cost += record.cost;
    } else {
      map.set(record.sourceKey, {
        sourceKey: record.sourceKey,
        provider: record.provider,
        model: record.model,
        messageCount: 1,
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        totalTokens: record.totalTokens,
        cost: record.cost,
      });
    }
  }

  return map;
}

/**
 * Filter records to those within the last N days and group by model.
 */
export function computeWindow(
  records: UsageRecord[],
  days: number,
  _pricing: Map<string, ModelRates>,
  now?: Date,
): TimeWindowReport {
  const cutoff = now ?? new Date();
  const windowRecords = records.filter((r) => isWithinWindow(r, days, cutoff));
  const grouped = groupByModel(windowRecords);

  const models = Array.from(grouped.values()).sort((a, b) => b.cost - a.cost);

  const totalMessages = models.reduce((sum, m) => sum + m.messageCount, 0);
  const totalInput = models.reduce((sum, m) => sum + m.input, 0);
  const totalOutput = models.reduce((sum, m) => sum + m.output, 0);
  const totalCacheRead = models.reduce((sum, m) => sum + m.cacheRead, 0);
  const totalTokens = models.reduce((sum, m) => sum + m.totalTokens, 0);
  const totalCost = Math.round(models.reduce((sum, m) => sum + m.cost, 0) * 100) / 100;

  const label = days === 1 ? `Last ${days} day` : `Last ${days} days`;

  return {
    label,
    days,
    models,
    totalMessages,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalTokens,
    totalCost,
  };
}

/**
 * Generate reports for all standard time windows.
 */
export function computeAllWindows(
  records: UsageRecord[],
  pricing: Map<string, ModelRates>,
  now?: Date,
): TimeWindowReport[] {
  return TIME_WINDOWS.map((days) => computeWindow(records, days, pricing, now));
}