/** A single assistant message with usage data from a session file */
export interface UsageRecord {
  timestamp: Date;
  provider: string;
  model: string;
  /** source key = provider + "/" + model for grouping */
  sourceKey: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number; // total cost in USD
}

/** Model pricing rates */
export interface ModelRates {
  modelKey: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  source: "models.dev" | "cached" | "unavailable";
}

/** Aggregated usage for one model in one time window */
export interface ModelUsageAggregate {
  sourceKey: string;
  provider: string;
  model: string;
  messageCount: number;
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
}

/** One time window's full report */
export interface TimeWindowReport {
  label: string; // "Last 1 day", "Last 7 days", etc.
  days: number;
  models: ModelUsageAggregate[];
  totalMessages: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalTokens: number;
  totalCost: number;
}

/** Complete usage report */
export interface UsageReport {
  windows: TimeWindowReport[];
  generatedAt: Date;
  pricingNotes: string[];
  pricing: Map<string, ModelRates>;
}