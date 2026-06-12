import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageRecord } from "./types";

/**
 * Parse a single JSONL line into a UsageRecord.
 * Returns null if the line is not an assistant message with usage data or is malformed.
 */
export function parseJSONLLine(line: string): UsageRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Only assistant messages with usage data
  if (obj.type !== "message") return null;

  const msg = obj.message;
  if (typeof msg !== "object" || msg === null) return null;
  const message = msg as Record<string, unknown>;

  if (message.role !== "assistant") return null;
  if (!message.usage || typeof message.usage !== "object") return null;

  const usage = message.usage as Record<string, unknown>;
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";

  // Parse cost — may be a nested object { total: number } or a plain number
  let cost = 0;
  const rawCost = usage.cost;
  if (typeof rawCost === "number") {
    cost = rawCost;
  } else if (typeof rawCost === "object" && rawCost !== null) {
    const costObj = rawCost as Record<string, unknown>;
    if (typeof costObj.total === "number") {
      cost = costObj.total;
    }
  }

  const timestamp =
    typeof obj.timestamp === "string" ? new Date(obj.timestamp) : new Date();

  return {
    timestamp,
    provider,
    model,
    sourceKey: provider ? `${provider}/${model}` : model,
    input: typeof usage.input === "number" ? usage.input : 0,
    output: typeof usage.output === "number" ? usage.output : 0,
    cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
    totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
    cost,
  };
}

/**
 * Parse a single JSONL file and return all UsageRecords found.
 * Skips malformed lines without throwing.
 */
export function parseSessionFile(filePath: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return records;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const record = parseJSONLLine(line);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Walk all session JSONL files under ~/.pi/agent/sessions/ recursively.
 * Returns all assistant messages with usage data.
 * Handles nested session directories (sessions have both file and directory variants).
 * Skips the subagent-artifacts/ subdirectory.
 */
export function walkAllSessions(sessionsDir?: string): UsageRecord[] {
  const dir =
    sessionsDir ??
    path.join(process.env.HOME || "/home/abdwhb", ".pi", "agent", "sessions");

  const records: UsageRecord[] = [];

  function walk(currentPath: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip subagent-artifacts
      if (entry === "subagent-artifacts") continue;

      const fullPath = path.join(currentPath, entry);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith(".jsonl")) {
        const fileRecords = parseSessionFile(fullPath);
        records.push(...fileRecords);
      }
    }
  }

  walk(dir);
  return records;
}